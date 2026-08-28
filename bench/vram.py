"""Measure what a component actually costs in VRAM.

WHY THIS EXISTS
---------------
Every "run an AI companion on 8GB" post repeats the same VRAM numbers, and
almost nobody says where they came from. Second-hand numbers in this field are
unreliable in both directions: a public issue on one TTS model reports RTF 13.1
on a 3060 against a paper claim of 0.84 - a 15x gap, with no reply on the
thread. So this tool exists to let you produce YOUR OWN table on YOUR OWN card,
and to record enough metadata that someone else can tell whether your number
transfers to their machine.

THE MEASUREMENT PROBLEM (read this before trusting any number)
--------------------------------------------------------------
`nvidia-smi --query-compute-apps=used_memory` returns `[N/A]` on Windows in
WDDM driver mode - the OS owns VRAM allocation, not the driver, so per-process
attribution is simply not available. Verified on this project's box:
RTX A5000, driver 580.97, every row `[Insufficient Permissions]` or `[N/A]`.

So per-process numbers are out. What works everywhere is the DELTA METHOD:

    measure total -> start the component -> measure total -> difference

with two consequences you must respect or the number is fiction:

  1. Your desktop is using VRAM too. Browsers, photo viewers and the compositor
     all hold allocations, and they move while you measure. Always record the
     baseline alongside the delta, never the delta alone.
  2. Resting footprint is not the number that decides whether it fits. A model
     that idles at 1.3GB can spike well above that during inference. Fitting in
     8GB is decided by the PEAK under real work, so `probe` drives a real
     request and samples throughout.
  3. CACHES WILL SILENTLY MEASURE NOTHING. Most of these servers cache
     generated audio and video by a hash of the input text. Probe twice with
     the same sentence and the second run returns in ~0ms having touched no
     GPU at all, which reads as "this component is free". Every probe must use
     a string that has never been sent to that service before. If a run comes
     back implausibly fast with a near-zero delta, suspect a cache hit before
     you believe the number.

USAGE
-----
    python vram.py baseline --seconds 10
    python vram.py probe --url http://127.0.0.1:7896/tts --json "{...}"
    python vram.py --out results.json probe --label tts --url ... --json ...

Output is ASCII-only on purpose: this gets run in PowerShell and cmd, where a
non-UTF-8 code page turns unicode in stdout into a crash rather than a warning.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

SAMPLE_MS = 100


def gpu_info():
    """Static facts about the card. Recorded with every result: a VRAM number
    without the card and driver it came from is not reproducible."""
    q = "name,memory.total,driver_version"
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=" + q, "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=15)
    if out.returncode != 0:
        raise SystemExit("nvidia-smi failed. Is an NVIDIA driver installed?\n" + out.stderr)
    name, total, driver = [s.strip() for s in out.stdout.strip().splitlines()[0].split(",")]
    return {"gpu": name, "vram_total_mib": int(total), "driver": driver}


class Sampler:
    """Streams memory.used from a single long-lived nvidia-smi.

    One process with -lms, not a subprocess per sample: spawning nvidia-smi
    costs 50-100ms on Windows, which would put the sample interval on the same
    order as the thing being measured and make the peak unreliable.
    """

    def __init__(self, interval_ms=SAMPLE_MS):
        self.interval_ms = interval_ms
        self.samples = []
        self._proc = None
        self._thread = None
        self._stop = threading.Event()

    def _read(self):
        for line in self._proc.stdout:
            if self._stop.is_set():
                break
            line = line.strip()
            if line.isdigit():
                self.samples.append((time.monotonic(), int(line)))

    def __enter__(self):
        self._proc = subprocess.Popen(
            ["nvidia-smi", "--query-gpu=memory.used",
             "--format=csv,noheader,nounits", "-lms=" + str(self.interval_ms)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()
        # Let a few samples land so `first` is never empty on fast workloads.
        time.sleep(self.interval_ms / 1000 * 3)
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def stats(self):
        if not self.samples:
            return None
        vals = [v for _, v in self.samples]
        return {"n": len(vals), "min_mib": min(vals), "max_mib": max(vals),
                "first_mib": vals[0], "last_mib": vals[-1]}


def cmd_baseline(args):
    """What the machine is holding with your stack stopped.

    Run this with every AI service shut down. It is the number every later
    delta subtracts, and it is NOT zero - see the module docstring.
    """
    info = gpu_info()
    print("GPU: %s  total %d MiB  driver %s"
          % (info["gpu"], info["vram_total_mib"], info["driver"]))
    print("Sampling %ss ..." % args.seconds)
    with Sampler() as s:
        time.sleep(args.seconds)
        st = s.stats()
    if not st:
        raise SystemExit("no samples collected")
    print("baseline: min %d  max %d MiB  (n=%d)" % (st["min_mib"], st["max_mib"], st["n"]))
    print("\nNOTE: this is the desktop plus anything else on the card. Report it "
          "next to every delta; a delta on its own is not reproducible.")
    rec = {"kind": "baseline", "label": args.label}
    rec.update(info)
    rec.update(st)
    return rec


def cmd_probe(args):
    """Drive one real request and sample VRAM across it.

    The peak here - not the resting footprint - is what decides whether the
    component fits on a smaller card.
    """
    info = gpu_info()
    body = args.json.encode("utf-8") if args.json else None
    method = args.method or ("POST" if body else "GET")
    req = urllib.request.Request(
        args.url, data=body,
        headers={"Content-Type": "application/json"}, method=method)
    for h in args.header:
        name, _, value = h.partition(":")
        req.add_header(name.strip(), value.strip())

    print("GPU: %s  total %d MiB  driver %s"
          % (info["gpu"], info["vram_total_mib"], info["driver"]))
    print("probe: %s %s" % (method, args.url))

    with Sampler() as s:
        idle = s.stats()
        t0 = time.monotonic()
        status, err, nbytes = None, None, 0
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as r:
                status = r.status
                nbytes = len(r.read())
        except urllib.error.HTTPError as e:
            status = e.code
            err = e.read()[:200].decode("utf-8", "replace")
        except Exception as e:                      # report, do not crash the run
            err = "%s: %s" % (type(e).__name__, e)
        wall = time.monotonic() - t0
        # Models release lazily; keep sampling so the peak is not clipped.
        time.sleep(args.settle)
        st = s.stats()

    idle_mib = idle["last_mib"] if idle else None
    peak = st["max_mib"]
    delta = (peak - idle_mib) if idle_mib is not None else None
    print("  http %s  %d bytes  wall %.2fs" % (status, nbytes, wall))
    if err:
        print("  error: %s" % err)
    print("  idle-before %s MiB   peak %d MiB   delta +%s MiB"
          % (idle_mib, peak, delta))

    return {"kind": "probe", "label": args.label, "url": args.url,
            "gpu": info["gpu"], "vram_total_mib": info["vram_total_mib"],
            "driver": info["driver"], "http_status": status,
            "wall_s": round(wall, 3), "idle_before_mib": idle_mib,
            "peak_mib": peak, "delta_mib": delta, "error": err, "samples": st}


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--out", help="append the result to this JSON file")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("baseline", help="idle VRAM at some known stack state")
    b.add_argument("--seconds", type=float, default=10)
    b.add_argument("--label", default="unlabelled",
                   help="what was running when you took this, e.g. "
                        "'desktop-only' or 'tts-loaded-warm'. A row of MiB with "
                        "no record of what was up is not a measurement.")
    b.set_defaults(fn=cmd_baseline)

    pr = sub.add_parser("probe", help="drive one request, report peak VRAM")
    pr.add_argument("--label", default="unlabelled")
    pr.add_argument("--url", required=True)
    pr.add_argument("--json", help="request body (a JSON string)")
    pr.add_argument("--method")
    pr.add_argument("--header", action="append", default=[], metavar="NAME:VALUE",
                    help="extra request header; repeatable. Use for whatever "
                         "auth your service wants - the header name is not "
                         "standardised across these projects.")
    pr.add_argument("--timeout", type=float, default=300)
    pr.add_argument("--settle", type=float, default=2.0,
                    help="keep sampling this long after the response")
    pr.set_defaults(fn=cmd_probe)

    args = p.parse_args()
    rec = args.fn(args)
    rec["measured_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    # ⚠️ A failed request is not a measurement. This used to stamp
    # "first-party" unconditionally, including on rows that were HTTP 500 -
    # so an error-path latency sat in the data file wearing the same
    # provenance tag as a real reading, and the docs say every row is tagged
    # with its provenance. Distinguish them.
    #
    # ⚠️⚠️ ONLY A ROW THAT ATTEMPTED A REQUEST CAN HAVE FAILED ONE.
    #
    # The first version of this guard was `rec.get("http_status") is not None
    # and 2xx`. A baseline makes no HTTP request and therefore carries no
    # `http_status` at all, so that condition was False for every baseline ever
    # recorded and stamped each of them "FAILED - not a measurement".
    #
    # It reached the committed evidence. Two rows in bench/results.json - the
    # desktop baseline and the loaded reading that the 8 GB tier result is the
    # difference between - carried that tag while the documents cited them as
    # "recorded" and invited the reader to check the file. The repository's
    # headline finding was stamped a failure by the repository's own tool, and
    # a stranger's very first `vram.py baseline` would have been too.
    #
    # A guard that fails closed is right. A guard that fails closed on the
    # wrong axis is worse than none, because it destroys good data quietly.
    made_request = "http_status" in rec
    ok = (not made_request) or (rec["http_status"] is not None
                                and 200 <= rec["http_status"] < 300)
    rec["provenance"] = "first-party" if ok else "FAILED - not a measurement"
    if args.out:
        data = []
        if os.path.exists(args.out):
            with open(args.out, encoding="utf-8") as f:
                data = json.load(f)
        data.append(rec)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print("\nappended to %s" % args.out)


if __name__ == "__main__":
    sys.exit(main())
