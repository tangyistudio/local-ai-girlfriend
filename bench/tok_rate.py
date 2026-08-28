"""Token throughput, because on Windows it is the only honest fit signal.

On Linux, a model that does not fit fails to load or visibly offloads layers to
the CPU. On Windows in WDDM mode neither happens: the driver oversubscribes
into system RAM, `ollama ps` keeps reporting "100% GPU", and the only symptom
is that generation gets slower. Capacity tools will lie to you here. A stopwatch
will not.

So: generate a fixed number of tokens and report tokens/second, using Ollama's
own eval_count and eval_duration rather than wall time, which would fold in
prompt processing and model load.

Run it once with the card free and once under `ballast.py`. If the rate holds,
the config fits. If it collapses, you are paging, whatever the tools say.

    python tok_rate.py --model qwen3:8b --ctx 32768 --predict 200
"""
import argparse
import json
import statistics
import subprocess
import sys
import time
import urllib.request

OLLAMA = "http://127.0.0.1:11434"

# Long enough that per-request overhead does not dominate, short enough that a
# badly-paging config still finishes before you lose patience.
PROMPT = ("Write a plain description of how a mechanical clock escapement "
          "works. Be concrete and avoid lists.")


def gen(model, ctx, predict, timeout):
    body = json.dumps({
        "model": model, "prompt": PROMPT, "stream": False, "keep_alive": "5m",
        "options": {"num_ctx": ctx, "num_predict": predict},
    }).encode()
    req = urllib.request.Request(
        OLLAMA + "/api/generate", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    wall = time.monotonic() - t0
    n = d.get("eval_count") or 0
    ns = d.get("eval_duration") or 0
    return {"tok": n, "eval_s": ns / 1e9 if ns else None,
            "tok_s": (n / (ns / 1e9)) if ns else None,
            "wall_s": wall,
            "load_s": (d.get("load_duration") or 0) / 1e9,
            "prompt_eval_s": (d.get("prompt_eval_duration") or 0) / 1e9}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="qwen3:8b")
    p.add_argument("--ctx", type=int, default=32768)
    p.add_argument("--predict", type=int, default=200)
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--timeout", type=float, default=900)
    p.add_argument("--label", default="")
    args = p.parse_args()

    used = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total",
                           "--format=csv,noheader,nounits"],
                          capture_output=True, text=True).stdout.strip()
    print("card: %s MiB used/total" % used)
    print("%s  model=%s ctx=%d predict=%d"
          % (args.label or "(unlabelled)", args.model, args.ctx, args.predict))

    rows = []
    for i in range(args.repeats):
        r = gen(args.model, args.ctx, args.predict, args.timeout)
        rows.append(r)
        print("  run %d: %s tok in %.2fs eval -> %s tok/s   (wall %.2fs, "
              "load %.2fs, prompt %.2fs)"
              % (i + 1, r["tok"],
                 r["eval_s"] or 0,
                 ("%.1f" % r["tok_s"]) if r["tok_s"] else "?",
                 r["wall_s"], r["load_s"], r["prompt_eval_s"]))

    rates = [r["tok_s"] for r in rows if r["tok_s"]]
    if rates:
        print("\n  median %.1f tok/s   (min %.1f  max %.1f)"
              % (statistics.median(rates), min(rates), max(rates)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
