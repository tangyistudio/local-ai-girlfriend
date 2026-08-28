/**
 * Choosing which clip plays next.
 *
 * Pure functions and one small stateful picker. Everything here is testable
 * without a DOM, which is deliberate: the rotation logic caused three separate
 * user-visible regressions and none of them needed a browser to reproduce.
 */

/** A clip is a "still" if it barely moves. Default: filename ends in _still. */
export const defaultIsStill = (url) => /_still\.[a-z0-9]+$/i.test(url);

/**
 * Rotation over a pool, avoiding the last two clips played.
 *
 * ⚠️ Excluding only the last one is not enough. With three candidates, random
 * choice produces A -> B -> A -> B ping-pong, which reads as a loop just as
 * clearly as a fixed order does. Observed in a browser: idle_2, idle_3, idle_2,
 * idle_3. Excluding the last two turns three candidates into an A -> B -> C
 * cycle - still a pattern, but a much less noticeable one.
 *
 * Falls back through progressively weaker exclusions so it can never return
 * undefined on a non-empty pool.
 */
export function pickOther(list, recent, rng = Math.random) {
  const [l1, l2] = recent;
  const tiers = [
    list.filter((u) => u !== l1 && u !== l2),
    list.filter((u) => u !== l1),
    list,
  ];
  const from = tiers.find((t) => t.length) || list;
  return from[Math.floor(rng() * from.length)];
}

/**
 * Idle rotation as two layers: a still clip to rest on, motion clips as
 * punctuation.
 *
 *     still -> still -> gesture -> still -> still -> idle_2 -> ...
 *
 * ⚠️ THREE EARLIER VERSIONS OF THIS WERE REJECTED, and the reasons are worth
 * carrying because they are not obvious:
 *
 *   1. "Repeat the chosen clip 3 times" - lands on a gesture and repeats that
 *      gesture three times. Worse than the churn it replaced.
 *   2. "Replay a quiet clip 5 times" - the joins were seamless, the CONTENT was
 *      not: the same breath and head movement five times running is obvious to
 *      anyone watching.
 *   3. "Rotate among quiet clips, gesture every 5th" - every quiet clip is
 *      still a switch. The complaint was not gesture density, it was switch
 *      density.
 *
 *   And the real cause was none of those: the clips labelled "idle" were not
 *   idle. Measured displacement 20-39 against 6.34 for a genuinely still one.
 *   Three attempts to fix an asset problem in the playback rules.
 *
 * ⚠️ Which is why `isStill` matters more than it looks. Verify it against a
 * displacement measurement, not against a filename you trust.
 *
 * ⚠️ `commit` is load-bearing. This function is called speculatively by the
 * preloader, and an early version advanced its counters on every call - so the
 * preload effect silently burned the rest interval and gestures fired
 * constantly. A function called speculatively MUST be pure unless told
 * otherwise.
 */
export class MoodPicker {
  constructor({ isStill = defaultIsStill, holdMinS = 5, holdMaxS = 10, rng = Math.random } = {}) {
    this.isStill = isStill;
    this.holdMinS = holdMinS;
    this.holdMaxS = holdMaxS;
    this.rng = rng;
    this.recent = [];
    this.holdLeft = 1;
    /**
     * Real duration of the still clip, used to convert "rest for N seconds"
     * into "replay it N times".
     *
     * ⚠️ Do not hard-code it. Two clips in one project measured 4.38 s and
     * 5.10 s, and an earlier version of one was 11.22 s - assuming 5 would
     * have produced a 22-second freeze. Feed the real duration back via
     * `noteStillDuration()` when a still clip ends.
     */
    this.stillSeconds = 5;
  }

  noteStillDuration(seconds) {
    if (seconds > 0 && Number.isFinite(seconds)) this.stillSeconds = seconds;
  }

  /** Clips known to be unloadable, excluded from every pool. */
  markBroken(set) {
    this.broken = set;
  }

  pick(pool, current, commit = false) {
    const usable = this.broken ? pool.filter((u) => !this.broken.has(u)) : pool;
    if (!usable.length) return null;
    if (usable.length === 1) return usable[0];

    const take = (url) => {
      if (commit) this.recent = [url, ...this.recent].slice(0, 2);
      return url;
    };

    const still = usable.filter(this.isStill);
    const motion = usable.filter((u) => !this.isStill(u));

    if (still.length && motion.length) {
      // Just finished a motion clip: go and rest, for a randomised interval.
      // Fixed intervals become an audible rhythm the same way a fixed order
      // becomes a visible one.
      if (current && !this.isStill(current)) {
        if (commit) {
          const target = this.holdMinS + this.rng() * (this.holdMaxS - this.holdMinS);
          this.holdLeft = Math.max(1, Math.round(target / this.stillSeconds)) - 1;
        }
        return take(still[0]);
      }
      // Still resting: return the clip already playing, so the caller takes the
      // replay-in-place path - no element swap, no waiting for a frame, no
      // crossfade, and therefore none of the failure modes that live there.
      //
      // ⚠️ Deliberately not through take(). A replay is not a switch, and
      // recording it in `recent` makes the next real pick think it just played.
      if (current && this.isStill(current) && this.holdLeft > 0) {
        if (commit) this.holdLeft -= 1;
        return current;
      }
      return take(pickOther(motion, this.recent, this.rng));
    }

    return take(pickOther(usable, this.recent, this.rng));
  }
}
