#!/usr/bin/env bash
# Generate a demo clip library that satisfies the pivot-frame invariant.
#
# WHEN YOU HAVE NO ASSETS AT ALL
# ------------------------------
# The demo ships real character footage - see clips/MANIFEST.md. This script is
# the other path: if you have no clips and no way to generate any, it makes a
# valid pivot-frame library out of nothing but ffmpeg. No models, no GPU, no
# download.
#
# It is also the clearest way to SEE the invariant, because with flat shapes
# the first and last frames come out byte-identical rather than merely close.
# Real footage lands around 3/255 of the pivot - correct, and less obvious.
#
# ⚠️ Writes to clips-synthetic/ so it cannot overwrite the demo library.
#
# THE INVARIANT, ENFORCED BY CONSTRUCTION
# ---------------------------------------
# Every motion is sin() or cos() over a whole number of periods across the
# clip, so the last frame lands back on the first by construction rather than
# by luck. That is what a pivot frame is: the pose every clip departs from and
# returns to.
#
# ⚠️ Do not take that on trust - the point of this repo is that you check. See
# the verification commands printed at the end.
#
# USAGE
#     bash player/examples/make-clips.sh [outdir]   (default: player/examples/clips-synthetic)
set -euo pipefail

OUT="${1:-$(dirname "$0")/clips-synthetic}"
mkdir -p "$OUT"

W=480; H=480; FPS=24
BG="0x11151c"
SIZE=110

# ⚠️ An earlier version of this script drew circles with the `geq` filter and
# segfaulted ffmpeg outright. `drawbox` does the same job for a demo, is far
# simpler, and does not crash. Recorded because "the fancy filter crashed" is a
# thing worth knowing before you reach for it.
make () {
  local name="$1" dur="$2" x="$3" y="$4" col="$5"
  printf '  %-20s %4.1fs  ' "$name" "$dur"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=${BG}:s=${W}x${H}:r=${FPS}:d=${dur}" \
    -vf "drawbox=x='${x}':y='${y}':w=${SIZE}:h=${SIZE}:color=${col}:t=fill" \
    -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 \
    -movflags +faststart \
    "$OUT/$name" 2>/dev/null
  # ⚠️ -movflags +faststart is not optional. Without it the moov atom lands at
  # the end of the file and a browser must download the whole clip before it
  # can paint frame one. Measured elsewhere in this repo: 1.71 s for a 1.42 MB
  # clip against a 1.2 s player timeout, so every handover showed black. One
  # flag, and it is the highest-value thing on this command line.
  printf 'ok  %s\n' "$(du -h "$OUT/$name" | cut -f1)"
}

C=185   # centred position for a SIZE-wide box in a W-wide frame

echo "writing demo clips to $OUT"
echo

# The rest layer. Barely moves, and the player treats *_still.mp4 as the layer
# it returns to and replays in place between gestures.
#
# ⚠️ Its displacement must actually be far below the motion clips. A clip named
# "idle" that in fact moves as much as the gestures is the single most common
# way this architecture gets broken, and it is broken in the assets - three
# separate attempts to fix it in playback rules all failed. See docs/05-assets.md.
make "demo_still.mp4"  4.0 "${C}+3*sin(2*PI*t/4)"  "${C}"                      "0x3d4759"

# Motion clips, visibly distinct from each other and from rest.
make "demo_drift.mp4"  4.0 "${C}+120*sin(2*PI*t/4)" "${C}"                     "0x6ea8fe"
make "demo_bob.mp4"    4.0 "${C}"                   "${C}+110*sin(2*PI*t/4)"   "0x7ee2b8"
make "demo_sweep.mp4"  5.0 "${C}+130*sin(2*PI*t/5)" "${C}+70*sin(4*PI*t/5)"    "0xe8a33d"
make "demo_orbit.mp4"  6.0 "${C}+110*sin(2*PI*t/6)" "${C}+110*cos(2*PI*t/6)-110" "0xc98bdb"

echo
echo "Now verify the invariant instead of trusting it:"
echo
echo "  bash player/examples/check-clips.sh $OUT"
