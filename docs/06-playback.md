# Playing the clips without a visible seam

You have a library of clips that all start and end on the same frame
(`05-assets.md`) and a stream of rendered speech clips arriving one sentence at
a time (`04-latency.md`). This is the part that plays them so the character
never appears to glitch.

It is harder than it looks, and the difficulty is concentrated in one place:
**every visual defect happens at a handover.** Reduce handovers and you reduce
every class of problem at once.

---

## Double buffering, and why one element is not enough

Two video elements stacked on each other. One is in front and playing; the other
is preloading the next clip. When the front one ends, the back one takes over
and they swap roles.

A single element changing its `src` shows a blank frame while the new source
loads. There is no way around that with one element.

## The rule that governs everything

**Never hide a frame you have, for a frame you do not.**

Almost every "flash of black" reduces to hiding the outgoing element before the
incoming one has actually painted. Both layers are then transparent and the
viewer sees the page background.

**The old frame is a perfectly good thing to be showing.** It is the pivot
frame - the character sitting still. Holding it 200 ms longer than necessary is
invisible. Showing black for 16 ms is not.

So the hide condition must be **"the new element has presented a frame"**, never
a timer.

## Five causes of a black flash, honestly graded

We fixed these one at a time over several days. They are independent - fixing
four still left a visible flash.

| | Cause | Evidence |
|---|---|---|
| 1 | **`moov` atom at the end of the file.** The browser must download the whole clip before it can paint frame one. | Measured: 1.29 MB clip took 1.17 s, a 1.42 MB one took **1.71 s**, against a 1,200 ms safety timeout. Fix at the encoder with faststart; raise the timeout to 3,000 ms as a second line. |
| 2 | **Preload overwrote the element being handed to.** The preloader computed "the back element" from state that had not committed yet, and replaced the source of the element about to become front. | Symptom reproduced; no numeric measurement. Fix: track the handover target explicitly and never preload into it. |
| 3 | **`loadeddata` does not mean painted.** It means the data for the current position is decoded, not that a frame reached the compositor. | ⚠️ **Never verified, by us or anyone.** Our tooling did not composite, so the API that reports frame presentation never fired and the numbers we got were worthless. The fix was reasoned, shipped, and left needing on-device confirmation that we have no record of ever happening. Fix applied: `requestVideoFrameCallback`. |
| 4 | **The hard-cut path did not set z-index.** With crossfade at 0, setting the new element opaque did not cover the old one if it was underneath; then the old one went transparent and for one frame neither was visible. | Deterministic, readable from the code. Appeared only after crossfade duration was set to 0 for other reasons. |
| 5 | **Hiding the old element on a timer.** If the "wait for a frame" safety timeout fired first, the fade started with nothing to fade to. | Fix: gate the fade on frame presentation. ⚠️ **This one was partly reverted** - see below. |

### Cause 5 was over-corrected, and that is worth knowing

The fix for 5 was to make the crossfade itself wait for a presented frame. But
the callers already waited. The two waits stacked: 400 ms + 400 ms + 140 ms, and
we measured **997 ms with both layers simultaneously visible**. Users reported
"the clips are overlapping", which is the opposite complaint from the one we
started with.

**Final shape: the caller gates on frame presentation, the fade itself is a
plain timer.** One gate, not two.

If you take one thing from this table, take that: *"wait for the frame" is
correct, and applying it in two places is a different bug.*

## Hard cut or crossfade: it depends on the clip, and it is measurable

Two answers, both correct, in the same player.

**Clips from the library: hard cut, no fade.** Their first and last frames are
within 4.6/255 of the pivot, so the join is two near-identical frames. A 120 ms
fade at 24 fps superimposes three frames in which the old clip is mid-motion
(hand lowering, eyes possibly blinking) and the new one is at rest. That reads
as ghosting, and as the previous action being cut off. 3 separate user
reports, all fixed by removing the fade.

**Speech clips: 200 ms fade, required.** A lip-sync clip's length is set by its
audio, so it ends on an arbitrary frame of its source. Measured drift of a
source clip's middle from the pivot: up to **16.75** - only the first 9 and last
6 frames were within 5. Hard-cutting from a frame that far off to the pivot is
exactly the "it cuts before the motion finishes" complaint.

The rule: **hard cut when both sides are aligned by construction, fade when one
side can be anywhere.**

### Crossfade the right way, or it looks worse than not fading

The intuitive implementation fades the old one out while fading the new one in.
Over a dark background, at the midpoint both are semi-transparent and the
composite is `0.5×new + 0.5×(0.5×old)` - the picture **dims**. Two identical
frames produce a visible dip.

Correct: **the outgoing element stays fully opaque; the incoming one fades in on
top of it.** The composite is `α×new + (1−α)×old`, a true cross-dissolve. Two
identical frames stay identical throughout. Hide the old one only after the fade
completes.

## Handovers are the unit of risk: have fewer

Every defect above occurs at a handover. So the highest-leverage change is not
fixing handovers, it is not having them.

**Replaying the same clip in place is a zero-cost handover.** If the next clip
is the one already playing, set `currentTime = 0` on the same element. No source
change, no waiting for a frame, no crossfade - the entire pipeline is skipped,
and with it every failure mode in the table above. This works only because the
pivot invariant makes the loop point seamless.

Building an idle rotation around that took the handovers in a ~30 second cycle
from about 5 down to 2, which cut the exposure to all of these problems by
roughly the same factor.

⚠️ **Replay in place only works with a genuinely still clip.** We tried it with
motion clips first and the character repeated the same gesture several times in
a row - obviously worse than the switching we were trying to avoid. This
depends on the displacement measurement in `05-assets.md`.

## Two more that will cost you a day each

**`requestAnimationFrame` does not fire when the page is not compositing.** A
background tab, an obscured window, a phone with the app switched away. If you
start a transition from rAF, the new element stays at opacity 0 and the old at
1 forever, and the user returns to a frozen picture while the background element
is happily playing. Observed: front element stuck at 3.88 s and paused, back
element's `currentTime` still advancing. Force a synchronous reflow instead.

**Check which element fired the event.** With an `ended` handler on both video
elements, the background element firing `ended` triggers a handover while the
front element is mid-clip, cutting its animation off. This one was latent for
weeks and became constant the day we made the outgoing element linger 400-540 ms
longer - **a fix for one bug turned a rare race into the common case.** Verify
the event's source against what should actually be playing, by content rather
than by a state variable that may not have committed yet.

## The backstop

After fixing the causes above and still receiving reports, we stopped hunting
for another one and made the failure impossible instead: **a still image of the
pivot frame, layered behind both video elements.**

If both layers are ever blank, what shows through is the character sitting
still - which is indistinguishable from a normal frame, because it is one.

⚠️ **This is insurance, not a fix.** If you still see a flash, there is still a
transition to find. But it converts a visible defect into an invisible one while
you look.

⚠️ One detail: **do not attach it until the first video frame has painted.** Our
opening clip fades in from black, and a poster present from the start makes the
sequence read as "character sitting there → cut to black → fade in", which is
worse than the flash it was added to prevent.

---

## The implementation

This describes the approach; `player/` implements it. Framework-agnostic, zero
dependencies, React wrapper optional. `player/examples/demo.html` runs it
against a generated clip library that ships with it.

⚠️ Two defects in this list were found by **running that demo**, not by reading
the code - and both were present in the shipped component this was extracted
from. A clip that failed to load while a handover to it was in flight froze the
player permanently, and the recovery then chose the same broken clip again
because the unloadable-clip filter was applied to the rotation pool and not to
the queue. The unit tests passed throughout.

The parts to get right, in order of how much they cost to discover:

1. Hide the outgoing frame only when the incoming one has painted. One gate.
2. Hard cut aligned clips; fade only when one side can end anywhere.
3. Fade by holding the old one opaque, not by fading both.
4. Skip the whole handover when the next clip is the current clip.
5. Verify the event source before acting on `ended`.
6. Put a still frame behind everything as a backstop.


## The black flash, and why reading the code did not find it

The player was reported as flashing black between clips. The clips were not the
cause - scanned frame by frame, the darkest frame in every file sat above 97% of
that file's mean, and the largest frame-to-frame dip was 0.8 out of 255. Nothing
dark was ever encoded.

It was found by sampling the composited page every animation frame: for each
frame, which element is on top, is it opaque, and does it have anything to draw.
Two defects came out of one 45-second sample.

**3 frames where the top element had readyState 0 or 1.** A video element with
no decoded frame is transparent, not black, so the player showed its own
background colour. That is the flash.

**46 frames - 770 ms - showing a frozen first frame** while the outgoing clip's
audio was still running underneath. Sound without a matching mouth, for over
half a second, at the start of every answer.

Both had the same root cause, and the file that contained it documents the rule
it was breaking. `requestVideoFrameCallback` fires only for an element that is
being composited. The handover called it on the element it was about to promote
- an element that was paused, at opacity 0, and therefore not composited. It
could never fire. Every handover fell through to its 400 ms safety timeout and
promoted the element whether or not it had a picture.

Moving `play()` before the wait helped and did not fix it: an element at opacity
0 still is not composited, so the callback still did not fire and 18 frames of
frozen picture remained.

The fix is to stop waiting and reverse the order:

    hard cut:  promote the incoming element to the top, leaving the outgoing
               one fully opaque underneath it -> play() -> once a frame has
               actually been presented, hide the outgoing one

    dissolve:  play() and start the dissolve in the same tick; the dissolve
               already holds the outgoing element opaque for its whole duration

Both follow from the rule at the top of `handover.js`, which had been written
down and then not applied: never hide a frame you have for a frame you do not.
Promoting an element that cannot paint yet is free, because it is transparent
and what shows through is the previous clip's pivot frame.

⚠️ The lesson is not "check readyState". It is that a wait which can silently
never fire is worse than no wait at all, because it looks like a safeguard in
review and behaves like a fixed delay in production. This one had been read
several times by someone who had just written the comment explaining it.
