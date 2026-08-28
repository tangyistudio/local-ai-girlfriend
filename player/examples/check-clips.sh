#!/usr/bin/env bash
# Verify a clip library satisfies the pivot-frame invariant.
#
# The player is only correct if every clip begins and ends on the same frame.
# This checks that against real files, which is the difference between a repo
# that claims an invariant and one that has it.
#
# ⚠️ IT CHECKS EVERY CLIP AGAINST ONE SHARED REFERENCE, NOT AGAINST ITSELF.
#
# Comparing a clip's first frame to its own last frame proves it loops. It does
# NOT prove it joins the clip that follows it. A library can be full of clips
# that each loop perfectly and still have two incompatible families in it, and
# the per-clip check passes every one of them.
#
# That happened here twice. Once with clips carrying a different prefix that
# belonged to a second pivot family - internally consistent, 21/255 away from
# everything else. Once with rendered talking clips whose mouths came from a
# generator and idle clips whose mouths came from the source footage - the two
# mouths differ by 6.22 and the jaw steps at every join between the families.
# Both passed a per-clip check with room to spare.
#
# ⚠️ AND A WHOLE-FRAME MEAN HIDES A LOCAL CHANGE.
#
# A mouth is roughly one percent of a 432x774 frame. A completely different jaw
# moved the whole-frame mean from 2.75 to 3.19 - inside every threshold here -
# while the worst 12x12 block moved 13.4. The user could see it; the number
# could not. So this reports the WORST BLOCK as well as the mean, and judges on
# the worst block. No assumption about where the face is: whatever region
# actually changed is the region that gets reported.
#
# ⚠️ ONE REFERENCE PER LOOK, NOT ONE PER LIBRARY.
#
# Clips are grouped by the filename up to the first underscore, and each group is
# measured against its own first clip. A library holding two outfits holds two
# pivot frames and they are not supposed to match - measured 50.6 mean / 202
# worst-block between them, which is just what two different people look like.
# Checking across groups condemns every clip in the second outfit, which is what
# the first version of this did. Looks are switched deliberately, never
# mid-rotation, so they never have to join.
#
# ⚠️ THE REFERENCE IS A FRAME FROM THE LIBRARY, NOT A POSTER IMAGE.
#
# The obvious reference is the poster still. It was wrong: measured against the
# clips it is supposed to represent, one project's day-look poster sat 4.6 away
# from every single clip in that look, while the clips sat within 2.9 of each
# other. A separate render is a separate render. Default here is the first
# frame of the first clip; pass --ref to override.
#
# ⚠️ GRABBING THE LAST FRAME IS THE OTHER PART PEOPLE GET WRONG.
# `-sseof` alone can hand you a frame that is not the last one - it once
# produced 44 false findings in this project's source. Seek near the end,
# REVERSE, and take the first frame.
#
# ⚠️ THE METRIC IS MEAN ABSOLUTE DIFFERENCE, NOT "HOW MANY BYTES DIFFER".
# An earlier version counted differing bytes as a proportion. That works for
# flat synthetic shapes and is useless for real footage: lossy compression makes
# nearly every byte differ slightly, so it reported 82-91% for a library that
# was in fact aligned to within 3.35/255. It condemned every clip it was
# pointed at. The bug only appeared when real video was used, which is the whole
# argument for testing a tool against the thing it is for.
#
# USAGE
#     bash player/examples/check-clips.sh [dir] [--ref clip.mp4|frame.png]
set -uo pipefail

DIR=""
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    *) DIR="$1"; shift ;;
  esac
done
DIR="${DIR:-$(dirname "$0")/clips}"

# ⚠️ A RELATIVE temp dir, not mktemp -d.
#
# On Git Bash the usual /tmp/tmp.XXXX is an MSYS path that a native Windows
# Python cannot open - it reports FileNotFoundError on a file ffmpeg just
# wrote. The frame extraction succeeds, the comparison fails, and the table
# prints empty columns. Same family as the other Windows path traps in
# docs/08-ops.md. A relative path is understood by every tool here.
TMP="./.check-frames"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }
command -v python >/dev/null || PY=python3 ; PY="${PY:-python}"

shopt -s nullglob
clips=("$DIR"/*.mp4)
[ "${#clips[@]}" -gt 0 ] || { echo "no .mp4 clips found in $DIR"; exit 1; }

# Everything is compared at this size. Fixed, so the numbers are comparable
# across runs and across libraries.
W=216
H=387
SCALE="scale=$W:$H"

# group key = filename up to the first underscore ("a_still.mp4" -> "a")
group_of() { local b; b="$(basename "$1")"; case "$b" in *_*) echo "${b%%_*}";; *) echo "_";; esac; }

if [ -n "$REF" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$REF" -vf "$SCALE,select=eq(n\,0)"     -frames:v 1 -f rawvideo -pix_fmt gray "$TMP/ref__forced.raw" 2>/dev/null
  [ -s "$TMP/ref__forced.raw" ] || { echo "cannot read reference from $REF"; exit 1; }
fi

# One reference per group, taken from that group's first clip.
ref_for() {
  local g="$1" src="$2"
  if [ -n "$REF" ]; then echo "$TMP/ref__forced.raw"; return; fi
  if [ ! -s "$TMP/ref__$g.raw" ]; then
    ffmpeg -hide_banner -loglevel error -y -i "$src" -vf "$SCALE,select=eq(n\,0)"       -frames:v 1 -f rawvideo -pix_fmt gray "$TMP/ref__$g.raw" 2>/dev/null
    echo "$g -> $(basename "$src") frame 0" >> "$TMP/refs.txt"
  fi
  echo "$TMP/ref__$g.raw"
}

# Threshold from the source project: across 65 generated clips the largest
# deviation from the pivot was 4.6 out of 255, and hard cuts at that alignment
# are invisible. 5 is that, rounded up. The block threshold is deliberately
# looser than the mean because a block is a smaller sample of a noisier signal.
SEAMLESS=5
CLOSE=12
BLOCK_SEAMLESS=8
BLOCK_CLOSE=18

echo "checking ${#clips[@]} clip(s) in $DIR"
if [ -n "$REF" ]; then echo "reference: $(basename "$REF") frame 0 (forced)"; fi
echo
printf '%-16s %6s %14s %14s  %s\n' "clip" "fstart" "first mean/blk" "last mean/blk" "verdict"

fail=0
ends_elsewhere=0
for f in "${clips[@]}"; do
  name="$(basename "$f")"
  grp="$(group_of "$f")"
  refraw="$(ref_for "$grp" "$f")"

  # faststart: moov before mdat, or the browser must fetch the whole file
  # before it can paint - which the source project identified as its own cause
  # of "black flashes between segments". `strings` is absent on Git Bash, so
  # read bytes.
  if head -c 400 "$f" | grep -aq moov; then fs="ok"; else fs="MISSING"; fail=1; fi

  ffmpeg -hide_banner -loglevel error -y -i "$f" \
    -vf "$SCALE,select=eq(n\,0)" -frames:v 1 -f rawvideo -pix_fmt gray "$TMP/a.raw" 2>/dev/null
  ffmpeg -hide_banner -loglevel error -y -sseof -1 -i "$f" \
    -vf "reverse,$SCALE" -frames:v 1 -f rawvideo -pix_fmt gray "$TMP/b.raw" 2>/dev/null

  if [ ! -s "$TMP/a.raw" ] || [ ! -s "$TMP/b.raw" ]; then
    printf '%-16s %6s %14s %14s  %s\n' "$name" "$fs" "-" "-" "UNREADABLE"; fail=1; continue
  fi

  read -r fm fb lm lb <<EOF
$($PY -c "
W,H,B=$W,$H,12
ref=open(r'$refraw','rb').read()
def stats(path):
    d=open(path,'rb').read()
    n=min(len(ref),len(d))
    diff=[abs(ref[i]-d[i]) for i in range(n)]
    mean=sum(diff)/n if n else 999
    worst=0
    for by in range(0,H-B,B):
        for bx in range(0,W-B,B):
            s=0
            for y in range(B):
                row=(by+y)*W+bx
                s+=sum(diff[row:row+B])
            worst=max(worst,s/(B*B))
    return mean,worst
fm,fb=stats(r'$TMP/a.raw'); lm,lb=stats(r'$TMP/b.raw')
print('%.2f %.2f %.2f %.2f'%(fm,fb,lm,lb))
")
EOF

  verdict=$($PY -c "
m=max(float('$fm'),float('$lm')); b=max(float('$fb'),float('$lb'))
if m<=$SEAMLESS and b<=$BLOCK_SEAMLESS: print('seamless')
elif m<=$CLOSE and b<=$BLOCK_CLOSE:     print('close')
else:                                   print('ENDS ELSEWHERE')
")
  [ "$verdict" = "ENDS ELSEWHERE" ] && ends_elsewhere=1
  printf '%-16s %6s %7s/%-6s %7s/%-6s  %s\n' "$name" "$fs" "$fm" "$fb" "$lm" "$lb" "$verdict"
done

echo
[ -s "$TMP/refs.txt" ] && { echo "references used:"; sed 's/^/  /' "$TMP/refs.txt"; echo; }
if [ "$fail" -ne 0 ]; then
  echo "FAILED: a clip is unreadable or missing faststart."
  exit 1
fi

cat <<NOTE
Mean absolute difference from the reference frame, on a 0-255 scale, reported as
whole-frame mean / worst 12x12 block. Judged on the block.

  seamless          mean <= $SEAMLESS and block <= $BLOCK_SEAMLESS
  close             mean <= $CLOSE and block <= $BLOCK_CLOSE
  ENDS ELSEWHERE    anything worse - this clip cannot be hard cut

⚠️ Read the BLOCK column. A clip whose mean is 3.19 and whose worst block is
   13.4 has a completely different jaw and joins visibly. The mean alone said it
   was fine, and it was shipped that way.

⚠️ Passing is necessary, not sufficient. A clip can sit on the reference frame
   and still be wrong for the rest layer - see docs/05-assets.md, where an
   entire idle pool passed this check and none of it could be used as rest,
   because displacement was never measured.
NOTE

[ "$ends_elsewhere" -eq 0 ] || exit 1
exit 0
