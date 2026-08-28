"""How much VRAM a context window costs, measured rather than estimated.

Model cards quote weights. Nobody ships with 4096 tokens of context, and the KV
cache that a real context needs is not in that number. This loads the same
model at several context sizes and reports what each one actually took.

Method: for each size, unload the model, sample the floor, load with that
num_ctx, drive one short generation, sample again. The difference is the
model plus its KV cache at that context.

Note the generation is deliberately tiny. We are measuring the ALLOCATED cache,
which Ollama sizes from num_ctx up front - not how much of it a long
conversation fills.

    python ctx_scale.py --model qwen3:8b --ctx 4096 8192 16384 32768
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request

OLLAMA = "http://127.0.0.1:11434"


def gpu_used():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used",
                          "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=15)
    return int(out.stdout.strip().splitlines()[0])


def sample(seconds=6.0, every=0.4):
    vals = []
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        vals.append(gpu_used())
        time.sleep(every)
    return min(vals), max(vals)


def post(path, payload, timeout=900):
    req = urllib.request.Request(
        OLLAMA + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def unload(model, settle=10):
    """Drop the model and WAIT for the card to actually give the memory back.

    ⚠️ Two things went wrong here before this version, and both corrupted the
    results rather than failing loudly:

    1. Unloading via /api/generate with keep_alive 0 returns newline-delimited
       JSON even when stream is false, so json.loads raised, the exception was
       swallowed, and the previous context stayed resident. `ollama stop` is
       the supported way and it is synchronous.
    2. Freeing is not instant. Sampling too early recorded a floor that still
       included part of the old model - measured floors of 5664, 6444, 5937 and
       5888 MiB across four runs that should have been identical. An 800 MiB
       wobble in the floor is 800 MiB of error in every delta computed from it.

    ⚠️ What this does NOT do: it waits a FIXED interval, it does not wait for
    the memory to actually come back. An earlier docstring claimed it verified
    floor stability; it never did. The check that catches a bad floor is the
    cross-run guard in main(), not this function. If your floors move, raise
    `settle` - do not assume this returned when the card was quiet.
    """
    subprocess.run(["ollama", "stop", model], capture_output=True, text=True)
    time.sleep(settle)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="qwen3:8b")
    p.add_argument("--ctx", type=int, nargs="+",
                   default=[4096, 8192, 16384, 32768])
    p.add_argument("--out")
    args = p.parse_args()

    rows = []
    floors = []
    for ctx in args.ctx:
        print("\n=== %s  num_ctx=%d ===" % (args.model, ctx))
        unload(args.model)
        lo0, hi0 = sample()
        print("  floor before load: %d-%d MiB" % (lo0, hi0))
        # ⚠️ Guard BOTH ends. The first version checked only lo0, but the delta
        # below is computed against hi0 - so the quantity that actually enters
        # the arithmetic was unguarded. Measured across four runs: lo0 moved
        # 246 MiB (under the threshold, no warning) while hi0 moved 611 MiB,
        # and that drift went straight into the published deltas.
        for name, cur, seen in (("floor_min", lo0, [f[0] for f in floors]),
                                ("floor_max", hi0, [f[1] for f in floors])):
            if seen and abs(cur - min(seen)) > 300:
                print("  !! %s moved %+d MiB vs the first run. Deltas below are "
                      "computed against a shifting baseline - compare context "
                      "sizes to each other, not the absolute numbers."
                      % (name, cur - min(seen)))
        floors.append((lo0, hi0))

        t0 = time.monotonic()
        try:
            r = post("/api/generate",
                     {"model": args.model, "prompt": "Say hi.", "stream": False,
                      "keep_alive": "5m",
                      "options": {"num_ctx": ctx, "num_predict": 16}})
        except Exception as e:                                # noqa: BLE001
            print("  FAILED: %s" % e)
            rows.append({"ctx": ctx, "error": str(e)})
            continue
        load_s = time.monotonic() - t0

        lo1, hi1 = sample()
        # `ollama ps` is the only place that reports a CPU/GPU split at all.
        # ⚠️ It reports intent, not residency - measured, it said "17 GB, 100%
        # GPU" against an 11.5 GB delta. Read it as a hint, never as proof of
        # fit, and note that the field it lands in here is itself corrupt; see
        # the slice bug below.
        ps = subprocess.run(["ollama", "ps"], capture_output=True, text=True)
        proc = "?"
        for line in ps.stdout.splitlines():
            if args.model.split(":")[0] in line:
                # Columns: NAME ID SIZE(2 tokens) PROCESSOR(2 tokens) UNTIL.
                # ⚠️ This was [3:5], which lands on ["GB", "100%"] - it captured
                # the tail of SIZE and the head of PROCESSOR, so "100% GPU" and
                # "100% CPU" both stored as "GB 100%". The single word this
                # field exists to record was the one being dropped, and every
                # row in the shipped data files says "GB 100%" as a result.
                proc = " ".join(line.split()[4:6])
        delta = lo1 - hi0
        print("  after load:        %d-%d MiB" % (lo1, hi1))
        print("  delta ~%d MiB (%.2f GiB)   load+reply %.1fs   ollama says: %s"
              % (delta, delta / 1024, load_s, proc))
        rows.append({"ctx": ctx, "floor_min": lo0, "floor_max": hi0,
                     "loaded_min": lo1, "loaded_max": hi1,
                     "delta_mib": delta, "load_s": round(load_s, 2),
                     "ollama_processor": proc,
                     "eval_count": r.get("eval_count")})

    print("\n%-8s %-12s %-10s %s" % ("ctx", "delta MiB", "delta GiB", "processor"))
    base = None
    for r in rows:
        if "error" in r:
            print("%-8d %s" % (r["ctx"], r["error"][:60]))
            continue
        if base is None:
            base = r["delta_mib"]
        print("%-8d %-12d %-10.2f %s   (+%d MiB vs smallest)"
              % (r["ctx"], r["delta_mib"], r["delta_mib"] / 1024,
                 r["ollama_processor"], r["delta_mib"] - base))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"model": args.model, "rows": rows}, f, indent=2)
        print("\nwrote %s" % args.out)


if __name__ == "__main__":
    sys.exit(main())
