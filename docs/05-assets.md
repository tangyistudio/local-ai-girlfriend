# The clips: an architecture, and how to tell if yours are broken

The character has to be on screen doing something plausible while a reply
renders. That means a library of short clips and a way to cut between them
without a visible seam.

The playback machinery is in `06-playback.md`. This is about the clips
themselves: the invariant that makes seamless cutting possible, and the
measurement tools that tell you when a clip violates it - because several of
ours did, silently, and the first three tools we built to catch it were
measuring the wrong thing.

---

## The invariant: every clip starts and ends on the same frame

Generate every clip with the same still image as both its first and last frame.
Call it the pivot frame.

```
                    ┌──────────┐
         ┌─────────►│  pivot   │◄─────────┐
         │          │  frame   │          │
    ┌────┴────┐     └────┬─────┘     ┌────┴────┐
    │ listen  │          │           │  nod    │
    └─────────┘     ┌────┴─────┐     └─────────┘
                    │  think   │
                    └──────────┘
```

Because every clip begins and ends in the same pose, **any clip can follow any
other clip**, and the cut between them is invisible without any crossfade. The
join is two identical frames.

This is worth more than it sounds. The alternative - crossfading between clips
that end in different poses - produces visible ghosting on faces, and you cannot
crossfade your way out of a hand being in a different place.

**Measured:** across one pool of 65 reaction clips, the largest deviation of any
first or last frame from the pivot was **4.6 out of 255** - about 1.8%, and
nothing in that pool was seriously off.

⚠️ That is one pool at one point in time, not a property of the architecture.
Other clips did violate the invariant - a talking-base clip measured 8.64
against a threshold of 9 and a human spotted it immediately (see "Calibrate
thresholds against eyes" below). The invariant holds because it is **checked**,
not because generators respect it. At that alignment a hard cut is genuinely invisible, and a 120 ms crossfade
is strictly worse: it superimposes a mouth and eyes from two different moments.

### The cost of the invariant

**You can only cut at clip boundaries.** If the user submits while a 10-second
idle clip is playing, they wait out the remainder before the character can
react.

So clip length is not one number. It is tiered by whether anything is waiting:

| Clip type | Playing when | Length |
|---|---|---|
| Idle | nothing is pending | can be long |
| Listening / thinking | the user is waiting for a reply | **must be short** |

Get this wrong and the tiering does nothing: if you only switch to the short
clips *after* the reply starts rendering, the user has already been waiting
through a long idle clip. Switch to the short pool the moment there is any sign
a reply is coming - the first keystroke, not the submit.

## Composition decides how much GPU you need

This is the finding that connects the asset work to the hardware budget, and we
did not expect it.

A widely-shared low-VRAM build runs lip-sync at 256x256. Its author says the
blur "basically isn't noticeable". That is true - **for their composition.** The
character occupies one side of the frame, is lit from the side, and the scene is
dark.

Ours was front-facing, brightly lit, and a close-up: every condition that makes
lip-sync artifacts maximally visible.

**Same model class, same resolution, different verdict.** One of us could ship
that lip-sync quality and one of us could not.

⚠️ Not the same VRAM figure either: their published number is 1.3 GB and our
deployed process measured 2.4 GB, and `00-hardware.md` argues at length that
those are not the same quantity. The point here is about the shot, not the
budget.

So "how big a card do I need" is partly an art-direction question. Before you
buy hardware to fix a quality problem, check whether the shot is doing you any
favours. Side lighting and a dark scene are free; VRAM is not.

## Measuring your clips

Four tools, each catching something the others cannot. Run all of them; they
disagree in useful ways.

### 1. Does the clip return to the pivot frame?

Compare first and last frame **against the pivot image**, not against each
other.

⚠️ This distinction matters and is easy to get wrong. A clip whose first and
last frames match *each other* but which sits away from the pivot overall will
pass a self-comparison and still jump when cut against every other clip. Compare
to the pivot.

### 2. Will the seam be visible? Divide by how much the clip moves

This is the most transferable idea here, and it is counter-intuitive.

Raw seam error is not predictive. Measured across two batches of clips:

| | First-to-last error | Adjacent-frame motion | Ratio | Visible? |
|---|---|---|---|---|
| Batch A | 2.5 - 2.7 | 0.33 - 0.53 | **4.9 - 7.7** | jumps |
| Batch B | 2.4 - 2.6 | 2.4 - 4.6 | **0.55 - 1.2** | seamless |

**The seam error is the same in both.** Around 2.5, which is encoding noise
rather than pose error. What differs is the denominator: batch A barely moves,
so the same error is 5-7x larger than its normal frame-to-frame variation and
the eye picks it out. Batch B is lively enough that the seam is within the
noise.

```
visibility ≈ seam error ÷ median adjacent-frame difference
```

A very still clip needs a much tighter loop than an active one. Trimming does
not help - we tried, and the tool reported the existing last frame was already
optimal.

### 3. Is the clip actually still?

Do not assume from the filename. We had a set of clips named as idle and used as
the "resting" layer, and measured the character's own displacement:

| | Displacement |
|---|---|
| One old clip | **6.34** |
| Regenerated "idle" clips | **20 - 39** |

The regenerated set moved **3-6x more**. They had been regenerated to fix a
complaint that the character was too static, and the fix overshot: every clip
became "large motion, snap back to origin", because the pivot invariant
guarantees the return. There was no clip in the pool that could serve as rest.

The symptom reported was "it keeps moving, there's no pause" and three separate
attempts to fix it by changing the *playback* rules all failed, because the
problem was in the assets. Measure displacement; do not infer it from a name.

### 4. Is the mouth open when it should not be?

Clips are supposed to have the mouth closed throughout - lip-sync is applied
afterwards. Generators do not always comply, and the result is a character who
appears to be talking with no sound.

**We built four detectors for this. The first three were wrong.**

| | Detector | Why it failed |
|---|---|---|
| 1 | Frame-to-frame pixel difference in a mouth box | Cannot distinguish an opening mouth from a turning head. A clip with an obvious open "o" mouth ranked **19th**. |
| 2 | Darkest 3% of pixels in a mouth box | Found hair drifting into the box. A closed-mouth clip measured **darker** than its open-mouthed version. |
| 3 | Inner lip separation ÷ face height | Counts a **toothy smile** as an open mouth. Two clips a human easily distinguished measured 0.1535 and 0.0906. |
| **4** | **MediaPipe `jawOpen` blendshape** | ✅ Works, because the same model exposes `mouthSmile` separately - **smiling and jaw-opening are two dimensions, not one.** |

Calibrated by regression against clips a human had already judged, the two
groups separated cleanly:

```
judged OPEN                    judged CLOSED
0.615                          0.259  (with smile 0.932)
0.477                          0.230
0.437                          0.154
0.375                          0.003
```

A clean gap between **0.259 and 0.375**, so the threshold is **0.32**, with
0.24-0.32 flagged for human review.

**The row that explains why the first three failed** is that 0.259 with a
mouthSmile of 0.932: a broad grin with the jaw almost closed. Every
pixel-and-geometry detector called it an open mouth.

⚠️ These numbers are a regression against one character and one framing. **Change
either and recalibrate.**

⚠️ Validated by scanning a pool and comparing against a human pass: identical
result, same clips flagged, with a clean gap between the last failing clip
(0.379) and the first passing one (0.223).

## Calibrate thresholds against eyes, not round numbers

A clip passed a deviation threshold of 9 with a measured 8.64, and a human
spotted the problem immediately. The threshold was not derived from anything -
it was a convenient integer.

The clip was regenerated to 4.45 and the complaint went away. **A threshold that
was never validated against a human judgement is a number you made up.** Set it
where the two groups actually separate, the way the jawOpen threshold above was
set.

## Generating clips: two traps

**Words that imply an open mouth will open the mouth**, even when you have
explicitly asked for a closed one. `brightly`, `beaming`, `grin`, `laugh`,
`surprise` all carry it. Cleanest isolation we have:

```
"points at you brightly"                          → 0.525
same + closed-mouth instruction appended          → 0.546   (no better)
"brightly" removed + instruction moved to front   → 0.001
```

Removing the word worked; adding an instruction after it did not. Position
matters too: the same instruction before the action clause gave 0.202, after it
gave 0.507.

⚠️ Do not name the jaw directly. "Her jaw stays closed" made it **worse** -
0.477 to 0.642.

**But the seed varies more than the prompt does, and we overstated this at
first.** Two clips with near-identical prompts scored 0.202 and 0.484. The
failing one was then fixed with **the same prompt and a different seed** -
0.484 to 0.184.

So: prompts raise the success rate and do not guarantee a result. For a
difficult clip, **run several seeds and select with the metric** rather than
continuing to reword. We initially wrote that prompting determined the outcome;
the seed experiment disproved it.

---

## The order to run these

```
1. pivot alignment      → is the clip usable in the library at all
2. seam ÷ motion        → will the cut be visible for this clip
3. displacement         → is this a rest clip or a motion clip
4. jawOpen              → is the mouth closed as required
```

Anything failing 1 is unusable. Anything failing 4 will look like the character
is talking to themselves. 2 and 3 determine which layer of the playback rotation
the clip belongs to, which is `06-playback.md`.


## Rendering the library, and the three ways it was wrong first

Everything above is about *choosing* clips. This section is about *making* them,
and it is the part that took four rounds to get right. Each round produced a
library that passed the checks then in use, and each one had a defect a viewer
could see immediately.

### Round 1: two pivot families in one library

The reaction clips were selected by name. Some of them carried a prefix that
marked a second, calmer tier of the same character - a tier with its own pivot
frame. Measured against each other those clips agreed to 2.7, which is why they
looked internally consistent; measured against the rest of the library they sat
21 out of 255 away.

A per-clip loop check cannot find this. Every one of those clips began and ended
on its own pivot perfectly. The check has to compare every clip to one shared
reference, and the reference has to come from the library.

### Round 2: the poster was not the pivot

The obvious shared reference is the poster still that the player shows before
the first clip paints. It was wrong. Measured against the clips it is supposed
to represent, one look's poster sat 4.6 away from every single clip in that
look, while the clips sat within 2.9 of each other. A separate render is a
separate render, however much it looks like the same frame.

### Round 3: the whole-frame mean hid the mouth

With a correct reference, the talking clips measured 3.19 out of 255 at their
first frame and were declared aligned. They were not. A mouth is roughly one
percent of a 432x774 frame, so a completely different jaw moves the whole-frame
mean by almost nothing: 2.75 to 3.19. The worst 12x12 block moved 13.4.

The user saw it in the first second. The number never would have. Report the
worst block, judge on the worst block, and do not assume where the face is -
whatever region actually changed is the region worth reporting.

### Round 4: what actually works

Three things together, and removing any one of them brings the defect back.

**Pad the audio to the base clip's length.** The engine renders
`ceil(audio_seconds * fps)` frames of the base starting at frame 0. The bases
begin and end on the pivot, so the render returns to the pivot only when it runs
the base to its end. Here the bases are 124 frames and the audio is padded to
match.

This also retires a constraint the source project had documented as permanent.
Its guidance was that lip-sync source clips must be *low motion*, because an
audio-length render stops on an arbitrary frame and a high-motion source is far
from the pivot when it does - measured at 17.37 for one hair-touching clip
against a threshold of 9, which produced 22 filler clips where the character's
hand never came back down. Padding removes the arbitrary stop, and with it the
reason to avoid motion. That is the whole point of measuring the head: 0.99x on
one engine, 2.30x on the other.

**Put 0.24 s of silence in front.** Otherwise frame 0 carries the mouth shape of
the first phoneme. Measured at 5.9 in the mouth region on every talking clip.

**Render the idle clips through the same engine, driven by silence.** The engine
regenerates the mouth on every frame, silence included. The generated neutral
mouth is consistent across renders - two clips of the same look agree to 1.93 -
but sits 6.22 from the original mouth in untouched footage. A library mixing
rendered talking clips with raw reaction clips has two mouths in it, and the jaw
steps at every join between the families.

### What is left, honestly

First frames across the finished library agree to a worst block of 0.00-7.3.
Last frames do not: 8.7-22.5. The bases are not the cause - against each other
they agree to 4.1-5.5 at the first frame and 5.0-7.2 at the last. The generator
adds the drift, at the end of the sequence, where it has the least future
context.

How much it adds is bought with mouth movement:

| exp amplitude | seam, worst block | note |
|---|---|---|
| 0.45 | 7.7 | rejected as too little mouth movement |
| 0.60 | 10.2 | |
| 0.90 | 14.3 | |
| 1.20 | 17.5 | shipped |

Two fixes were measured and rejected. The engine's own expression fade made it
worse, 29.7 to 54.1, because it fades toward a neutral face rather than toward
the base's face. Ending each clip on whichever of its last 25 frames sits
closest to the reference recovered almost nothing, 22.2 to 19.9 - which is how
you know the whole tail drifted rather than one frame being bad.

So this library is played with a 120 ms dissolve rather than a hard cut. State
the purchase plainly: the amplitude buys mouth movement and costs seam, and the
dissolve covers the seam.


### Round 5: the mouth that moved without a sound

A rotation clip carries no audio. If the mouth moves in one, the character is
mouthing words at the viewer in silence, and it is the most uncanny thing this
player can do. A user saw it within seconds of loading the page. Every check in
this repository had passed the same library.

They passed because they all compare a clip's first and last frames, and this
clip opened its mouth in the MIDDLE and closed it again by the end. Nothing was
looking at what happened in between.

Measured with `jawOpen`, a face blendshape, the nine rotation clips read 0.140
to 0.428 - one of them open through 90% of its length. Two independent causes,
and fixing either alone leaves the defect:

  - **Sources picked by name.** A clip called `listening` measured 0.52 - a
    wide-open reaction. A purpose-built base documented as "mouth closed
    throughout" measured 0.14 and visibly parts her lips mid-clip. A name
    describes intent; it does not measure content.
  - **Amplitude inherited from the talking clips.** The engine emits mouth
    motion for silence too, and the expression amplitude multiplies it. The same
    base rendered silent measured 0.30 at amplitude 0.45 and 0.43 at 1.20. A
    rotation clip has no speech in it, so it has no reason to share the number
    that was chosen to make speech legible.

Re-picking every source by measurement and rendering the rotation at 0.30
instead of 1.20 brings the same nine clips to **0.002 to 0.137**.

The tool is in the repository: `player/examples/check-mouth.py`.

⚠️ Calibrate its threshold against your own character at rest. Two faces here
read 0.002 and 0.14 doing nothing at all, because one of them has slightly
parted lips by default. An absolute threshold copied from someone else's face
will either pass everything or fail everything.

### And the fix that was not a rendering fix at all

The demo used to play a filler clip - "let me think" - before every answer,
because that is what the production system does: it has an 11.9 s render to
cover, and a character saying something plausible beats a spinner.

Nothing is rendered in a demo of pre-rendered clips, so the filler covered
nothing. It made every answer arrive about four seconds late and it read as the
system being slow. Removing it exposed a second delay hiding behind it: the
player only consults its speak queue at the next handover, so a question asked
one second into a five-second idle clip waited out the remaining four.

Both are now gone - `speakNow()` cuts to the answer where the rotation clip
stands - and the answer starts in the same second as the click.

The general rule, which is worth more than the fix: **a filler is worth exactly
as much as the wait it hides.** It is a good answer to 11.9 s on one consumer
card. It is a cost with no benefit anywhere the wait is not there.


### And one thing that could not be fixed, tested three ways

One look's clips end 20-22 from their own first frame. The other two end at
12.6. All three are rendered by the same engine, at the same amplitude, with
the same padding.

The obvious suspect was the source material, so the same sentence was rendered
over three different sources for that look - a purpose-built base and two
reaction clips, whose own loop error measured 4.5-5.0 before rendering. The
results were 21.9, 20.0 and 23.5. The drift does not follow the source.

It follows the face. That is worth stating plainly rather than leaving as an
open question, because the useful conclusion is not "we failed to fix it" but
"do not spend another day picking source clips for this". A 120 ms dissolve
covers it. If your own library has one look that will not sit still while the
others do, measure across sources once and then stop.
