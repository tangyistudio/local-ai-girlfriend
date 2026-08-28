# Why this is several processes and not one program

The obvious design is one Python program that loads a language model, a speech
model and a lip-sync model, and calls them in turn. Nobody builds it that way,
and the reason is not architectural taste.

**You cannot install these models in the same environment.** That is the
constraint everything else follows from.

---

## The constraint

Different models pin different versions of the same handful of libraries, and
the pins are not compatible:

| Component | torch | numpy |
|---|---|---|
| MuseTalk | 2.0.1 | 1.23.5 |
| LatentSync | 2.5.1 | 1.26.4 |

Those are not two preferences you can split the difference on. They are two
environments, and putting them in one is not a thing you can do carefully - it
is a thing you cannot do.

So each model gets its own virtual environment, and a virtual environment
implies a process, and processes that need to talk to each other imply a
protocol. HTTP over localhost is the usual answer, and once you are there the
"architecture" is just: **one small HTTP service per model, an orchestrator
that calls them in order.**

You are not choosing microservices. Dependency resolution chose for you.

## The failure this creates, and it is silent

Sharing an environment does not usually announce itself with an import error.
It quietly gives you the wrong build.

Installing one package into an environment that already had a working CUDA
torch replaced it, because that package's `pyproject.toml` pinned a torch
version: the CUDA build was uninstalled and a **CPU build** went in. Nothing
failed. Everything imported. `torch.cuda.is_available()` returned `False`, and
the model ran on the CPU at a speed that would have gotten it rejected in a
benchmark - **as being a bad model, rather than as being badly installed**.

Two things follow:

**Install order matters.** Install the package first and the CUDA torch build
last, so nothing can pull the CUDA build back out from under you.

**A reinstall may do nothing.** pip treats `2.8.0+cpu` and `2.8.0+cu126` as the
same version, because the local version label does not participate in
comparison. Reinstalling appears to succeed and changes nothing. You need
`--force-reinstall`.

**Check `torch.cuda.is_available()` after every environment change**, and treat
a `False` as a broken install rather than as a result. A model measured on the
CPU is not a slow model. It is not a measurement.

## What this buys you

The forced separation turns out to be useful for reasons beyond dependencies:

**You can measure components individually.** Per-process VRAM does not exist on
Windows (see `00-hardware.md`), so the only way to attribute memory is to start
and stop things and take differences. That is possible because each model is a
process you can stop. In a single-program design you would have no way to ask
what the TTS costs.

**You can put one component somewhere else.** The 8 GB tier works precisely
because the language model can be an API call instead of a local process, with
nothing else changing. If it were an import, it could not be.

**One model crashing does not take the others down.** These are research-grade
codebases and they do crash.

## What it costs

**Per-process GPU overhead, paid once per process.** A CUDA context, a
framework runtime and an allocator that holds freed blocks rather than
returning them. This is a large part of why our deployed lip-sync service
measured 2.4 GB against a widely-quoted 1.3 GB for the model. Two models in two
processes pay it twice.

**Serialisation at every hop.** Audio and video move between processes as files
or HTTP bodies, not as tensors already on the GPU. For this workload it is not
the bottleneck - speech synthesis dominates by an order of magnitude, see
`04-latency.md` - but it is not free either.

**No shared GPU scheduler.** Each process asks the driver for memory
independently, and nothing coordinates them. That is behind the GPU-contention
failures in `08-ops.md` - the starved service and the watchdog that reached 38
processes. The other failures there have different causes.

## The shape that results

```
     browser  ──HTTP──►  orchestrator  ──┬──►  LLM service      (own env)
                                          ├──►  TTS service      (own env)
                                          └──►  lip-sync service (own env)
```

The orchestrator holds no models. It splits the reply into sentences, calls TTS
then lip-sync per sentence, and streams finished clips back as they are ready.
That per-sentence pipelining is what makes the wait tolerable, and it is
covered in `04-latency.md`.

### One thing this shape needs that ours did not have

The lip-sync service must accept **audio it did not generate**.

The implementation we measured could not: it wrote speech to a temporary
directory and called the TTS service on every cache miss, with no endpoint that
takes an existing audio file. That is fine until you want to run the TTS
somewhere else - and "somewhere else" is exactly the 8 GB configuration.

If you are building this, give the lip-sync service two entry points from the
start: one that takes text and orchestrates, and one that takes audio and only
does lip-sync. The second one is what makes the tiers reconfigurable.

## Where the GPU lives

Nothing above requires the model processes and the web frontend to be on the
same machine, and in practice they are not: the frontend is on a host that is
always up, and the model processes are on whatever box has the GPU, reached
through a tunnel.

⚠️ This split has one property worth designing around: **the frontend stays up
when the GPU box does not**. The site keeps answering 200 while the thing that
makes it work is dead, and no one is told. Whatever you build, health-check the
GPU services from outside and alert on those, not on the web tier - see
`08-ops.md`.
