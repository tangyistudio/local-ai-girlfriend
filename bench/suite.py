"""The standard probe set, so two people's tables mean the same thing.

Ad-hoc curl commands do not produce comparable numbers. This file pins the
things that change the answer: which sentences, how many repeats, and how the
cache is defeated without contaminating the measurement.

THREE THINGS THIS FILE GETS RIGHT THAT THE OBVIOUS VERSION GETS WRONG
---------------------------------------------------------------------
All three were found by measuring, after the obvious version produced numbers
that were wrong in ways that looked plausible.

1. THE CACHE-BUSTER MUST NOT BE SPOKEN.
   These servers cache generated audio keyed on a hash of the request. The
   obvious fix is to append a unique token to the sentence. That token then
   gets READ ALOUD: appending a unix timestamp to a four-character sentence
   made the model speak ten extra digits, and since generation cost scales
   with AUDIO LENGTH rather than character count, the measured wall time went
   from 2.42s to 7.94s. The instrument inflated the reading 3.3x.

   Trailing whitespace does not work either - measured, not assumed: the same
   sentence with 3 and with 11 trailing spaces returned byte-identical audio
   in 0.01s, so the server normalises whitespace before hashing.

   What does work is varying a NON-TEXT field that is part of the cache key.
   Here that is `lead_ms`, the leading silence. Bumping it by a few ms changes
   the hash and changes the audio by only those few milliseconds of silence:
   probes at lead_ms 207 and 213 differed by exactly 192 bytes, which at
   16kHz 16-bit mono is exactly the 6ms of extra lead. Nothing else moved.

   If you port this to another server, find its equivalent knob. Read the
   cache key function; do not guess.

2. ONE RUN IS NOISE.
   Generation is not deterministic - the same sentence produced 32,302 and
   32,494 bytes on consecutive runs. And VRAM deltas are worse: one probe
   reported +88 MiB while returning in 0.00s from cache, meaning it did no GPU
   work at all and the 88 MiB was the desktop moving underneath the
   measurement. Single deltas are unreadable. Everything here repeats and
   reports the spread so you can see the noise floor rather than average it
   away.

3. RESIDENT COST IS NOT INFERENCE COST.
   For a model that is already loaded, the extra VRAM taken during inference
   sits in the same range as desktop noise. The number that decides whether a
   component fits on a smaller card is what it holds AT REST, and that can
   only be measured by stopping it and diffing - see `vram.py baseline` and
   docs/00-hardware.md. The probes here measure latency honestly and give an
   upper bound on activation memory; they do not size the model for you.

ENCODING
--------
Bodies are serialised with ensure_ascii=True, so pure ASCII escapes go over
the wire. Passing CJK text through a Windows shell whose code page is not
UTF-8 corrupts the bytes and the service answers 400 in a way that looks like
a broken service rather than an encoding problem.

USAGE
-----
    $env:GPU_SERVICE_SECRET="..."   # PowerShell
    python suite.py
    python suite.py --only tts-short --repeats 5
"""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VRAM = os.path.join(HERE, "vram.py")

# Short and long are both here because generation cost scales with AUDIO
# LENGTH, not character count: a 3-character sentence still produces roughly
# 2 seconds of audio and costs nearly what a 7-character one costs. A table
# built only from short sentences understates what a real reply costs.
SENTENCES = {
    "short": "今天好嗎",
    "long": "我今天把這一整套流程重新量了一次，想看看顯存到底花在哪裡。",
}

# Base leading silence in ms.
#
# ⚠️ This is seeded from the clock, and that is load-bearing. A fixed base plus
# the repeat index is unique WITHIN a run but identical ACROSS runs, so the
# second time you run the suite every probe is served from the cache your first
# run populated - measured, 3/3 hits at 0.00s. The buster has to be unique per
# RUN, not just per repeat.
#
# Using the clock is safe HERE only because lead_ms is silence and is never
# spoken. Do not seed a buster from the clock if it lands in the text: the
# first version of this file appended a unix timestamp to the sentence and the
# model read the digits aloud, inflating wall time 3.3x.
#
# ⚠️ KNOWN LIMITATION, and it bit us after the fix above.
# lead_ms is real silence prepended to the audio, so its usable range is small
# - a few hundred ms is fine, a hundred seconds is not. That caps this buster at
# a few hundred distinct keys, and running the suite six times in one session
# collided anyway: 3/3 TTS probes came back as cache hits while the lipsync
# probes in the same run (1,000,000 keys, see RATE_SEED) were all genuine.
#
# If you are benchmarking repeatedly, clear the service's cache between runs
# instead of relying on this. A buster whose value space is bounded by physics
# is a stopgap, not a solution.
LEAD_BASE = 200 + int(time.time()) % 400
RATE_SEED = int(time.time()) % 1000000

# Each service hashes a different set of fields, so each needs its own knob.
# `buster(i)` returns extra request fields that change the cache key without
# meaningfully changing the work. Read the server's key function to pick one;
# guessing produces silent cache hits, which read as "this component is free".
#
#   TTS      _key(text, lead_ms, sr)              -> lead_ms (leading silence)
#   lipsync  _out_path(src_key, voice, rate, text) -> rate (speech rate).
#            lead_ms is NOT in this key, which is how the first version of this
#            file got 2 of 3 lipsync runs served from cache.
#
# CARDINALITY MATTERS TOO. The second version varied rate over 12 integer
# percentages. That is unique within a run but collides across runs, and 6/6
# probes came back as hits. A buster needs a value space big enough that
# repeated runs do not collide - here a fractional rate string, which gives a
# million distinct keys. On the server we measured, `rate` happened to be a
# free knob: the TTS call ignored it and used hardcoded parameters, so varying
# it changed the cache key and nothing about the work. Yours may not be free -
# read the code path before assuming.
PROBES = {
    "tts-short": {"url": "http://127.0.0.1:7896/tts", "text": SENTENCES["short"],
                  "buster": lambda i: {"lead_ms": LEAD_BASE + 1 + i}},
    "tts-long": {"url": "http://127.0.0.1:7896/tts", "text": SENTENCES["long"],
                 "buster": lambda i: {"lead_ms": LEAD_BASE + 1 + i}},
    "lipsync-short": {"url": "http://127.0.0.1:7894/talk", "text": SENTENCES["short"],
                      "buster": lambda i: {"rate": "-8.%06d%%" % ((RATE_SEED + i) % 1000000)}},
    "lipsync-long": {"url": "http://127.0.0.1:7894/talk", "text": SENTENCES["long"],
                     "buster": lambda i: {"rate": "-8.%06d%%" % ((RATE_SEED + i) % 1000000)}},
}

WALL = re.compile(r"http (\d+)\s+(\d+) bytes\s+wall ([\d.]+)s")
PEAK = re.compile(r"idle-before (\d+) MiB\s+peak (\d+) MiB\s+delta \+?(-?\d+)")


def one(label, spec, i, secret, out, settle, auth_header):
    payload = {"text": spec["text"]}
    payload.update(spec["buster"](i))
    body = json.dumps(payload, ensure_ascii=True)
    cmd = [sys.executable, VRAM]
    if out:
        cmd += ["--out", out]
    cmd += ["probe", "--label", label, "--url", spec["url"],
            "--json", body, "--settle", str(settle)]
    if secret:
        cmd += ["--header", auth_header + ": " + secret]
    r = subprocess.run(cmd, capture_output=True, text=True)
    w = WALL.search(r.stdout)
    p = PEAK.search(r.stdout)
    if not w:
        return None, (r.stdout + r.stderr).strip()[-300:]
    status = int(w.group(1))
    # ⚠️ A non-2xx is not a measurement. vram.py prints the same
    # "http <n> <bytes> bytes wall <s>s" line for an error as for a success, so
    # without this check a service returning 500 in 2.3s produces a clean
    # "n=3 wall med 2.33s" with nothing to indicate anything failed. That
    # happened: five recorded rows were error-path latencies that read exactly
    # like successful timings.
    if not 200 <= status < 300:
        return None, "HTTP %d (not a measurement - error-path latency)" % status
    return {"status": status, "bytes": int(w.group(2)),
            "wall_s": float(w.group(3)),
            "delta_mib": int(p.group(3)) if p else None}, None


CACHE_HIT_S = 0.10


def summarise(label, rows):
    """Aggregate only the runs that did real work.

    ⚠️ An earlier version of this function printed a warning about cache hits
    and then averaged them in anyway. That is worse than not detecting them:
    two real runs at ~2.5s plus two cache hits at ~0.01s reported a median of
    1.21s, understating the true cost by 2x, under a line that said the hits
    had been caught. The warning made the number look audited.

    Cache hits are excluded from every statistic here. They are counted and
    reported separately, and if nothing real is left we refuse to print a
    number at all rather than print one from an empty or misleading sample.
    """
    real = [r for r in rows if r["wall_s"] >= CACHE_HIT_S]
    cached = [r for r in rows if r["wall_s"] < CACHE_HIT_S]

    if cached:
        print("  %-16s !! %d/%d run(s) returned under %d ms - CACHE HITS, no GPU "
              "work. EXCLUDED from the figures below. Your cache-buster is not "
              "working; see the PROBES comment."
              % ("", len(cached), len(rows), int(CACHE_HIT_S * 1000)))
    if not real:
        print("  %-16s NO USABLE RUNS - every probe was served from cache. "
              "No figure reported." % label)
        return

    walls = [r["wall_s"] for r in real]
    byts = [r["bytes"] for r in real]
    deltas = [r["delta_mib"] for r in real if r["delta_mib"] is not None]
    print("  %-16s n=%d%s  wall med %.2fs  (min %.2f max %.2f)  bytes med %d"
          % (label, len(real), ("/%d" % len(rows)) if cached else "",
             statistics.median(walls), min(walls), max(walls),
             statistics.median(byts)))
    if deltas:
        print("  %-16s VRAM delta med %+d MiB  (min %+d max %+d)  <- compare to "
              "your desktop noise floor before reading anything into this"
              % ("", statistics.median(deltas), min(deltas), max(deltas)))
    if len(deltas) < len(real):
        print("  %-16s note: %d/%d run(s) produced no VRAM reading and are "
              "excluded from the delta line"
              % ("", len(real) - len(deltas), len(real)))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.join(HERE, "results.json"))
    p.add_argument("--only", action="append", default=[])
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--secret", default=os.environ.get("GPU_SERVICE_SECRET", ""))
    # There is no convention for this across self-hosted inference servers -
    # every project invents its own header. Yours will not be this default.
    p.add_argument("--auth-header", default=os.environ.get("GPU_SERVICE_AUTH_HEADER",
                                                           "X-Auth-Secret"),
                   help="header name the shared secret is sent in "
                        "(default $GPU_SERVICE_AUTH_HEADER or X-Auth-Secret)")
    p.add_argument("--settle", type=float, default=1.5)
    args = p.parse_args()

    labels = args.only or list(PROBES)
    bad = [x for x in labels if x not in PROBES]
    if bad:
        raise SystemExit("unknown probe(s): %s\nknown: %s"
                         % (", ".join(bad), ", ".join(PROBES)))

    print("cache-buster: per-service, see PROBES (never the spoken text)")
    failed = 0
    for label in labels:
        print("\n=== %s ===" % label)
        rows, errs = [], []
        for i in range(args.repeats):
            row, err = one(label, PROBES[label], i,
                           args.secret, args.out, args.settle, args.auth_header)
            (rows if row else errs).append(row or err)
        if errs:
            failed += 1
            print("  %d/%d failed: %s" % (len(errs), args.repeats, errs[0]))
        if rows:
            summarise(label, rows)
    print("\n%d/%d probes had failures" % (failed, len(labels)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
