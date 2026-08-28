"""Pretend your card is smaller than it is, so you can test a tier you cannot buy.

WHY
---
Publishing "here is the config for an 8 GB card" while owning a 24 GB card is
how untested numbers get into circulation. This occupies a fixed amount of VRAM
and holds it, so everything else on the machine has to fit in what is left. An
8 GB tier on a 24 GB card means holding 15 GB of ballast and running the stack
in the remaining 9 GB, minus whatever the desktop already took.

WHAT THIS DOES AND DOES NOT PROVE
---------------------------------
It emulates CAPACITY. That is the constraint that decides whether a model loads
at all, whether the runtime silently offloads layers to the CPU, and whether an
allocator starts thrashing. Those are the failure modes people hit first, and
they are real here.

It does NOT emulate a different GPU. Memory bandwidth, core count, cache sizes,
tensor-core generation and driver behaviour all stay whatever your card has. A
config that fits under ballast will fit on the smaller card; it will not
necessarily run at the same SPEED. Report capacity results as tested and speed
results as untested unless you actually have the hardware.

It also does not emulate a smaller card's own overhead: the desktop compositor
on an 8 GB card behaves differently from one on a 24 GB card, and driver
reserves scale too. Treat the emulated ceiling as slightly optimistic.

USAGE
-----
Run in its own terminal and leave it open; it holds the memory until you stop
it with Ctrl-C.

    python ballast.py --hold-gib 15          # emulate ~8 GB on a 23 GB card
    python ballast.py --target-free-gib 16   # or: leave exactly this much free

Needs a torch build with CUDA. If your system Python has no torch, run it with
the interpreter from whichever service venv does - you do not need a separate
environment for this:

    /path/to/your-service/.venv/bin/python bench/ballast.py --hold-gib 15
"""
import argparse
import subprocess
import sys
import time


def gpu_mib():
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used,memory.total",
         "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=15)
    used, total = [int(x.strip()) for x in out.stdout.strip().splitlines()[0].split(",")]
    return used, total


def main():
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--hold-gib", type=float, help="occupy this much VRAM")
    g.add_argument("--target-free-gib", type=float,
                   help="occupy whatever it takes to leave this much free")
    p.add_argument("--recheck", type=float, default=30,
                   help="seconds between residency re-checks while holding")
    p.add_argument("--chunk-mib", type=int, default=256,
                   help="allocation granularity. Smaller chunks fit into a "
                        "fragmented card better but cost more allocator calls.")
    args = p.parse_args()

    import torch
    if not torch.cuda.is_available():
        raise SystemExit("no CUDA device visible to this torch build")

    used, total = gpu_mib()
    print("card: %d MiB total, %d MiB already in use" % (total, used))

    if args.hold_gib is not None:
        want_mib = int(args.hold_gib * 1024)
    else:
        # Everything currently allocated counts toward the emulated ceiling, so
        # the ballast is only the gap between the real card and the target.
        want_mib = total - int(args.target_free_gib * 1024) - used
        if want_mib <= 0:
            raise SystemExit(
                "nothing to do: only %d MiB is free, which is already at or "
                "below the %.1f GiB target" % (total - used, args.target_free_gib))

    print("holding %d MiB (%.1f GiB) in %d MiB chunks ..."
          % (want_mib, want_mib / 1024, args.chunk_mib))

    blocks = []
    held = 0
    # One tensor per chunk rather than a single huge allocation: a single
    # contiguous block can fail on a fragmented card even when the total is
    # available, which would make this tool report a smaller ceiling than the
    # card really has.
    per = args.chunk_mib * 1024 * 1024 // 2          # float16 = 2 bytes
    try:
        while held < want_mib:
            # ⚠️ .fill_() is load-bearing, not tidiness. torch.empty() reserves
            # the allocation without ever touching the pages, and on Windows
            # WDDM an untouched allocation is the driver's FIRST choice to
            # evict to system RAM when something else wants the card. That is
            # (this is ordinary WDDM eviction of untouched pages, NOT the
            # oversubscription mechanism docs/00-hardware.md withdraws - that
            # claim was about the driver silently spilling a live allocation
            # past physical VRAM, which we never measured) - which would mean
            # the tool built to emulate a smaller
            # card was itself made of the most evictable memory on it, and a
            # tier could pass "tested under ballast" while more than the target
            # was really available. Writing the pages makes them resident.
            blocks.append(torch.empty(per, dtype=torch.float16,
                                      device="cuda").fill_(1.0))
            held += args.chunk_mib
    except torch.cuda.OutOfMemoryError:
        print("  stopped early at %d MiB - the card would not give more" % held)

    torch.cuda.synchronize()
    used2, _ = gpu_mib()
    print("held %d MiB. card now %d/%d MiB used, %d MiB free."
          % (held, used2, total, total - used2))
    print("\n%.1f GiB is free. Anything you start now has to fit in that, the "
          "way it would on a smaller card." % ((total - used2) / 1024))
    print("Leave it running. Ctrl-C releases the memory.")

    # Re-check, do not just sleep. `held` is what we ASKED for; what matters is
    # what the card still reports minutes later, once the stack under test is
    # competing for memory. A ballast that has quietly been paged out turns
    # every "tested at this tier" claim into a claim about a larger card.
    floor = used2
    try:
        while True:
            time.sleep(args.recheck)
            now, _ = gpu_mib()
            if now < floor - args.chunk_mib:
                print("  !! card usage fell %d MiB below the startup level "
                      "(%d -> %d). The ballast may have been evicted - any "
                      "result gathered from now on is NOT at the target size."
                      % (floor - now, floor, now))
                floor = now
    except KeyboardInterrupt:
        print("\nreleasing")


if __name__ == "__main__":
    sys.exit(main())
