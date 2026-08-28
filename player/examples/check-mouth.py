"""Fail a clip library when a silent clip moves its mouth.

WHY THIS EXISTS
---------------
A rotation clip carries no audio. If the mouth moves in one, the character sits
there mouthing words at the viewer in silence, and it is the single most
uncanny thing this player can do. A user spotted it within seconds of loading
the page; every automated check in this repository passed the same library.

They passed because they were all measuring the wrong thing. The pivot check
compares first and last frames, so a clip that opens its mouth in the MIDDLE
and closes it again by the end is perfect by that measure. Nothing looked at
what happened in between.

TWO INDEPENDENT MISTAKES PRODUCED IT, WHICH IS WHY ONE FIX WAS NOT ENOUGH
------------------------------------------------------------------------
1. **The sources were picked by filename.** A clip named `listening` measured
   jawOpen 0.52 - a wide-open reaction. A purpose-built base documented as
   "mouth closed throughout" measured 0.14 and visibly parts her lips mid-clip.
   Names describe intent; they do not measure it.

2. **The rotation clips inherited the talking clips' expression amplitude.** The
   lip-sync engine emits non-zero mouth motion even for silence, and amplitude
   multiplies it: the same base rendered silent measured 0.30 at amplitude 0.45
   and 0.43 at 1.20. Rotation clips have no speech, so their amplitude has
   nothing to do with the talking clips' and should never be copied from it.

After fixing both, the same nine clips measure 0.002-0.137.

WHAT IT MEASURES
----------------
`jawOpen`, a MediaPipe face blendshape. Not a proxy - the actual quantity. The
model is the same face landmarker already used to replace a non-commercial
detector on the inference path, so it introduces no new licence question.

⚠️ CALIBRATE THE THRESHOLD PER FACE. A character whose neutral expression has
slightly parted lips reads higher at rest than one with a closed mouth: two
faces here sit at 0.002 and 0.14 doing nothing at all. Measure your own rest
state first and judge against that, not against the number below.

DEPENDENCIES
    pip install mediapipe opencv-python numpy
and a face_landmarker.task model file (MediaPipe publishes one).

USAGE
    python player/examples/check-mouth.py 'player/examples/clips/*_still.mp4' \\
        --model path/to/face_landmarker.task
    python player/examples/check-mouth.py 'clips/*.mp4' --max 0.15
"""
import argparse
import glob
import os
import sys

# The rotation clips in this repository measure 0.002-0.137 and read as closed.
# A talking clip runs 0.3-0.75. 0.15 sits between them with room on both sides.
DEFAULT_MAX = 0.15


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("patterns", nargs="+", help="glob(s) of clips to check")
    ap.add_argument("--model", default="face_landmarker.task",
                    help="MediaPipe face_landmarker.task")
    ap.add_argument("--max", type=float, default=DEFAULT_MAX,
                    help="highest jawOpen a silent clip may reach")
    ap.add_argument("--every", type=int, default=3,
                    help="sample every Nth frame (default 3)")
    args = ap.parse_args()

    try:
        import cv2
        import numpy as np
        import mediapipe as mp
        from mediapipe.tasks.python import vision, BaseOptions
    except ImportError as e:
        print("missing dependency: %s\n"
              "  pip install mediapipe opencv-python numpy" % e)
        return 2

    if not os.path.exists(args.model):
        print("model not found: %s\n"
              "  MediaPipe publishes face_landmarker.task; pass --model" % args.model)
        return 2

    paths = []
    for p in args.patterns:
        paths.extend(sorted(glob.glob(p)))
    if not paths:
        print("no clips matched")
        return 2

    opts = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=args.model),
        output_face_blendshapes=True, num_faces=1,
        running_mode=vision.RunningMode.IMAGE)

    print("%-28s %8s %8s %8s   %s" % ("clip", "max", "p90", "mean", "verdict"))
    failed = []
    with vision.FaceLandmarker.create_from_options(opts) as lm:
        for path in paths:
            cap = cv2.VideoCapture(path)
            vals, i = [], 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if i % args.every == 0:
                    img = mp.Image(image_format=mp.ImageFormat.SRGB,
                                   data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                    r = lm.detect(img)
                    if r.face_blendshapes:
                        vals.append({b.category_name: b.score
                                     for b in r.face_blendshapes[0]}.get("jawOpen", 0.0))
                i += 1
            cap.release()

            name = os.path.basename(path)
            if not vals:
                # ⚠️ Not a pass. A clip whose face cannot be found has not been
                # checked, and reporting it as clean is how a defect ships.
                print("%-28s %8s %8s %8s   NO FACE FOUND" % (name, "-", "-", "-"))
                failed.append(name)
                continue

            v = np.array(vals)
            bad = v.max() > args.max
            print("%-28s %8.3f %8.3f %8.3f   %s"
                  % (name, v.max(), np.percentile(v, 90), v.mean(),
                     "MOUTH MOVES" if bad else "closed"))
            if bad:
                failed.append(name)

    print()
    if failed:
        print("FAILED: %d clip(s) over jawOpen %.2f — %s"
              % (len(failed), args.max, ", ".join(failed)))
        print("A silent clip with a moving mouth reads as the character mouthing")
        print("words at the viewer. Re-pick the source, or lower the expression")
        print("amplitude used for the silent render — both have caused it here.")
        return 1
    print("all %d clip(s) hold the mouth closed" % len(paths))
    return 0


if __name__ == "__main__":
    sys.exit(main())
