# local-ai-girlfriend

**Running an AI girlfriend on your own GPU: what it actually costs, measured.**

繁體中文版：[README.zh-TW.md](README.zh-TW.md)

![The demo character speaking, two of her three looks](site/img/demo.gif)

*Xiaoxian, the demo character. Both clips came out of the pipeline this
repository documents, on one RTX A5000; sound, size controls and the rest of the
demo are on the project page. She is named so the demo reads as a conversation
rather than a video player, and that is the whole of her: no backstory, no
personality spec, no dialogue rules ship here.*

> **She is not MIT.** Xiaoxian and every clip and still of her are
> © 2026 Tangyi Studio, all rights reserved — a generated likeness derived from a
> real person who owns it. The footage is published so this repository's claims
> can be checked against real output, not as a free asset pack. The code and the
> pipeline are what you are being given; bring your own character.

The component lists already exist. Several excellent Chinese-language write-ups
explain which models to wire together, and this project started by following
one of them. What none of them publish is the bill: what each piece really
holds in VRAM, what breaks when you run them together, and which card sizes
actually work.

So we built the whole thing and measured it. Every number here came off one
machine, with the script that produced it in `bench/`, and every claim we did
**not** verify is labelled as such.

---

## What we found that surprised us

**Components do not have a fixed size.** The same cloned-voice TTS held 5.1 GB
on a 24 GB card and ran in 2.7 GB when we constrained the card to 8 GB - same
output, 18-26% slower on short sentences depending on the run, and no slower on
long ones. This breaks
the arithmetic every guide does, including our own first draft: we published
"8 GB is impossible", then tested it and watched the whole stack run in
**7,052-7,615 of 8,192 MiB**. The wrong prediction is still in the document, because
it is the clearest argument we have against sizing a machine from someone
else's numbers.

**The expensive part is the voice, not the video.** People budget for the
lip-sync model. At 5.1 GB the cloned-voice TTS costs more than twice the
lip-sync service (2.4 GB), and speech synthesis is where the user's waiting
time goes: 11.9 s end to end for a sentence, of which lip-sync is 1.75 s.

**Context costs almost as much as the model.** Going from Ollama's 4096-token
default to a 32k window increases an 8B model's footprint by **87%** (+4.4 GB).
A companion needs a persona and a history, so this is not optional.

**On Windows, your tools will lie to you about capacity.** `ollama ps` reported
"17 GB, 100% GPU" while the measured delta was 11.5 GB, and never once said it
had offloaded anything. The WDDM driver oversubscribes into system RAM instead
of failing, so there is no OOM and no error - just a slower machine. Throughput
is the only honest fit signal.

**Residency is cheap; concurrency is not.** A 27B model sitting resident, even
one that filled the card to 98%, cost nothing measurable. The same model
actively generating made lip-sync 1.6x slower.

**Wav2Lip's weights forbid commercial use.** It is the model that makes the
low-VRAM story work and the one every popular guide uses. If money will change
hands, you need a different model, and `docs/07-licenses.md` has the clean path.

---

## Which card do you need

| Card | Configuration | Status |
|---|---|---|
| **8 GB** | Voice + lip-sync local, LLM remote | ✅ tested, 7,052-7,615 / 8,192 MiB |
| **16 GB** | Everything local, 8B at 32k context | ✅ tested at 32k; 16k suggested for headroom |
| **24 GB** | Everything local, 8B at 32k, room to spare | ✅ tested directly |
| **32 GB** | — | ⚠️ arithmetic only, we have no such card |

Smaller tiers were tested by holding VRAM with `bench/ballast.py` until the card
had only that much free. That emulates **capacity**, which decides whether
things load and run. It does not emulate a different GPU's bandwidth, so "it
fits" transfers to real hardware and "it is this fast" does not.

Full configurations and caveats: **[docs/01-tiers.md](docs/01-tiers.md)**

---

## What is in here

| | |
|---|---|
| `docs/` | The measured guide, 9 documents, English and Traditional Chinese |
| `bench/` | The tools that produced every number in it |
| `player/` | Seamless clip playback. Zero dependencies, 18 tests, runnable demo |
| `player/examples/` | A runnable demo, a generated clip library, and the script that verifies it |
| `index.html`, `qa.html`, `site/` | The project pages. Static, bilingual, no build step |
| `services/` | The service contract and the orchestration layer |
| `scripts/` | Launch and supervision, with the failure modes designed out |

**Run it locally** - the project page embeds the real player, and the clips are
real renders of the demo character, so nothing needs downloading and no GPU
involved:

```sh
python -m http.server 8790
# the project page:  http://127.0.0.1:8790/
# the player alone:  http://127.0.0.1:8790/player/examples/demo.html
```

The pages are plain static files. Point any static host at the repository root
and they work; there is no build step to break later.

## Documentation

Every page has a Traditional Chinese counterpart, and CI fails if the two
disagree about a number in prose or a table. ⚠️ Numbers inside code blocks are
not compared - see `bench/check_docs.py` for what the check does and does not
cover.

| | |
|---|---|
| [00-hardware](docs/00-hardware.md) | The VRAM bill, per component, with provenance on every row |
| [01-tiers](docs/01-tiers.md) | What to run on 8 / 16 / 24 / 32 GB |
| [02-architecture](docs/02-architecture.md) | Why this is several processes. Dependency pins force it - you do not get to choose |
| [03-components](docs/03-components.md) | How to evaluate models, and the QA metric that catches a pipeline which has silently stopped working |
| [04-latency](docs/04-latency.md) | Where the wait goes, and the four fixes that moved it |
| [05-assets](docs/05-assets.md) | The clip invariant, and four measurement tools of which the first three were wrong |
| [06-playback](docs/06-playback.md) | Cutting between clips without a visible seam |
| [07-licenses](docs/07-licenses.md) | What you may legally do with each model. Checked, linked, dated |
| [08-ops](docs/08-ops.md) | The failures that actually happen, and the shape they share |

## Tools

Everything in `bench/` is standalone and runs against any HTTP service, not just
ours.

| | |
|---|---|
| `vram.py` | Sample VRAM around a real request. Peak, not resting |
| `suite.py` | The standard probe set, with cache-defeating that actually works |
| `ballast.py` | Hold N GiB so you can test a card size you do not own |
| `ctx_scale.py` | What a context window costs, per size |
| `tok_rate.py` | Token throughput - the only honest fit signal on Windows |
| `check_docs.py` | Fails CI if the English and Chinese docs disagree about a number |

```sh
python bench/vram.py baseline --label desktop-only --seconds 20
python bench/suite.py --repeats 4
python bench/ctx_scale.py --model qwen3:8b --ctx 4096 8192 16384 32768
```

---

## Measuring this is harder than it looks

Every tool in `bench/` carries a header explaining a way we got it wrong first.
Short version, because these will bite you too:

- **A cache-buster appended to the prompt gets read aloud.** Appending a unix
  timestamp to a four-character sentence made the model speak ten extra digits
  and inflated the reading 3.3x. Vary a field that is not spoken.
- **Trailing whitespace does not bust a cache.** Measured: same sentence with 3
  and 11 trailing spaces returned byte-identical audio in 0.01 s.
- **The buster must be unique per run, with a big enough value space.** 12
  values collided across runs and produced 6/6 silent cache hits.
- **Per-process VRAM does not exist on Windows.** `--query-compute-apps` returns
  `[N/A]` under WDDM. Differencing is the only method.
- **`/health` returning 200 does not mean loaded.** One service answered in 5
  seconds and then moved 800 MiB around for 4 minutes.
- **A single VRAM delta is unreadable.** One probe reported +88 MiB while
  returning from cache in 0.00 s, having done no GPU work at all.

`suite.py` refuses to average a sub-100 ms response into a result; it flags it
as a cache hit instead.

---

## Scope

This documents **generated** characters. It does not cover, and we will not add,
tooling or instructions for putting a real person's likeness onto a synthetic
body. That is the one line here, and it is about people who did not consent -
not about what consenting adults generate for themselves.

## Provenance

Extracted from a production talking-head companion product. Everything
product-specific - persona, business logic, character assets, billing - is
excluded by design. What remains is the engineering.

The starting point was [this Chinese teardown](https://www.cnblogs.com/ccsvip/p/22189506)
of a self-hosted companion stack. It is often cited for the "8 GB is enough"
figure, and that is a misreading worth correcting: it lists 8 GB as a stated
*minimum* in a min/recommended table, recommends 16 GB or more, and its own
component budget totals about 17 GB. Our numbers differ from it in places; that is not a
correction, it is a different stack measured on different hardware.

## Licence

MIT for the code in this repository. The models it measures have their own
terms, several of which restrict commercial use - see
[docs/07-licenses.md](docs/07-licenses.md).


## Our own checker fails on our own clips, and we left it that way

    bash player/examples/check-clips.sh   # exits 1
    python player/examples/check-mouth.py 'player/examples/clips/*_still.mp4'         --model face_landmarker.task      # exits 0

The pivot checker reports `ENDS ELSEWHERE` for one of the three looks. Its last
frames sit 20 to 22 out of 255 from the frame its clips start on, where the
other two looks sit at 12.6. By the tool's own rule that is a defect, and the
tool says so.

It is real, it is bounded, and the 120 ms dissolve the player uses covers it.
The cause was chased and is recorded in `docs/05-assets.md`: the drift is added
by the lip-sync generator at the end of a sequence, it scales with mouth
amplitude, and rendering the same sentence over three different sources for
that look produced 21.9, 20.0 and 23.5 - so it follows the face, not the source.
The engine's own expression fade made it worse and trimming to the best of the
last frames recovered almost nothing.

The threshold was not moved to make this pass. A measurement tool tuned until
your own data clears it measures nothing, and this repository exists because
that is what most published numbers are worth.

---

## Built by Tangyi Studio

MIT, plus one condition: **if you use it, say so.** Anything you build on this
code — or on the methods and measurements it documents — needs a visible line
crediting Tangyi Studio somewhere its users can see it: an about page, a footer,
a credits screen, a README. That is the whole requirement. No permission to ask
for, nobody to notify, nothing to pay, and you may keep your own changes closed.

⚠️ That added term means this is MIT **plus** an attribution clause, not stock
MIT, and some automated licence scanners will flag it as non-standard. It is
stated here rather than buried so nobody finds out from a compliance tool.

More from Tangyi Studio: <https://github.com/tangyistudio>
