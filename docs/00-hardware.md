# What it actually costs in VRAM

Every guide to running an AI companion locally opens with a hardware table, and
almost none of them say where the numbers came from. This one does. Each row is
tagged with its provenance, and the ones we measured ourselves come with the
script that produced them.

**The short version:** on a 24 GB card, a cloned-voice TTS model, a lip-sync
model and an 8B language model held about **12.9 GB** between them. But that
number does not transfer to a smaller card, and the reason is the most useful
thing we learned:

> **Components do not have a fixed size. They take less when there is less.**
> The TTS held 5.1 GB with 24 GB available and ran in **2.7 GB** when we
> constrained the card to 8 GB - returning HTTP 200 at plausible sizes, 26% slower
> on short sentences and no slower at all on long ones.

⚠️ We did not compare the audio itself. Nothing in `bench/` does, and generation
is not deterministic, so byte counts could not establish it either. "It still
worked" here means it answered and the timings are sane, not that the output
was verified identical.

That breaks the arithmetic every guide does, including the first draft of this
one. We wrote "8 GB: no, the TTS alone is 5.1 GB and only 4.8 GB is free", then
tested it and found the whole thing running in **7,498 of 8,192 MiB**. Adding
up component sizes measured on a big card will tell you a small card cannot do
something it can.

| Card | Verdict | How we know |
|---|---|---|
| 8 GB | **TTS + lip-sync, LLM remote.** Runs. 7,498 / 8,192 MiB. | tested under ballast |
| 16 GB | **Everything local**, 8B at up to 32k context. Tight under sustained load. | tested under ballast |
| 24 GB | **Comfortable.** Or a 27B, at a quarter of the token rate. | tested directly |
| 32 GB | Not tested. We do not have the hardware. | arithmetic only |

See `docs/01-tiers.md` for the configuration at each tier and what we did and
did not verify.

---

## The table

Measured on this box unless the row says otherwise:

> **RTX A5000, 23,028 MiB, driver 580.97, Windows 11.**

### How to read the provenance labels

An audit of this page found that the figures hardest to obtain were exactly the
ones with no file behind them - the manual ballast bookkeeping, the throughput
runs, the end-to-end timings. Those are now labelled, because "we measured it"
and "you can check it" are different claims:

| Label | Means |
|---|---|
| **recorded** | in `bench/results.json` or `bench/ctx_*.json`. You can check it. |
| **session** | measured on this machine, but the tool wrote no file. Real, unverifiable by you. |
| **source** | from the source project's engineering log, not re-measured here. |
| **third-party** | someone else's published number. Not verified. |

⚠️ Every **session** row is work still owed: the tool should have persisted it
and did not. Treat those figures as weaker than the recorded ones, because they
are.

### System states

These are total card occupancy, sampled at 10 Hz for 14-24 s each.

| State | VRAM used | Provenance |
|---|---|---|
| Desktop only, no AI services | 1,928 - 2,372 MiB | **recorded** |
| Desktop only, second reading hours later | 3,217 - 3,417 MiB | **session** |
| \+ cloned-voice TTS loaded, never used | 7,996 - 8,046 MiB | **session** |
| \+ cloned-voice TTS after first inference | 8,499 - 8,509 MiB | **session** |
| \+ lip-sync service, settled | 10,953 - 10,973 MiB | **recorded** |

⚠️ Three of these five are **session** rows, and the per-component table below
is derived by subtracting them. The arithmetic is self-consistent, but you
cannot re-derive it from the data files. That is a defect in our tooling, not a
reason to trust the numbers more.

### Per component, derived

Derived by difference. Per-process VRAM attribution is **not available** on
Windows in WDDM driver mode - `nvidia-smi --query-compute-apps=used_memory`
returns `[N/A]` for every row - so differencing is the only method available.

| Component | Resident VRAM | Provenance |
|---|---|---|
| Cloned-voice TTS (warm) | **~5.1 GB** | derived from **session** rows |
| Lip-sync, on top of a running TTS | **~2.4 GB** | derived from **session** rows |
| Both together | **~7.5 GB** | derived from **session** rows |
| Desktop overhead you cannot avoid | **1.9 - 3.4 GB** | one **recorded**, one **session** |

### Numbers we did not measure

Carried from other sources and **not verified here**. They are in the table
because leaving them out would be worse, not because we stand behind them.

| Claim | Value | Source |
|---|---|---|
| wav2lip256 lip-sync | 1.3 GB | third-party blog post |
| MuseTalk lip-sync | ~12 GB | third-party blog post |
| Full stack incl. LLM on a 4090 | ~17 GB | third-party blog post |
| LatentSync 1.5 / 1.6 | 8 GB / 18 GB | upstream README |

---

## Caveats you have to read before using this table

### 1. Our lip-sync number is roughly double the widely-quoted one

The figure that makes "8 GB is enough" circulate is 1.3 GB for wav2lip256. We
measured **2.4 GB** for the lip-sync service as deployed.

We are not claiming the 1.3 GB is wrong. We are claiming it is not the number
you should budget against, because a deployed service is not just model
weights. It is a process, and a process on a GPU carries a CUDA context, a
framework runtime and an allocator that keeps freed blocks rather than
returning them. Run two models in two processes - which you will have to, see
below - and you pay that overhead twice.

If a VRAM figure does not say whether it is weights or resident process
footprint, assume weights, and assume you will need more.

### 2. Your desktop has already spent 2-3 GB, and it is not a constant

Before a single model loads, this machine was holding VRAM for the compositor,
browsers and background apps. We measured that twice, hours apart, on the same
machine with the same services stopped:

    3,217 - 3,417 MiB
    1,928 - 2,372 MiB

**A 1.3 GB spread**, entirely down to what was open at the time. On a 24 GB card
that is a rounding error. On an 8 GB card the high reading is 40% of everything
you have, and the difference between the two readings is larger than a small
language model.

Budget against usable headroom, measured on a machine in the state you actually
use it, and use your worst reading rather than your best.

### 3. A model gets bigger after you use it

TTS held 7,996-8,046 MiB once loaded and 8,499-8,509 MiB after a single
inference - about **460 MiB it acquired and did not give back**. That is the
framework's caching allocator behaving normally.

Measure after warming, not after starting. Sizing on the post-startup number
understates by half a gigabyte per component.

### 4. `/health` returning 200 does not mean loaded

The lip-sync service answered `/health` with 200 within 5 seconds of launch,
then spent nearly **4 minutes** oscillating between 10,945 and 11,796 MiB
before settling. Sample it at the wrong moment and you can be 800 MiB out in
either direction.

This cuts both ways, and the opposite failure is worse: a process that is still
loading its model has **not yet opened its port** but is **already holding
VRAM**. A watchdog that decides liveness on `/health` alone will conclude the
service is down, start another one, and repeat. That failure mode has been
observed reaching 38 processes and deadlocking the card.

Wait for the number to go flat. Do not trust a readiness endpoint.

### 5. Component footprints shrink under pressure - so do not add them up

This is the one that overturned our own conclusion, so it goes in bold.

The same cloned-voice TTS, doing the same work:

| Card | Resident | tts-short | tts-long |
|---|---|---|---|
| 24 GB free | ~5.1 GB | 2.38 s | 12.36 s |
| constrained to 8 GB | **~2.7 GB** | 3.01 s | 12.38 s |

Same for the 8B model at 32k context: 9.54 GiB with the card free, 6.76 GiB
when constrained, at **identical** token throughput (86.3 vs 86.5 tok/s).

Frameworks and caching allocators size themselves to available memory. A
measurement taken on a roomy card tells you what the component will *use*, not
what it *needs*. **Sizing a small card by summing large-card measurements will
tell you things are impossible that are not.**

The corollary is that you cannot compute a tier - you have to test it. That is
what `bench/ballast.py` is for.

### 6. Inference-time VRAM is inside the noise

Across all four probes the extra VRAM held during a request had a median of
0 to +210 MiB, with individual samples ranging from 0 to +451 MiB - and one
early probe reported +88 MiB while returning in 0.00 s from cache, meaning it
did no GPU work at all.

For a resident model, activation memory is not what decides whether it fits.
The resting footprint is. Single deltas are unreadable; that is why everything
here is repeated and reported with its spread.

---

## Adding a local LLM

The figures above contain **no language model at all** - that stack called a
hosted API. Running the LLM locally too is a separate budget, so we measured
two, through Ollama, on the same box with the TTS and lip-sync services already
running.

| Model | On disk | VRAM delta | Ollama reports | Cold load | **Throughput** |
|---|---|---|---|---|---|
| Qwen3 8B | 5.23 GB | **+5.9 GB peak / ~5.35 GB resident** | 5.6 GB, 100% GPU | 15.6 s | **86.3 tok/s** |
| Qwen3.8 27B | 17.74 GB | **+11.5 GB** | 17 GB, 100% GPU | 16.5 s * | **19.9 tok/s** |

All first-party, ctx 4096, measured with the TTS and lip-sync services running.

\* ⚠️ The two cold-load figures are **not the same quantity**. The 8B's 15.6 s is
wall time for a load plus a short reply, recorded in `results.json`. The 27B's
16.5 s is Ollama's `load_duration` alone, from a `tok_rate.py` run that wrote no
file. Do not read them as a comparison.
Throughput is Ollama's own `eval_count / eval_duration` over 200-token
generations, median of 3, so it excludes model load and prompt processing.

**The 27B is 4.3x slower per token.** It loads and runs on a 24 GB card next to
the rest of the stack - though see below, where the card's own accounting and
Ollama's do not agree about it - and it costs you most of your generation speed.

### Context scaling, Qwen3 8B

| num_ctx | VRAM | vs 4096 |
|---|---|---|
| 4,096 | 5.11 GiB | - |
| 8,192 | 5.74 GiB | +641 MiB |
| 16,384 | 6.89 GiB | +1,818 MiB |
| 32,768 | **9.54 GiB** | **+4,531 MiB** |

Going from Ollama's 4096 default to a 32k window **increases the footprint by
87%** - 5,233 MiB to 9,764 MiB. A companion needs a persona and a conversation
history, so this is a cost you are going to pay, not one you can design around.

⚠️ Earlier versions of this line, and of three other documents, said the added
context costs "more than the model weights themselves". That is false and the
table above disproves it: the increase is 4,531 MiB against a 4k footprint of
5,233 MiB. It is an 87% increase, not 87% on top of the weights.

⚠️ Getting this table right took two attempts. The first run unloaded the model
through `/api/generate` with `keep_alive: 0`, which returns newline-delimited
JSON; `json.loads` raised, the exception was swallowed, and the previous
context stayed resident. Measured floors across four supposedly identical runs
came out at 5664, 6444, 5937 and 5888 MiB - an 800 MiB wobble in the baseline
that every delta was then computed against. `bench/ctx_scale.py` now uses
`ollama stop`, waits for the memory to come back, and prints a warning if the
floor moves more than 300 MiB between runs.

**Weights on disk understate resident VRAM by a few percent, and the load peak
by more.** Qwen3 8B is 5.23 GB on disk, about 5.35 GB resident (+2.3%), peaking
near 5.9 GB while loading (+13%). The gap is KV cache, context and per-process
CUDA overhead. Budget above the file size, and budget for the peak, not the
resting figure.

### `ollama ps` and the card disagreed, and we cannot tell you why

The edge stack was holding ~11 GB. Loading the 27B pushed the card to
**22,528 of 23,028 MiB - 97.8%**, and Ollama reported "17 GB, 100% GPU" while
the measured delta was 11,506 MiB. Those do not reconcile.

⚠️ **We previously explained this as WDDM oversubscription - the driver spilling
past physical VRAM into system RAM. We are withdrawing that**, because we never
measured it and there are two problems with it:

1. **The card never actually filled.** 22,528 < 23,028. Nothing had to spill.
2. **This page's own headline finding explains it without WDDM.** Caveat 5
   establishes that allocators shrink to fit - the TTS from 5.1 GB to 2.7 GB,
   the 8B from 9,764 to 6,924 MiB. A 27B taking 11.5 GB rather than 17 GB in a
   card that already held 11 GB is that same behaviour.

And the diagnostic we ourselves propose for paging - does throughput collapse? -
came back **negative**: 86.3 vs 86.5 tok/s, unchanged. The one test we offered
points away from the explanation we gave.

What survives is the practical part, which is what matters: **`ollama ps`
reports intent, not resident VRAM, and it never once said it had offloaded
anything.** Do not size a card from it. Whether the shortfall is paging or
shrink-to-fit, we did not establish, and we should not have said we had.

### Residency is cheap; concurrency is what costs you

We re-ran the whole probe set three times: alone, with the 27B resident but
idle, and with the 27B actively generating.

| Probe | Alone | 27B resident, idle | 27B generating |
|---|---|---|---|
| Lip-sync, short | 0.82 s | 0.89 s | **1.11 s** |
| Lip-sync, long | 3.12 s | 2.94 s | **5.00 s** |

A resident-but-idle model, even one that pushed the card to 98% and forced
paging, cost nothing measurable - two probes came back marginally *faster*,
which is noise. A model actually generating cost **1.35x on short clips and
1.6x on long ones**.

The rule to take away is not "these cannot coexist". It is that **loading
things together is survivable and computing together is not free**. If your
pipeline is sequential - user speaks, LLM answers, then TTS, then lip-sync -
you are mostly paying residency. If you overlap them to cut latency, price the
overlap.

(The TTS rows are omitted from that table: on the concurrent run all 6 TTS
probes - 3 short, 3 long - were served from cache, because `lead_ms`
is seeded from the clock modulo 400 and therefore **repeats every 400 seconds**,
which is worse than a small range: the collisions are periodic, not random. The lip-sync rows use a
buster with a million distinct keys and were all genuine. See `bench/suite.py`.)

---

## Latency, same box

Median of 4 runs each. TTS is the local cloned-voice service; the lip-sync rows
have their TTS step served from cache, so they are close to lip-sync time
alone rather than end-to-end.

| Probe | Wall time (median) | Range | Output |
|---|---|---|---|
| TTS, short sentence | 2.38 s | 1.45 - 3.24 | 50,958 B (~1.6 s audio) |
| TTS, long sentence | 12.36 s | 11.52 - 13.59 | 205,807 B (~6.4 s audio) |
| Lip-sync, short | 0.82 s | 0.78 - 0.83 | 778 KB video |
| Lip-sync, long | 3.12 s | 2.98 - 3.31 | 4.26 MB video |
| **End to end, cold** | **11.9 s** | single run | 2.33 MB video |
| **End to end, TTS cached** | **1.75 s** | 1.62 - 1.91 | 2.33 MB video |

The last two rows are the numbers a user actually waits for. "Cold" is one
sentence with nothing cached: text in, finished talking-head video out. "TTS
cached" is the same sentence when the audio already exists, which isolates the
lip-sync stage - and is also what you would see if the TTS ran somewhere else.

**Speech synthesis, not lip-sync, is the bulk of the wait**: 11.9 s versus
1.75 s for the same sentence.

**Generation cost tracks audio length, not character count.** The long sentence
has 7.5x the characters of the short one but took only 5.2x the time - which
tracks the 4x difference in audio produced, not the character count. Real-time
factors are 1.5 (short) and 1.9 (long), computed against 16 kHz 16-bit mono.

The practical consequence: shortening a sentence past the point where it still
produces a second or two of audio buys you almost nothing, because a very short
sentence still carries fixed overhead and still produces a floor of audio.

---

## Reproducing this

```
python bench/vram.py baseline --label desktop-only --seconds 20
python bench/suite.py --repeats 4
```

`bench/suite.py` documents three ways this measurement goes wrong that are not
obvious, all of which we hit before getting the numbers above:

1. A cache-buster appended to the sentence **gets read aloud**, which inflated
   one wall-time reading 3.3x.
2. The buster has to be unique **per run**, not per repeat, or the second run
   is served from the cache the first one filled.
3. The buster's value space has to be large enough that runs do not collide -
   12 values produced 6/6 cache hits.

The suite refuses to report silently when this happens: any run returning under
100 ms is flagged as a cache hit rather than averaged into the result.
