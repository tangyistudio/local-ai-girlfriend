# Where the wait goes

A companion that takes 20 seconds to answer is not a companion. This is what we
measured, in the order the time is actually spent, and which of the fixes moved
the number.

> Figures here come from two measurement campaigns on the same machine: the
> engine-selection work that chose the current stack, and the profiling done
> for this repo. Where they disagree it is because the stack changed between
> them, and it is noted.

**The headline:** end to end, one sentence, nothing cached: **11.9 s**. Of that,
lip-sync is **1.75 s**. Speech synthesis is almost the whole wait, and that is
the opposite of where people optimise.

---

## The one that matters: pick the right lip-sync model

Before anything else, this is the decision that moves latency by an order of
magnitude. Same machine, same audio, same source clip:

| Engine | Time for the clip | Mouth clarity | Jitter |
|---|---|---|---|
| LatentSync 1.5 @256 + GFPGAN | 60 s (**5.08x realtime**) | 34% | 1.765 |
| wav2lip256, 4-stage pipeline | 4.5 s (**0.37x realtime**) | 58% | 1.725 |

**13.3x faster, with a clearer mouth and slightly less jitter.** There is no
axis in that table on which the diffusion model wins.

⚠️ The source notes this comparison came from say "23x", and we reprinted that
figure in four places before an audit caught it. 60 / 4.5 = 13.3, and
5.08 / 0.37 = 13.7. Nothing in the measurement yields 23. Where a headline
number and the table under it disagree, the table is the measurement.

The number that changes the design is **0.37x realtime**. Below 1.0, generation
outruns playback - which means you can render the next sentence while the current one
is still playing, and the character can talk continuously. Above 1.0 you cannot,
and no amount of pipelining saves you.

First sentence, measured after the switch: **2.90 s**, against 21.2 s before.

⚠️ Wav2Lip's open weights forbid commercial use. See `07-licenses.md` before
you build on this result.

## Then: split the reply into sentences

Do not wait for the language model to finish. Send the first complete sentence
to speech as soon as you have it.

Measured on the same content:

| | First sentence | Total |
|---|---|---|
| One unsplit sentence, 34 characters | **21.9 s** | 21.9 s |
| Split into 3 | **3.6 s** | **18.1 s** |

Splitting made the first sentence **6x faster and the total shorter too**. The
second part is the surprise - more calls means more fixed overhead, so you would
expect the total to get worse.

⚠️ **It does get worse in some configurations, and we measured that too.** On the
old diffusion engine, per-sentence streaming took the first sentence from 34 s
to 16.3 s but pushed the total from 34 s to **42.4 s**, because each sentence
paid the fixed cost again. Whether pipelining helps overall depends on how big
your per-call overhead is relative to the work. It always helps the *first*
sentence, which is the number the user feels.

### The splitting rule is a latency knob

Ours split on sentence-final punctuation, and only broke at a comma once a
clause reached 40 characters. Language models write long sentences, so a whole
reply often arrived as one unsplittable unit - which is exactly the 21.9 s row
above. Dropping that threshold from 40 to 18 is a one-line change with a 6x
effect on time-to-first-word.

## Then: stop re-encoding the reference voice

For a cloned voice, the reference audio has to be encoded before it can
condition the model. Doing that per request is the difference between usable
and not:

| | Per sentence |
|---|---|
| Passing the reference audio on every call | **11-16 s** |
| Encoding once at startup, passing the cached encoding | **2.7-3.4 s** |

**This finding overturned a rejected engine.** Qwen3-TTS had been written off as
too slow for real-time. It was not slow; it was being asked to re-encode 10.5
seconds of reference audio on every sentence.

If you have rejected a voice-cloning model on speed, check whether you were
measuring the model or measuring your own setup.

## What is left is irreducible

Once the above are done, here is where a single render's time goes. Measured on
the diffusion engine, on a 71-frame sentence taking 14.0 s:

| Stage | Time | Share |
|---|---|---|
| **Diffusion sampling** | **8.8 s** | **63%** |
| Affine transform | 1.5 s | 11% |
| Face restoration | 0.5 s | 4% |
| TTS + encode/IO | ~3.2 s | 22% |

Sampling is most of it and sampling is real computation. We cached the affine
transforms and saved 1.5 s per sentence - about 10% - which is worth having and
is not a solution.

**When the dominant stage is genuine computation, stop optimising and change
the architecture.** For lip-sync that meant changing the model (13.3x). For the
remaining wait, it means covering it - see below.

## Speech synthesis: cost tracks audio length, not characters

This is the single most useful thing to know about TTS latency, and it is not
what you would guess.

| Characters | Generation | Audio produced | RTF |
|---|---|---|---|
| 3 | 4,775 ms | 2.20 s | 2.17 |
| 7 | 4,456 ms | 2.36 s | 1.89 |
| 13 | 6,237 ms | 3.08 s | 2.03 |
| 27 | 12,868 ms | 5.88 s | 2.19 |

**3 characters costs the same as 7**, because 3 characters still produces 2.2
seconds of audio. Real-time factor stays near 2 across the whole range.

The practical consequence: **shortening your first sentence has a floor.** Going
from 13 characters to 7 saves about 1.7 s. Going below that saves nothing,
because the audio has a minimum length regardless.

Confirmed independently in this repo's profiling, with a different stack: a
sentence with 7.25x the characters took 5.2x the time, against a 4x difference
in audio produced. 5.2 sits between the two, closer to the audio ratio - which
is directional support, not a demonstration.

### RTF is a trap when you are choosing an engine

Two engines, same reference audio, same sentences:

| | Average RTF | 10-character sentence | Audio it produced |
|---|---|---|---|
| Qwen3-TTS | 1.89 | **2.74 s** | 1.36 s |
| IndexTTS2 (PyTorch FP32) | **1.11** | 3.62 s | 3.56 s |

IndexTTS2 wins on RTF and loses on the clock. RTF is generation time divided by
audio length, and IndexTTS2 spoke the same 10 characters over **3.56 seconds**
against Qwen3's 1.36. A bigger denominator makes the ratio look better while the
user waits longer.

**For conversational latency, measure wall-clock time for a short sentence.**
RTF is the wrong metric and it points at the wrong engine.

### Things that did not help

**flash-attn: no improvement, slightly worse.** Measured before and after
installing it:

| Characters | RTF before | RTF after |
|---|---|---|
| 3 | 2.17 | 2.17 |
| 7 | 1.89 | 1.90 |
| 13 | 2.03 | 2.38 |
| 27 | 2.19 | 2.20 |

Average **2.07 to 2.16**. The bottleneck is autoregressive per-token decoding
over a short sequence, which is not what flash attention accelerates.

## Cold start is a separate problem

First call after startup: **56 seconds**, because the models load on demand.

Warming endpoints exist for this, and ours had two flaws worth avoiding:

- It warmed the speech model but **not the lip-sync model**, so the expensive
  half stayed cold.
- It fired when the user opened the conversation screen, which is already too
  late.

Warm on sign-in, or on any signal that a conversation is *likely*, not on the
one that means it has started. And warm every model, not the one you thought of.

## The wait you cannot remove: cover it

After all of the above, a first reply still takes seconds. The remaining move is
not to make it faster, it is to make it not feel like waiting.

Pre-render a library of short reaction clips - listening, thinking, a nod, a
small "mm" - and switch to them at the first sign a reply is coming, while the
real reply renders. **The first keystroke, not the submit** - see
`05-assets.md`, where switching only at submit is the specific mistake that
nullifies the design. Cost is zero at request time; they are generated offline in advance.

This is what turns the wait into part of the interaction rather than a spinner,
and it works because the character has something to do that is plausible for
exactly as long as you need. The playback machinery for switching between those
clips and the real reply without a visible seam is its own problem, covered in
`06-playback.md`.

⚠️ The clip library has a latency constraint of its own: **a switch can only
happen at a clip boundary**, so a long idle clip can add its own remaining
duration to the wait. Keep the clips that play while the user is waiting short,
and allow the ones that play while nothing is pending to be longer.

---

## Summary, in the order to do them

1. **Choose a lip-sync model below 1.0x realtime.** 13.3x, and it is what makes
   continuous speech possible at all.
2. **Split the reply and pipeline per sentence.** 6x on first sentence.
3. **Cache the reference-voice encoding.** 11-16 s to 2.7-3.4 s per sentence.
4. **Tune the split threshold.** One line, 6x on time-to-first-word.
5. **Warm every model, early.** 56 s of cold start.
6. **Cover the rest with pre-rendered clips.** The remainder is real computation.

## Two things this page cannot currently tell you

### The breakdown does not add up, and we are not going to hide that

The headline says one sentence, nothing cached, takes 11.9 s, and that speech
synthesis is almost the whole wait. The tables below it say lip-sync is 1.75 s
and speech synthesis with the reference encoding cached is 2.7-3.4 s. That
leaves 6.8-7.5 s unaccounted for, which is more than either named component.

So one of three things is true: the 11.9 s figure was measured on a stack where
speech synthesis had not yet been fixed, the missing time belongs to the
language model and the headline attributes it to the wrong stage, or the
campaigns are not comparable. The source material does not say which, and this
page will not guess. Treat the component tables as the measurements and the
headline as unverified until someone re-runs it end to end on one stack.

Publishing a number is a promise. Where the arithmetic under a promise does not
close, saying so is the only honest option available.

### There is no measurement here for a hosted-API stack

A reasonable question is what this costs if the language model and the voice come
from hosted APIs instead of the local card. We do not have an answer, because we
did not measure one, and an estimate presented next to measured figures would be
indistinguishable from them within a week.

What can be said without measuring anything:

- **Lip-sync stays where it is.** It is the only stage that consumes the video
  itself, and at 0.37x realtime it already outruns playback. Moving it off the
  card buys nothing and adds a round trip per sentence.
- **The language model and speech synthesis are the replaceable stages.** They
  are also the two whose local cost this page reports as the largest, which is
  what makes the question worth asking.
- **An API adds a network round trip per sentence, and sentences are split.** The
  splitting that took the first sentence from 21.9 s to 3.6 s multiplies the
  number of calls. Per-call overhead is exactly what made streaming *worse* on
  the diffusion engine - total 34 s to 42.4 s - so a hosted stack has to be
  measured per sentence, not once.

If you want that number, the measurement is small: run the same content through
the same orchestrator with the two stages swapped for API calls, and report
first-sentence and total separately. Until someone does, this page has nothing
to offer on it, and a page with a gap is worth more than a page with a guess.

### ⚠️ This section has survived one attempt to resolve it. Read this before the next one.

Someone measured the running stack - five uncached mid-length sentences - got
speech synthesis at 7.64 s and lip-sync at 1.74 s, and rewrote this section to
announce that the arithmetic now closed, with the remaining 2.5 s attributed to
the language model. An audit took it apart the same night. Three things were
wrong and each one alone is fatal:

- **The residual was attributed to a stage the measurement does not contain.**
  `docs/00-hardware.md` defines the cold figure as "one sentence with nothing
  cached: **text in**, finished talking-head video out". Text in. The language
  model is outside it by definition, so there is nothing for a residual to be.
- **The residual was larger than the whole request it sat inside.** The same
  table records end-to-end with speech cached at 1.75 s, range 1.62-1.91. A
  language model costing 2.5 s inside a 1.91 s request is impossible.
- **The "reproduction" compared two different quantities.** The 1.74 s lip-sync
  reading was matched against that 1.75 s end-to-end-cached row and called a
  reproduction. The actual lip-sync rows are 0.82 s and 3.12 s. It was a
  coincidence between two unrelated numbers.

And the measurement itself never reached `bench/results.json`. It was taken in a
shell and typed into prose - in a repository whose entire claim is that every
number is in the committed evidence file and you are invited to check.

The numbers may well have been real. Mid-length sentences sit plausibly between
this file's short and long probes. But a real measurement, unlogged, reasoned
about incorrectly, and used to retire an honest "we do not know", is worse than
the open question it replaced.

**If you want to close this gap: run it through `bench/`, commit the rows, and
work out what the cold figure does and does not include before subtracting
anything from it.**
