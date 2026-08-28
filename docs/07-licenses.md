# What you are allowed to do with these models

> **Last checked: 2026-08-28.** Every claim below was re-verified against the
> upstream LICENSE file, model card or repository on that date. Licences change
> and model cards get edited, so a licence page without a date is a licence page
> you cannot act on - including this one, once it is old enough.


Nobody consolidates this, and it is the question that decides whether your
project is a hobby or a business. Every row below was checked against the
project's own LICENSE file, README and model card, with the link.

> **Not legal advice.** This is a reading list with our reading of it. Licences
> change, model cards get edited, and your jurisdiction is not ours. Before you
> charge anyone money, open the links and read them yourself.

> ⚠️ **This page was substantially wrong in its first published version, and the
> correction is the most useful thing on it.** We recommended a "clean
> commercial path" built on a model we had not audited, using the exact
> methodology this page tells you to follow. An adversarial review caught it.
> What we got wrong is documented at the bottom, because the failure mode is
> more instructive than the conclusion.

---

## The two things that catch people

**1. Code and weights are frequently licensed differently.** A badge saying
"MIT" or "Apache-2.0" describes the *code*. The trained model is a separate
artifact, often trained on a dataset with its own terms.

**2. A permissive licence at the top says nothing about what loads at runtime.**
This is the one that got us. A project can be genuinely Apache-2.0 and ship
third-party model files, on the mandatory inference path, that are not.

The second is harder to see, because there is nothing to read - the restriction
lives in a repository you have not opened, referenced by a file the project
bundles without comment.

---

## Lip-sync: 3 of 4 carry non-commercial constraints

| Project | Code | Weights | Runtime deps | Commercial? |
|---|---|---|---|---|
| [Wav2Lip](https://github.com/Rudrabha/Wav2Lip) | **repo restricted** | research/academic/personal only | - | ❌ **No** |
| [LatentSync](https://github.com/bytedance/LatentSync) | Apache-2.0 | openrail++ (tag only) | **InsightFace** | ❌ **not as shipped** |
| [Ditto](https://github.com/antgroup/ditto-talkinghead) | Apache-2.0 | Apache-2.0 | **InsightFace** | ❌ **not as shipped** |
| [MuseTalk](https://github.com/TMElyralab/MuseTalk) | MIT | "any purpose, even commercially" | S3FD terms unstated | ⚠️ closest, one gap |

### Wav2Lip: the whole repository is restricted, not just the weights

The [README's License and Citation section](https://github.com/Rudrabha/Wav2Lip#license-and-citation):

> "This repository can only be used for personal/research/non-commercial
> purposes."

and the disclaimer above the open-source half:

> "As the models are trained on the LRS2 dataset, any form of commercial use is
> strictly prohibited."

There is no LICENSE file. The heading over the open-source release is literally
"Non Commercial Open-source Version". So you cannot fork the code commercially
either - the restriction is broader than a weights restriction.

Sync Labs sells a hosted API. No commercially-licensed weights are offered -
the commercial route is their service, not a licence for these files.

This matters because Wav2Lip is also the cheapest option in VRAM. **"Run it on
8 GB" and "build a product" point at different models.**

### LatentSync and Ditto: Apache-2.0 on top, InsightFace underneath

Both load [InsightFace](https://github.com/deepinsight/insightface) detection
models on every inference. InsightFace's own terms:

> "The training data containing the annotation (and the models trained with
> these data) are available for non-commercial research purposes only."
> "Both manual-downloading models from our github repo and auto-downloading
> models with our python-library follow the above license policy."

**Ditto**, verified in an installed copy:

```
checkpoints/ditto_pytorch/aux_models/det_10g.onnx      16.9 MB   InsightFace buffalo_l
checkpoints/ditto_pytorch/aux_models/2d106det.onnx      5.0 MB   InsightFace 106-point

core/atomic_components/source2info.py:4    from ..aux_models.insightface_det import InsightFaceDet
core/atomic_components/source2info.py:59   self.insightface_det = InsightFaceDet(...)
core/atomic_components/source2info.py:71   det, _ = self.insightface_det(img)
```

Top-level import and constructed unconditionally in `__init__`, so the weights
load on every run. The detector itself is called on the FIRST frame only -
`if last_lmk is None`, after which the pipeline tracks landmarks instead. That
narrows the mechanism and changes nothing about the licence: the files are
shipped and loaded either way. There is
no alternative detector wired in. The models ship inside a weights repository
carrying an Apache-2.0 LICENSE that Ant Group is not in a position to grant over
them.

**LatentSync**, same pattern, verified in an installed copy:

```
requirements.txt:24                       insightface==0.7.3
latentsync/utils/face_detector.py:1       from insightface.app import FaceAnalysis
```

`FaceAnalysis` auto-downloads the buffalo_l pack, which is explicitly covered by
the "auto-downloading models" clause above.

⚠️ **Neither project mentions this.** [LivePortrait](https://github.com/KwaiVGI/LivePortrait/blob/main/LICENSE),
which Ditto's README credits as a basis, does carry the warning in its own
LICENSE file, and it tells you what to do about it:

> "If you want to use the LivePortrait project for commercial purposes, you
> should remove and replace InsightFace's detection models to fully comply with
> the MIT license."

That is the remedy for both: **replace the detector.** The lip-sync model itself
is not the problem.

⚠️ LatentSync's weights carry an `openrail++` tag on the model card, but the
Hugging Face repo ships **no LICENSE file** - so the use-based restrictions that
licence attaches are not readable at the source.

### MuseTalk: the one that discloses its chain

MuseTalk's own terms are the most permissive here - MIT code, and:

> "`model`: The trained model are available for any purpose, even commercially."

and it enumerates its third-party components rather than hiding them. Its
LICENSE lists sd-vae-ft-mse (MIT), whisper (MIT), face-parsing.PyTorch (MIT),
DWPose (Apache-2.0), face-alignment (BSD 3-Clause).

⚠️ **One gap:** the S3FD entry gives a repository URL and then stops - no licence
is stated for it. We are flagging that rather than assuming it is fine.

⚠️ A line the README carries that is easy to miss: *"The testdata are collected
from internet, which are available for non-commercial research purposes only."*
That covers the sample data, not the model.

## Language model and speech: clean

| Project | Licence | Commercial? |
|---|---|---|
| [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) | Apache-2.0 | ✅ Yes |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE) | Apache-2.0 | ✅ Yes |

Apache-2.0 for code and weights, no additional terms on the model cards. The
Qwen3-TTS weight repositories are individually tagged `apache-2.0`. This is the
uncomplicated part of the stack.

## GFPGAN: not Apache-2.0, and not unresolved either

| Project | Reality | Clean for commercial use |
|---|---|---|
| [GFPGAN](https://github.com/TencentARC/GFPGAN/blob/master/LICENSE) | Apache-2.0 **except** enumerated third-party components | ❌ **No** |

Its LICENSE opens:

> "GFPGAN is licensed under the Apache License Version 2.0 **except for the
> third-party components listed below**."

and among those:

- **StyleGAN2**, under the NVIDIA license: *"The Work and any derivative works
  thereof only may be used or intended for use non-commercially."*
- **DFDNet**, under Creative Commons Attribution-**NonCommercial**-ShareAlike 4.0

So a face-restoration pass using GFPGAN is not commercially clean. GitHub
classifies the repository as "Other", not Apache-2.0.

---

## So what can you actually ship?

**Honest answer: we do not have a fully verified commercial lip-sync path to
recommend, and we are not going to invent one twice.**

What we can say:

```
LLM        Qwen3         Apache-2.0, verified clean
TTS        Qwen3-TTS     Apache-2.0, verified clean
enhance    not GFPGAN    NVIDIA and CC-BY-NC components in its LICENSE
lip-sync   ← the open question
```

For lip-sync, the two routes that could work, neither of which we have
completed:

1. **MuseTalk**, if you resolve S3FD's terms. Its own licence is permissive and
   it discloses its chain, which is the behaviour you want from an upstream.
2. **Ditto or LatentSync with the InsightFace detector replaced**, exactly as
   LivePortrait's LICENSE instructs. The lip-sync weights are fine; the face
   detector is the problem, and face detection has permissively-licensed
   alternatives.

If you do either, you will have done work we have not. We would rather say that
than hand you another confident recommendation.

⚠️ Whichever you pick, the performance numbers in `00-hardware.md` and
`04-latency.md` were measured on a Wav2Lip-class service. **They are not
automatically your model's numbers.** Re-run `bench/` against what you ship.

---

## How to check this yourself

Licences move, and the procedure matters more than the table above:

1. Open the project's **LICENSE file**, not the badge. GFPGAN's badge says
   Apache-2.0 and its LICENSE file carves out two non-commercial components.
2. Open the **model card** for the weights - usually a separate Hugging Face
   page with its own licence field. And check whether the licence it names is
   actually shipped as text; LatentSync's is not.
3. Read the README's **disclaimer** section. Non-commercial restrictions on
   weights live there far more often than in a LICENSE file.
4. **List what the project imports and loads at runtime, and repeat for each.**
   `grep` the inference path for model loads and look at what files ship in the
   weights repository. This is the step everyone skips.

If a project states nothing about a bundled third-party model, that is a
finding, not a permission.

---

## What we got wrong, and why

The first version of this page recommended **"Ditto + Qwen3 + Qwen3-TTS, all
Apache-2.0, no dependency chain to audit."**

Every part of that sentence was checked except the part that mattered. We read
Ditto's LICENSE (Apache-2.0 ✓), checked its model card (no separate terms ✓),
and concluded it was clean - **without doing step 4 on it.** We did do step 4 on
MuseTalk, which discloses its dependencies, and flagged it as the risky one.

That inverts the actual risk. **The project that publishes its dependency chain
is the safe one to evaluate; the project that says nothing is the one you have
to go looking at.** We rewarded disclosure with suspicion and silence with a
green tick.

We also marked GFPGAN "unresolved, we are not guessing" - which reads as
diligence and was actually a failure to open a file that answers the question in
its first sentence.

Both errors were findable on the day the page was published. This was not
licence drift. It was an audit that stopped early on the row it was about to
recommend.
