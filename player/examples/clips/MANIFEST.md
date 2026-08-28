# Demo clips

Eighteen clips of an AI-generated character, three looks, at 432px wide.

  9  rotation clips   silent, the idle loop the player returns to
  9  answer clips     three canned questions x three looks

Looks are named for what she is wearing - `knit`, `shirt`, `pj` - and the
filename prefix is also the group key the checkers use.

⚠️ **The answers are pre-rendered.** They were produced in advance by the
pipeline this repository documents and saved as files. Clicking a question
plays a video that already existed - so the demo shows what the output looks
like and how playback behaves, and shows nothing at all about speed. The real
figure for generating one sentence on the card benchmarked here is 11.9 s.

## There are no filler clips here, and that is the point

An earlier version had six: "let me think", played before every answer. That is
what the production system does, because it has an 11.9 s render to cover and a
character saying something plausible beats a spinner.

Nothing is rendered here, so the filler covered nothing. It just made every
answer arrive about four seconds late, and it read as the system being slow
rather than as the system being polite. A filler is worth exactly as much as
the wait it hides; put the model behind a fast enough backend and it stops
paying for itself.

Removing it exposed a second cost that had been hiding behind it: the player
only consults its speak queue at the next handover, so a question asked one
second into a five-second idle clip waited out the remaining four. `speakNow()`
cuts to the answer instead. Between them, the answer now starts in the same
second as the click.

## How the clips were made, and why each step is there

**Padded to the base clip's length.** The engine renders
`ceil(audio_seconds * fps)` frames of the base starting at frame 0. The bases
begin and end on the pivot frame, so the render lands back on the pivot only if
it runs the base to its end. Pad the audio and it does; leave it unpadded and
the clip stops on whatever frame the speech ran out on.

**Leading silence, 0.24 s of it.** Otherwise frame 0 already carries the mouth
shape of the first phoneme. Measured: 5.9 out of 255 in the mouth region on
every talking clip, while the whole-frame mean read 3.19 and looked fine.

**Rotation clips rendered through the same engine, driven by silence.** The
engine regenerates the mouth region on every frame, silence included. That
generated neutral mouth is consistent across renders - two clips of one look
agree to 1.93 - but sits 6.22 from the original mouth in untouched footage. A
library mixing rendered talking clips with raw reaction clips has two different
mouths in it and steps the jaw at every join between the families.

**Rotation clips rendered at their OWN amplitude, 0.30 rather than 1.20.** See
below. This one was not obvious and it shipped a visible defect.

## The mouth that moved without a sound

A user reported one of the rotation clips sitting there with its mouth open.
Every check in this repository had passed the library, because they all compare
first and last frames and this clip opened its mouth in the *middle*.

Measured with `check-mouth.py`, the nine rotation clips read jawOpen 0.140 to
0.428 - one of them open through 90% of its length. Two independent causes:

  - **Sources picked by name.** A clip called `listening` measured 0.52. A base
    documented as "mouth closed throughout" measured 0.14 and visibly parts her
    lips mid-clip. Names describe intent, not content.
  - **Amplitude inherited from the talking clips.** The engine emits mouth
    motion for silence too, and amplitude multiplies it: the same base rendered
    silent measured 0.30 at amplitude 0.45 and 0.43 at 1.20. A rotation clip
    has no speech, so it has no reason to share the talking amplitude.

After re-picking every source by measurement and rendering the rotation at 0.30,
the same nine clips read **0.002 to 0.137**.

    python player/examples/check-mouth.py 'player/examples/clips/*_still.mp4' \
        --model face_landmarker.task

## What is still imperfect, and by how much

First frames across a look agree to a worst 12x12 block of 0.00-6.6 out of 255.
Last frames are worse: 7.4-8.1 for the rotation clips, and up to 22.5 for one
look's answers. The bases are not the cause - measured against each other they
agree to 4.1-5.5 at the first frame and 5.0-7.2 at the last. The generator adds
the drift at the end of a sequence, where it has the least future context.

How much it adds is bought with mouth movement:

| amplitude | seam (worst block) | note |
|---|---|---|
| 0.45 | 7.7 | mouth movement rejected as too small |
| 0.60 | 10.2 | |
| 0.90 | 14.3 | |
| 1.20 | 17.5 | the amplitude shipped for talking clips |

Two fixes were measured and rejected. The engine's own expression fade made it
worse - 29.7 to 54.1 - because it fades toward a neutral face rather than
toward the base's face. Ending each clip on whichever of its last 25 frames
sits closest to the reference recovered almost nothing, 22.2 to 19.9, which is
what tells you the whole tail has drifted rather than one frame being bad.

So the player dissolves for 120 ms rather than hard-cutting. That is a purchase:
the amplitude buys mouth movement and costs seam, and 120 ms covers the seam.

One look is worse than the other two and it is not the source material. Its
clips end 20-22 from their own first frame while the others end at 12.6, so the
same sentence was rendered over three different sources for that look - a
purpose-built base and two reaction clips, whose own loop error measured 4.5-5.0
before rendering. The results were 21.9, 20.0 and 23.5. The drift follows the
face, not the source. Measure across sources once and then stop looking.

## Checking them

    bash player/examples/check-clips.sh          # pivot alignment
    python player/examples/check-mouth.py ...    # silent clips stay silent

⚠️ Read the block column, not just the mean. A mouth is about one percent of a
432x774 frame, so a completely different jaw moved the whole-frame mean from
2.75 to 3.19 - inside every threshold - while the worst block moved 13.4.

⚠️ `check-clips.sh` groups by filename prefix and uses one reference per look. A
library with three outfits has three pivot frames and they are not supposed to
match: measured 50.6 mean and 202 worst-block between two of them, which is
simply what two different people look like.

## Provenance

`session` - generated for this repository by the pipeline it documents.

⚠️ **These clips are not MIT and are not yours to reuse.** The character
Xiaoxian / 小嫻 and all footage and stills of her are Copyright (c) 2026 Tangyi
Studio, all rights reserved. She is a generated likeness derived from a real
person, who owns it and consented to its publication here. The footage is
published so the claims about seams, mouth movement and playback can be checked
against real output - not as a free asset pack. Redistribution, training, and
use of the character in your own work are all outside the grant.

⚠️ An earlier version of this file said "no real person's likeness is
involved". That was wrong, and it is left recorded here rather than quietly
deleted, because a licence claim that is wrong in the permissive direction is
the most expensive kind of error a repository can ship.

Separately, and still true: **no likeness tooling ships in this repository and
none is documented in it.** Nothing here helps anyone put a face onto a body
they do not own. That line is deliberate and it is a policy, not a measurement.

The name is defined once, in `clips.js`, and belongs to this repository's demo
rather than to any product. It is a name and nothing else: no backstory, no
personality specification, no dialogue rules. The three canned exchanges are
the entire script, and they exist to demonstrate playback.
