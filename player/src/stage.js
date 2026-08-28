import { whenPaintable, afterFirstFrame, crossfade, promote, retire, play } from './handover.js';
import { MoodPicker, defaultIsStill } from './picker.js';
import { SpeakQueue } from './queue.js';

/**
 * Double-buffered playback over a pivot-frame clip library.
 *
 * THE PRECONDITION, and it is not optional: every clip must begin and end on
 * the same frame - the pivot. Then any clip can follow any clip and the join is
 * two identical frames. Without that, none of this helps; see docs/05-assets.md
 * for how to verify your library actually satisfies it.
 *
 * Two <video> elements take turns. One is in front and playing, the other
 * preloads what comes next. A single element changing src shows a blank frame
 * while the new source loads, and there is no way around that with one element.
 *
 * ★ EVERY DEFECT HAPPENS AT A HANDOVER. That is the single most useful thing to
 * know here: the highest-leverage change is not making handovers safer, it is
 * having fewer of them. Replaying the same clip in place skips the entire path
 * - no src change, no waiting for a frame, no crossfade - and takes a ~30 s
 * idle cycle from about 5 handovers down to 2.
 */
export class PivotStage {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.a  - first buffer
   * @param {HTMLVideoElement} opts.b  - second buffer
   * @param {HTMLElement} [opts.poster] - still image of the pivot frame, behind both
   * @param {number} [opts.reactionFadeMs=0] - fade between library clips
   * @param {number} [opts.speechFadeMs=200] - fade after a clip that ended anywhere
   */
  constructor({
    a, b, poster,
    isStill = defaultIsStill,
    reactionFadeMs = 0,
    speechFadeMs = 200,
    holdMinS = 5, holdMaxS = 10,
    rng = Math.random,
  }) {
    this.a = a;
    this.b = b;
    this.poster = poster;
    /**
     * ⚠️ Library clips hard-cut; speech clips fade. Both are correct, and the
     * difference is measurable.
     *
     * Library clips are aligned by construction - measured across 65 clips, the
     * largest first/last deviation from the pivot was 4.6 out of 255. At that
     * alignment a hard cut is invisible, and a 120 ms fade at 24 fps
     * superimposes three frames in which the outgoing clip is mid-motion and
     * the incoming one is at rest: ghosting on the eyes and mouth, plus the
     * previous action appearing to be cut off. Three separate user reports, all
     * fixed by REMOVING the fade.
     *
     * A speech clip's length is set by its audio, so it ends on an arbitrary
     * frame of its source - and a source clip's middle can sit 16.75 away from
     * the pivot when only its first 9 and last 6 frames are within 5. Hard
     * cutting from there is the "it cuts before the motion finishes" complaint.
     *
     * Rule: hard cut when both sides are aligned by construction, fade when one
     * side can end anywhere.
     */
    this.reactionFadeMs = reactionFadeMs;
    this.speechFadeMs = speechFadeMs;

    this.front = 'a';
    this.playing = null;
    this.pool = [];
    this.queue = new SpeakQueue();
    this.broken = new Set();
    this.picker = new MoodPicker({ isStill, holdMinS, holdMaxS, rng });
    this.picker.markBroken(this.broken);
    this.posterOn = false;
    this.pending = null;
    /**
     * ⚠️ The element a handover is in flight to. The preloader must never
     * touch it.
     *
     * Handover completes inside an async callback. During that window the
     * preloader still computes "the back element" from the old front, which is
     * exactly the element about to become front - and replaces its source. The
     * handover then lands on an element with no picture.
     *
     * ⚠️ And it must stay set until the swap has actually been committed, not
     * merely requested. Clearing it too early leaves a window where the
     * preloader overwrites the clip that just started playing - the symptom is
     * a clip jumping to another clip's first frame mid-motion.
     */
    this.handingTo = null;
    this.listeners = {};

    for (const el of [a, b]) {
      el.playsInline = true;
      el.preload = 'auto';
      el.addEventListener('ended', (e) => this._onEnded(e));
      el.addEventListener('error', (e) => this._onError(e));
    }
    a.style.opacity = '1';
    b.style.opacity = '0';
  }

  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
    return this;
  }

  _emit(evt, ...args) {
    for (const fn of this.listeners[evt] || []) fn(...args);
  }

  /** Set the rotation pool. Safe to call at any time. */
  setPool(clips) {
    this.pool = clips.slice();
  }

  /**
   * Hand in the host's speak list. Idempotent; call whenever it changes.
   *
   * ⚠️ Pass `{ fresh: true }` to start a NEW turn with clips that may have been
   * spoken before.
   *
   * The queue keeps a `consumed` set so that a host re-syncing its list while a
   * clip is in flight cannot resurrect something already said - a real hazard,
   * because that sync is asynchronous. But it makes the plain call a no-op when
   * the new list happens to contain clips from an earlier turn, and a demo with
   * a fixed set of canned answers hits that on the second click of the same
   * question: nothing plays, the buttons stay disabled and the transcript sits
   * on "typing..." forever. Observed exactly that way.
   *
   * The two cases look identical from inside the queue and only the caller can
   * tell them apart, so the caller says which one this is.
   */
  setSpeakQueue(items, { fresh = false } = {}) {
    if (fresh) this.queue.reset();
    this.queue.sync(items);
    this._preload();
  }

  /**
   * Cut to a speak queue NOW, without waiting for the current clip to finish.
   *
   * ⚠️ `setSpeakQueue` alone does not do this, and the difference is the whole
   * feel of the thing. The queue is only consulted at the next handover, so a
   * clip that has just started holds the floor for its full length first —
   * measured here, up to 5 s of the character sitting there after the user has
   * already asked. On a page where everything is pre-rendered that reads as the
   * system being slow, when nothing is happening at all.
   *
   * Pausing the current element and calling the ended path directly is exactly
   * what the error path already does, and it is safe for the same reason: that
   * function's guards are skipped when it is invoked with no event, because the
   * caller has decided the clip is over.
   */
  speakNow(items) {
    this.queue.reset();
    this.queue.sync(items);
    const cur = this._frontEl();
    if (cur) {
      try { cur.pause(); } catch { /* some browsers refuse; harmless */ }
      this.playing = cur.dataset.src || this.playing;
    }
    this._onEnded();
  }

  start() {
    if (this.playing) return;
    const first = this.queue.head(this.broken) || this.picker.pick(this.pool, null, true);
    if (!first) return;
    const el = this.a;
    this.playing = first;
    el.src = first;
    el.dataset.src = first;
    el.muted = this.queue.head(this.broken) !== first;
    play(el, { onBlocked: () => this._emit('blocked') });
    // Attach the poster only once a real frame exists.
    //
    // ⚠️ Not before. If your opening clip fades in from black, a poster present
    // from the start reads as "subject sitting there -> cut to black -> fade
    // in", which is worse than the flash it was added to prevent.
    /**
     * ⚠️ Show the backdrop immediately IF it has an image, and only defer it if
     * it does not.
     *
     * The backdrop is the pivot frame. It sits behind both video layers, so any
     * moment neither of them has a frame to draw shows it instead of the page
     * background — which is the difference between an invisible hiccup and a
     * black flash. Deferring it until the first video frame leaves exactly that
     * gap open at page load, when it is most likely: measured, the stage was
     * the page's background colour until the first clip painted.
     *
     * The deferral exists for the case where there is no backdrop image at all,
     * or where the opening clip fades in from black — then a backdrop present
     * from the start reads as "subject sitting there -> cut to black -> fade
     * in", which is worse than the flash it was added to prevent.
     */
    const hasBackdrop = !!(this.poster && this.poster.getAttribute('src'));
    if (this.poster) this.poster.style.display = hasBackdrop ? '' : 'none';
    if (hasBackdrop) {
      this.posterOn = true;
    } else {
      afterFirstFrame(el, () => {
        this.posterOn = true;
        if (this.poster) this.poster.style.display = '';
      });
    }
  }

  _frontEl() {
    return this.front === 'a' ? this.a : this.b;
  }

  _backEl() {
    return this.front === 'a' ? this.b : this.a;
  }

  _preload() {
    const back = this._backEl();
    if (!back || back === this.handingTo) return;
    const head = this.queue.head(this.broken) === this.playing
      ? this.queue.items.find((u) => u !== this.playing && !this.broken.has(u))
      : this.queue.head(this.broken);
    const url = head
      || (!back.dataset.src || back.dataset.src === this.playing
        ? this.picker.pick(this.pool, this.playing, false)   // speculative: not committed
        : null);
    if (!url || back.dataset.src === url) return;
    back.dataset.src = url;
    back.src = url;
    back.muted = true;
    back.load();
  }

  _next() {
    const head = this.queue.head(this.broken);
    if (head) return head;
    return this.picker.pick(this.pool, this.playing, true);
  }

  _onEnded(e) {
    const src = e?.currentTarget || null;

    /**
     * ⚠️ Only the element that is actually playing may trigger a handover.
     *
     * `ended` is attached to BOTH elements. The background one fires it too -
     * after a preload, or after it was faded out mid-clip - and an unguarded
     * handler then cuts the foreground off mid-motion and jumps to a rotation
     * clip. Users reported exactly that: an action "cut off before it finished".
     *
     * ⚠️ Compare by CONTENT, not by a state variable. An earlier version
     * compared against a reference to "the front element", which is updated
     * asynchronously - so in the window where the swap had happened but the
     * reference had not caught up, the background element's `ended` was
     * accepted as the foreground's.
     *
     * ⚠️ This bug was latent for weeks and became constant the day the
     * outgoing element started lingering 400-540 ms longer, waiting for the
     * incoming frame. A fix for one defect turned a rare race into the common
     * case. That is worth remembering when a long-quiet bug suddenly appears.
     */
    if (src && this.playing && src.dataset.src !== this.playing) return;

    if (src && defaultIsStill(src.currentSrc || '')) {
      this.picker.noteStillDuration(src.duration);
    }

    /**
     * ⚠️ And it must actually have finished.
     *
     * A guard that holds regardless of who called. After four user reports of
     * clips being cut short, every suspected path had been checked and
     * exonerated - which meant there was a path nobody had thought of. Rather
     * than keep guessing, refuse to act when the premise is false: this
     * function means "the clip ended", so require that.
     *
     * ⚠️ The `ended` flag outranks currentTime. After a stall, currentTime lags
     * duration but the browser still sets `ended` - that is it telling you the
     * clip is over. Checking only currentTime rejects a legitimate finish and
     * the player stops forever.
     *
     * ⚠️ The error path calls this with no event, and skips the guard on
     * purpose: an unloadable clip should be replaced immediately.
     */
    if (src && !src.ended && Number.isFinite(src.duration) && src.duration > 0
        && src.currentTime < src.duration - 0.3) return;

    const finished = this.playing;
    const wasSpeaking = finished && this.queue.head(this.broken) === finished;
    if (wasSpeaking) {
      this.queue.consume(finished);
      this._emit('spoken', finished);
    }

    const next = this._next();
    if (!next) return;

    const cur = this._frontEl();

    /**
     * ★ The zero-handover path. If the next clip is the one already playing,
     * rewind the same element. No src change, no paint wait, no crossfade -
     * every failure mode in this file is skipped. Only possible because the
     * pivot invariant makes the loop point seamless.
     */
    if (cur && cur.dataset.src === next) {
      this.playing = next;
      try { cur.currentTime = 0; } catch { /* some browsers refuse; harmless */ }
      play(cur, { onBlocked: () => this._emit('blocked') });
      if (wasSpeaking && this.queue.length === 0) this._emit('idle');
      return;
    }

    const back = this._backEl();
    if (!back) return;
    if (back.dataset.src !== next) {
      back.src = next;
      back.dataset.src = next;
      back.load();
    }
    this.playing = next;
    const speaking = this.queue.head(this.broken) === next;
    back.muted = !speaking;

    this.pending?.();
    this.handingTo = back;
    this.pending = whenPaintable(back, 0, () => {
      this.pending = null;
      /**
       * ⚠️ Order: confirm the picture, then play, then hand over. An earlier
       * version played first and only delayed the crossfade - so audio started
       * while the picture was still the previous clip, and the mouth did not
       * match the sound.
       */
      /**
       * ⚠️ play() FIRST, then wait for the frame. This order is not a style
       * choice and getting it backwards is invisible in review.
       *
       * `requestVideoFrameCallback` only fires while the element is playing.
       * Calling afterFirstFrame on a paused element can therefore never resolve
       * through it - every handover fell through to its 400 ms timeout and
       * promoted the element whether or not it had a picture.
       *
       * Measured in the demo, with the composite sampled every animation frame:
       *   - 3 frames where the top element had readyState 0-1, i.e. nothing to
       *     draw. A video element with no frame is transparent, so the player
       *     showed its own background. That is the black flash.
       *   - 46 frames - 770 ms - showing a frozen first frame while the
       *     OUTGOING clip's audio was still playing underneath.
       *
       * The concern that originally put afterFirstFrame first was "audio starts
       * before the picture swaps". That is now bounded by one presented frame
       * instead of a fixed 400 ms, and crossfade() no longer hides the outgoing
       * element until the incoming one has painted - so nothing is given up.
       */
      const intoSpeech = speaking;
      const fadeMs = (wasSpeaking || intoSpeech)
        ? this.speechFadeMs : this.reactionFadeMs;
      if (cur && fadeMs <= 0) {
        // Hard cut: on top immediately, outgoing left underneath until a frame
        // has actually been presented. See promote() for why this order and not
        // the other one.
        promote(back, cur);
        play(back, { onBlocked: () => this._emit('blocked') });
        afterFirstFrame(back, () => retire(cur));
      } else {
        // Fade: start it in the same tick as play(). No wait is needed and
        // waiting is actively harmful - crossfade() holds the outgoing element
        // fully opaque underneath for the whole dissolve, so an incoming
        // element with no frame yet is simply transparent and the viewer keeps
        // seeing the outgoing one. Waiting for a presented frame first only
        // delays the picture while the audio has already started.
        play(back, { onBlocked: () => this._emit('blocked') });
        if (cur) crossfade(back, cur, fadeMs);
      }
      this.front = this.front === 'a' ? 'b' : 'a';
      this.handingTo = null;
      this._preload();

      if (speaking) {
        /**
         * ⚠️ Announce the start on the `playing` event, not after calling
         * play(). play() is async and can be refused; announcing early makes
         * captions appear while the clip is silent. The timeout is a floor so
         * captions can never fail to appear at all.
         */
        let fired = false;
        const fire = () => {
          if (fired) return;
          fired = true;
          clearTimeout(safety);
          back.removeEventListener('playing', fire);
          const ms = Number.isFinite(back.duration) ? back.duration * 1000 : 0;
          this._emit('speakstart', next, ms);
        };
        const safety = setTimeout(fire, 1200);
        back.addEventListener('playing', fire, { once: true });
        if (!back.paused && back.currentTime > 0) fire();
      }
    });

    /**
     * ⚠️ Fires when the queue is EMPTY, not when one item remains.
     *
     * The code this was extracted from used `<= 1`, which emits once while the
     * final clip is still playing and again when it finishes - two `idle`
     * events per turn. Reading the code did not reveal that; running the demo
     * did, which is the argument for having a demo.
     *
     * If you want to know that the last clip has STARTED - to wind something
     * down early - use `speakstart` and compare against your own queue length.
     * That is a different event and it should look like one.
     */
    if (wasSpeaking && this.queue.length === 0) this._emit('idle');
  }

  /**
   * ⚠️ An unloadable clip must be skipped, not waited on.
   *
   * Measured: feed in a path that does not exist and the element reports
   * error.code 4 with readyState 0. `whenPaintable` then waits out its full
   * safety timeout and hands over anyway - and the foreground is now a blank
   * element that will never fire `ended`. The whole player is dead, silently.
   * With libraries of dozens of clips being regenerated and renamed, one bad
   * path is a matter of time.
   */
  _onError(e) {
    const el = e.currentTarget;
    const url = el.dataset.src || el.getAttribute('src') || '';
    if (!url) return;
    this.broken.add(url);
    this.queue.drop(url);           // never offer it again this turn

    /**
     * ⚠️ THE IN-FLIGHT CASE, which is the one that actually kills the player.
     *
     * The error fires as soon as the source fails to load - which is BEFORE the
     * handover to that element has completed, so it is not the front element
     * yet and a check for "is this the front?" says no. The old code then just
     * cleared the source and returned. Meanwhile the paint wait was still
     * running; its safety timeout expired, it handed over to the now-empty
     * element, and the player was left showing nothing, paused, with
     * readyState 0 - and no `ended` will ever fire to get it out.
     *
     * Reproduced exactly that way: front element hidden at opacity 0, back
     * element promoted with error.code 4 and nothing to draw. The demo caught
     * this; reading the code did not, twice.
     *
     * So cancel the pending handover before doing anything else.
     */
    if (el === this.handingTo) {
      this.pending?.();
      this.pending = null;
      this.handingTo = null;
      el.removeAttribute('src');
      delete el.dataset.src;
      // The clip we were moving to is gone, so `playing` is now a lie. Point it
      // back at what is actually on screen, then choose again from scratch.
      const front = this._frontEl();
      this.playing = front?.dataset.src || null;
      this._onEnded();
      return;
    }

    if (el === this._frontEl()) this._onEnded();
    else {
      el.removeAttribute('src');
      delete el.dataset.src;
    }
  }

  /** Interrupt: stop speaking now and return to the rotation. */
  interrupt() {
    const cur = this._frontEl();
    const back = this._backEl();
    if (!cur || !back) return;
    this.queue.reset();
    const next = this.picker.pick(this.pool, this.playing, true);
    if (!next) return;

    cur.pause();
    if (back.dataset.src !== next) {
      back.src = next;
      back.dataset.src = next;
      back.load();
    }
    back.muted = true;
    this.playing = next;

    this.pending?.();
    this.handingTo = back;
    this.pending = whenPaintable(back, 0, () => {
      this.pending = null;
      play(back, { onBlocked: () => this._emit('blocked') });
      // Always fade here. The tempting optimisation is to cut to the same
      // timestamp of the clip the speech was generated from, which is seamless
      // - but only while there is exactly one such clip. Once the server picks
      // among several, the client cannot know which one was used, and the
      // assumption fails by making the body jump. A short fade costs little and
      // is always correct.
      afterFirstFrame(back, () => crossfade(back, cur, this.speechFadeMs));
      this.front = this.front === 'a' ? 'b' : 'a';
      this.handingTo = null;
    });
  }

  destroy() {
    this.pending?.();
    this.pending = null;
  }
}
