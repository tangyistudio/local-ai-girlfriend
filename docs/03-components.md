# Choosing the models

Three slots - language, speech, lip-sync - and a lot of candidates. This is less
a recommendation than a method, because the specific models will have moved by
the time you read it and the way you evaluate them will not.

The numbers behind the recommendations are in `00-hardware.md` (VRAM) and
`04-latency.md` (speed). The licence position for each is in `07-licenses.md`,
and it is not a footnote - it eliminates the most popular lip-sync model for
anything commercial.

---

## The metric that catches the failure everyone else misses

Start here, because without it the rest of your evaluation can be confidently
wrong.

Lip-sync quality is usually measured with sharpness and temporal jitter. Both
are easy to compute, both look scientific, and **both are optimised by a
pipeline that has silently stopped doing lip-sync at all.** A video of a person
sitting still with their mouth closed is perfectly sharp and has no jitter.

The source project records **3 occasions** of trusting a metric without looking
at the output; one of them is exactly this failure, and the other two are a
scaling misalignment and a frame-count mismatch. Different bugs, same root.

**The check: compare mouth-region motion against the source clip.** The source
is a person with their mouth closed throughout. If your output's mouth motion is
not clearly above the source's, the lip-sync did not happen - regardless of how
good the other numbers look.

```
motion(output) / motion(source)  <= 1.0   →  lip-sync is not working
```

Every quality metric you add should be paired with a metric that goes **down**
when the feature stops working. Sharpness and jitter both go up.

## Comparisons that mean something

Four rules, each of which we learned by getting a wrong answer first:

**Same audio, same frame range.** Numbers computed over different frame counts
are not comparable, and the difference is easy to miss because both runs
succeed. This cost two separate false conclusions.

**Pair every quality number with a look at the output.** We produced results
where the metrics improved and the product got worse - a jaw-contour metric
improved by 11-19% and a cheek metric by 26% while a human said the mouth
"looks wrong", because those metrics measured *amount* of change and the
complaint was about *shape*.

**But do not use eyes as the filter.** Visual review of 39 thumbnails missed 2
clips and misjudged 1. The right division of labour is **metric filters, eyes
adjudicate**: the metric selects the handful worth looking at, and a human
decides on those.

**Check what the tool is measuring, on known answers, before trusting it.** More
on this in `05-assets.md`, where a measurement tool went through four versions
because the first three were confidently measuring the wrong thing.

## Lip-sync

The decision that matters is **realtime factor**, not visual quality.

| | Realtime factor | Consequence |
|---|---|---|
| Below 1.0 | generation outruns playback | the character can speak continuously; you can render the next sentence during the current one |
| Above 1.0 | playback outruns generation | no amount of pipelining helps; every sentence is a wait |

We measured a diffusion model at **5.08x realtime** and a wav2lip-class pipeline
at **0.37x** - a 13.3x difference that also happened to have a *clearer* mouth
(58% vs 34%) and slightly lower jitter. The intuition that the slower, more
modern model must look better did not survive measurement.

**Candidates, with the licence position that usually decides it:**

| | Speed | Licence position |
|---|---|---|
| wav2lip-class | fastest measured, ~2.4 GB deployed | **weights forbid commercial use** |
| Ditto | not benchmarked here | Apache-2.0, weights included |
| MuseTalk | not benchmarked here | MIT, but pulls in components we did not audit |
| LatentSync | 5.08x realtime measured | code Apache-2.0, weights openrail++ |

⚠️ We benchmarked the first and last of these. **Ditto is the one we recommend
on licence grounds and did not benchmark**, which means the speed numbers in
this repo are not its numbers. If you take the clean commercial path, re-run
`bench/` against it.

## Speech

Two things decide this, and neither is the metric on the model card.

**Measure wall-clock time for a short sentence, not RTF.** Real-time factor is
generation time over audio length, so a model that speaks slowly gets a better
RTF while the user waits longer. We measured one engine with the better RTF
(1.11 vs 1.89) that was **32% slower on the clock** for the same 10 characters,
because it stretched them over 3.56 s instead of 1.36 s.

**Check whether you are measuring the model or your own setup.** An engine we
had rejected as too slow for real-time - 11-16 s per sentence - was doing
2.7-3.4 s once we stopped re-encoding the reference audio on every call. The
model was never the problem.

Voice cloning has one more constraint that is easy to discover too late: **do
not build a fallback to a different voice.** If the cloned-voice service is
down, failing the request is correct. Falling back to a stock voice gives one
character two voices, which is worse than an error - it breaks the thing the
cloning was for. Fail loudly.

## Language model

The smallest thing that holds a persona. On a 24 GB card we measured:

| | Throughput | VRAM @ 4k ctx |
|---|---|---|
| 8B | **86.3 tok/s** | 5.11 GiB |
| 27B | **19.9 tok/s** | ~11.5 GB |

**4.3x slower per token** for the larger model. For a conversational companion
that is the difference between a reply that arrives as you finish reading the
last one and a reply you sit through.

Two sizing notes that matter more than the parameter count:

**Context is the real cost.** Going from a 4k default to 32k increases an 8B
model's footprint by 87% (+4.4 GB). A companion needs a persona plus history,
so budget the context, not just the model.

**Weights on disk understate resident VRAM by a few percent and the load peak by
more** (+2.3% and +13% for the 8B), and by much more once you add context.

## Where each component should run

The components are not equally worth keeping local:

| | Keep local because | Or move it because |
|---|---|---|
| **Lip-sync** | it is cheap in VRAM (~2.4 GB) and there is no good hosted equivalent | - |
| **Speech** | the cloned voice is your product's identity | it is the most expensive non-LLM component at ~5.1 GB |
| **Language** | conversations never leave the machine | it is the easiest to replace with an API and the largest single saving |

The 8 GB tier is exactly this table applied: keep the two cheap ones local, put
the expensive one behind an API. See `01-tiers.md`.

⚠️ That trade has a cost that is not measured in gigabytes. If local inference
is the reason you are self-hosting, moving the language model to an API gives up
the thing you were building.
