/**
 * The speak queue: clips that must play, in order, exactly once each.
 *
 * This looks trivial and is not. Both bugs below shipped, both were reported by
 * users, and the second was introduced by the fix for the first.
 */

export class SpeakQueue {
  constructor() {
    this.items = [];
    /**
     * Clips already played, so they can never be played again.
     *
     * ⚠️ WITHOUT THIS, THE SAME CLIP PLAYS THREE TIMES.
     *
     * The mechanism: when a clip ends you remove it locally and tell the host
     * application, which updates its own state. But that update is
     * asynchronous. Anything that re-syncs this queue from the host's state in
     * the meantime restores the clip you just finished - and it plays again.
     * The more state the host holds, the more often it happens.
     */
    this.consumed = new Set();
  }

  /**
   * Re-sync from the host's list.
   *
   * ⚠️ The second half of this is as important as the first, and it is the
   * part that was missing.
   *
   * Filtering by `consumed` stops the resurrection above. But if `consumed`
   * only ever grows, a clip can never be played twice in a whole session -
   * and for a pool of, say, ten filler lines, the eleventh request finds
   * nothing left and the character silently says nothing at all.
   *
   * Dropping entries the host no longer holds is safe: resurrection requires
   * the host to still be carrying the item, so once it is gone there is
   * nothing to resurrect and remembering it only costs you the pool.
   */
  sync(hostItems) {
    this.items = hostItems.filter((u) => !this.consumed.has(u));
    for (const u of Array.from(this.consumed)) {
      if (!hostItems.includes(u)) this.consumed.delete(u);
    }
  }

  /**
   * The next clip to play, skipping anything known to be unloadable.
   *
   * ⚠️ The broken filter belongs HERE, not only in the rotation picker. A
   * broken clip in the QUEUE was still returned as the head, so recovering
   * from the load error immediately chose the same broken clip again and the
   * player sat on the last frame of the previous one forever. The rotation
   * pool was filtered; the queue was not. Both need it.
   */
  head(broken) {
    if (!broken || !broken.size) return this.items[0];
    return this.items.find((u) => !broken.has(u));
  }

  /** Drop a clip entirely - used when it turns out not to be loadable. */
  drop(url) {
    this.items = this.items.filter((u) => u !== url);
    this.consumed.add(url);
  }

  /**
   * Mark the head as played.
   *
   * ⚠️ Remove it here, locally, BEFORE choosing what plays next. Telling the
   * host is not enough - that update has not landed yet, so the next pick sees
   * the old queue and replays the clip that just finished.
   */
  consume(url) {
    if (this.items[0] === url) this.items = this.items.slice(1);
    this.consumed.add(url);
  }

  /** A new turn. Forget what was played so the pool is available again. */
  reset() {
    this.consumed.clear();
  }

  get length() {
    return this.items.length;
  }
}
