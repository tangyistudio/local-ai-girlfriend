# Configurations by card size

What to run on 8, 16, 24 and 32 GB. Every row says whether we tested it, and
how - because we own one card, not four.

## How these were tested

We have a **24 GB RTX A5000**. Smaller tiers were tested by occupying VRAM with
`bench/ballast.py` until the card had only the target amount free, then running
the real stack in what was left.

That emulates **capacity**, which is what decides whether a model loads, whether
a runtime silently offloads, and whether an allocator starts thrashing. It does
not emulate a different GPU: bandwidth, core count and cache all stay ours. So:

- **"fits" claims are tested.** They transfer.
- **speed claims do not transfer.** Consumer cards at these tiers generally have
  considerably less memory bandwidth than a workstation card, and this workload
  is memory-bound. Expect slower. We are not going to guess by how much - check
  your card's bandwidth against this one's (768 GB/s) and assume it scales
  roughly with that.
- **32 GB is untested.** You cannot emulate more memory than you have. That row
  is arithmetic, marked as such.

---

## The budget you are spending

Measured on this box, warm, from `docs/00-hardware.md`:

| Item | VRAM | Note |
|---|---|---|
| Windows desktop | **1.9 - 3.4 GB** | measured twice hours apart; depends what is open |
| Lip-sync service | **~2.4 GB** | wav2lip-class, 256px |
| Cloned-voice TTS | **~5.1 GB** | the single most expensive non-LLM component |
| Qwen3 8B @ 4k ctx | **5.11 GiB** (5,233 MiB) | |
| Qwen3 8B @ 8k ctx | 5.74 GiB (5,874 MiB) | |
| Qwen3 8B @ 16k ctx | 6.89 GiB (7,051 MiB) | |
| Qwen3 8B @ 32k ctx | **9.54 GiB** (9,764 MiB) | +4.42 GiB over 4k (9,764 - 5,233 = 4,531 MiB) - an **87% increase** |

⚠️ **These are upper bounds, not requirements.** Every figure above was measured
with 24 GB available, and these components shrink when the card is smaller - the
TTS runs in about 2.7 GB on an 8 GB card rather than 5.1 GB, at nearly the same
speed. **Do not add this column up and conclude a smaller card cannot cope.** We
did exactly that and were wrong; see the 8 GB section. Use the table to see
where the money goes, and the tested tiers below to decide what runs.

Two things to notice before picking a tier.

**Context is not free and the default is not enough.** Ollama defaults to 4096
tokens. A companion needs a persona plus conversation history. Going to 32k
increases the model's footprint by 87%.

**The cloned voice is the expensive part, not the lip-sync.** People budget for
the video model. At 5.1 GB the voice clone costs more than twice the lip-sync
service, and it is the first thing to move off the card when you are short.

---

## 8 GB - voice and lip-sync local, LLM remote

**Status: tested under ballast. It works, and we were wrong about that.**

```
local:   cloned-voice TTS + lip-sync
remote:  LLM (any hosted API)
```

Measured with the card constrained to 8,192 MiB by holding 14,836 MiB of
ballast. Every row below is **recorded** in `bench/results.json`; the ballast
size is in the baseline's label so you can reconstruct the in-tier figure.

| | Value | |
|---|---|---|
| Desktop, before ballast | 2,263 - 2,660 MiB | recorded |
| Both services loaded and working, in-tier | **7,052 - 7,615 of 8,192 MiB** | recorded |
| After the probe suite | 6,887 MiB | recorded |
| TTS, short sentence | 2.80 s (24 GB: 2.38 s) | recorded |
| TTS, long sentence | 12.24 s (24 GB: 12.36 s) | recorded |
| Lip-sync, short | 0.88 s (24 GB: 0.82 s) | recorded |
| Lip-sync, long | 3.01 s (24 GB: 3.12 s) | recorded |

**Long sentences and lip-sync are not slower at all.** Short TTS sentences are
18% slower here.

⚠️ An earlier run of the same tier gave 3.01 s for the short sentence - a 26%
penalty rather than 18%. Both runs are real; the spread between two sessions is
larger than the effect being measured, which is worth knowing before you plan
around a single figure. What is stable across both: **the tier works, and the
expensive operations are not the ones that slow down.**

### We predicted this tier would fail, and published the prediction

The first version of this page said 8 GB was impossible: the desktop takes
~3.2 GB, the TTS is 5.1 GB, that is already over. Then we ran it.

The arithmetic was wrong because **the TTS is not 5.1 GB**. It is 5.1 GB when
there is 24 GB available and about 2.7 GB when there is not, doing the same work
at nearly the same speed. Component sizes measured on a large card are an upper
bound on usage, not a requirement.

We are leaving the wrong prediction in the document on purpose. It is the
clearest demonstration we have of why you should not size a machine by adding
up other people's numbers - including ours.

### What does not fit

The 8B model needs ~5.35 GB even when squeezed. With 694 MiB left there is no
room, so on this tier the language model goes to an API.

⚠️ That means your conversations leave the machine. For many people, that is the
entire reason to self-host, and this tier gives it up. If local inference is the
point, 8 GB is not your tier.

### A design requirement this exposed

The reference server we measured **cannot run lip-sync without local TTS**.
`_render` writes speech to a temporary directory and calls the TTS service on
every cache miss; there is no endpoint that accepts audio you already have.

So "TTS is remote" is not a configuration you can select - it needs an API that
takes an audio file or URL alongside the text. Any implementation meaning to
support this tier has to expose one. Ours will.

## 16 GB - everything local, but tight

**Status: tested under ballast. It works, with a caveat that matters.**

We emulated a 16 GB card and ran the full stack: cloned-voice TTS, lip-sync and
Qwen3 8B at 32k context.

| Measurement | 24 GB | Emulated 16 GB |
|---|---|---|
| Token generation | 86.3 tok/s | **86.5 tok/s** |
| 27,523-token prompt | 12.0 s | **16.0 s** (+33%) |
| Full 27.5k context processed? | yes | **yes** |

Generation speed is identical. Prompt processing on a very long context is a
third slower. Both are usable.

### The caveat: it depends when you measure

Our 16 GB run had a floor of 8,489 MiB for desktop + TTS + lip-sync, and the
full stack ran in it. A later reading of those same three, unconstrained and
after sustained use, was higher - **9,409 to 9,546 MiB** recorded, and a
**session** reading of 9,920 MiB taken under ballast.

⚠️ **We previously did arithmetic on the 9,920 figure to conclude the tier goes
over its ceiling under load. We are withdrawing that**, for two reasons:

1. It used a **session** number when `results.json` holds a lower recorded one,
   and the verdict flips inside that range: 9,546 + 6,924 = 16,470 (over by
   86 MiB), 9,409 + 6,924 = 16,333 (**under**).
2. It is the sum this very page forbids two sections earlier - adding
   large-card component figures to predict a small card, which is how we got
   the 8 GB tier wrong.

What we can say is what we measured: **the 16 GB configuration ran, at full
speed, from a cold start.** Whether it survives hours of sustained use we did
not test. If you want margin rather than a coin flip, 16k context leaves room;
that is a recommendation, not a measurement.

```
16 GB, tested:      TTS local + lip-sync local + 8B @ 32k ctx - ran at full
                    speed from a cold start
16 GB, suggested:   the same at 16k ctx, for headroom we did not verify was
                    necessary but which costs little
```

## 24 GB - comfortable, and what we actually run

**Status: tested. This is the box everything else in this repo was measured on.**

The whole stack ran here with room to spare, which is the point of this tier:
it is the first one where you are not managing the budget.

⚠️ We are deliberately **not** printing a sum of the component column here. An
earlier version did, and it contradicted this page's own warning two sections
above - the same reasoning that made us declare 8 GB impossible. Components
shrink to fit; a sum of upper bounds is not a requirement. What is measured is
that it ran.

**A 27B fits, but you pay for it in speed.** With the edge services running,
loading Qwen3.8 27B took the card to 22,528 of 23,028 MiB - 97.8%. It ran, and
we measured it:

| Model | Throughput | Cold load |
|---|---|---|
| Qwen3 8B | **86.3 tok/s** | 15.6 s |
| Qwen3.8 27B | **19.9 tok/s** | 16.5 s (load only) |

**4.3x slower per token.** For a companion that is meant to answer in
conversational time, that is the difference between a reply arriving as you
finish reading the last one and a reply you wait for. Unless the 27B is
noticeably better at your particular task, the 8B is the better product
decision on this card.

## 32 GB - arithmetic only

**Status: NOT TESTED. We do not have the hardware.**

By subtraction from the numbers above, 32 GB should hold the full local stack
plus a substantially larger model, or the 8B with a much longer context. We are
not going to be more specific than that, because we would be making it up.

One thing we can say from what we did measure: on this stack we hit a **capacity
wall, not a compute wall**. A 27B model filled the card at 97.8%. If you are
choosing hardware, buy memory before you buy compute.

---

## The rule that matters more than the tiers

We ran the probe set three times: alone, with a 27B model resident but idle, and
with it actively generating.

| Probe | Alone | Resident, idle | Generating |
|---|---|---|---|
| Lip-sync, short | 0.82 s | 0.89 s | **1.11 s** |
| Lip-sync, long | 3.12 s | 2.94 s | **5.00 s** |

A resident-but-idle model, even one that filled the card, cost nothing
measurable. A generating one cost **1.35x on short clips and 1.6x on long
ones**.

**Loading things together is survivable. Computing together is not free.** If
your pipeline is sequential - the user speaks, the LLM answers, then TTS, then
lip-sync - you are mostly paying for residency, and these tiers hold. If you
overlap stages to cut latency, price the overlap.

---

## Reading your own tools on Windows

Two failure modes to know about before you trust any capacity number:

**`ollama ps` reports intent, not VRAM.** With the edge stack running it
reported "17 GB, 100% GPU" for the 27B while the measured delta was 11.5 GB. At
32k under ballast it reported "10.0 GB, 100% GPU" while the delta was 6.9 GB.
It never once said it had offloaded anything.

**⚠️ This document used to explain that with WDDM oversubscription - the driver
spilling past physical VRAM into system RAM. `docs/00-hardware.md` withdraws
that explanation**: it was never measured, the card never actually filled, and
the throughput test proposed as its diagnostic came back negative. What is left
is the observation itself, which is enough to act on: the reported figure is
intent, not residency.

Together those mean **you cannot tell from the tools whether a config fits on
Windows**. The only honest signal is throughput: run `bench/tok_rate.py` with
the card free and again under `bench/ballast.py`. If the rate holds, it fits.
