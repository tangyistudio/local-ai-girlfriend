/**
 * Handing over from one video element to another without showing black.
 *
 * This is the hard part, and every function here exists because of a specific
 * visible defect. The governing rule, from which all of it follows:
 *
 *     NEVER HIDE A FRAME YOU HAVE FOR A FRAME YOU DO NOT.
 *
 * The outgoing element is showing the pivot frame - the subject at rest.
 * Holding it 200 ms too long is invisible. Showing the page background for one
 * frame is not. So the condition for hiding the old element is always "the new
 * one has presented a frame", never a timer.
 *
 * See docs/06-playback.md for the measurements behind each constant.
 */

/**
 * Wait until `el` can actually paint, seeking to `at` first if needed.
 * Returns a cancel function.
 *
 * ⚠️ A video with readyState < 2 has nothing to draw. The element is
 * transparent, and handing over to it shows whatever is behind your player.
 * That is true right after a src change and again while a seek is in flight.
 *
 * The safety timeout is measured, not guessed. Clips of 1.29 MB and 1.42 MB
 * took 1.17 s and 1.71 s to become playable over a tunnel; an earlier 1200 ms
 * timeout was shorter than that, so it fired on every sentence and forced a
 * handover to an element with no picture. The root fix is at the encoder -
 * `-movflags +faststart`, so the moov atom is at the front and the first frames
 * are decodable from the first few KB. This timeout is the second line only.
 */
export function whenPaintable(el, at, cb, { timeoutMs = 3000 } = {}) {
  let done = false;
  let timer;

  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.removeEventListener('loadeddata', onData);
    el.removeEventListener('seeked', finish);
    cb();
  };

  const onData = () => {
    // Already at the target time - do not seek. A seek clears the current
    // picture, so seeking to where you already are costs you a frame.
    if (Math.abs(el.currentTime - at) < 0.05) return finish();
    el.addEventListener('seeked', finish, { once: true });
    try {
      el.currentTime = at;
    } catch {
      finish();
    }
  };

  timer = setTimeout(finish, timeoutMs);
  if (el.readyState >= 2) onData();
  else el.addEventListener('loadeddata', onData, { once: true });

  return () => {
    done = true;
    clearTimeout(timer);
    el.removeEventListener('loadeddata', onData);
    el.removeEventListener('seeked', finish);
  };
}

/**
 * Wait until a frame has actually been presented to the compositor.
 *
 * ⚠️ `loadeddata` is not this. It means the data for the current position is
 * decoded; it says nothing about whether the browser has drawn it. Hide the
 * outgoing element on `loadeddata` and you can still get one frame of nothing.
 *
 * `requestVideoFrameCallback` is the only API that reports actual presentation.
 * It fires only while playing, so call this AFTER play().
 *
 * ⚠️ The 400 ms cap cannot be raised much. This wait happens before playback
 * starts, so it costs latency on every sentence; and if it expires we simply
 * proceed, which is the behaviour we had before this function existed. Failing
 * open is correct here.
 *
 * ⚠️ Apply this in ONE place per handover. Wrapping the crossfade in it as well
 * once produced 400 + 400 + 140 ms of both layers visible at once - measured at
 * 997 ms - and users reported overlapping clips, which is the opposite of the
 * defect it was added to fix.
 */
export function afterFirstFrame(el, cb, { capMs = 400 } = {}) {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    cb();
  };

  if (typeof el.requestVideoFrameCallback === 'function') {
    el.requestVideoFrameCallback(fire);
  } else {
    // No rVFC: two consecutive rAFs guarantee at least one completed compositing
    // cycle. Weaker, but far better than not waiting.
    requestAnimationFrame(() => requestAnimationFrame(fire));
  }
  setTimeout(fire, capMs);
}

/**
 * Put `incoming` on top WITHOUT hiding `outgoing`.
 *
 * ⚠️ This is the hard-cut path and the order is the whole trick. A video
 * element with no decoded frame is transparent, so promoting it early is free:
 * until it paints, the viewer sees the outgoing element through it, and the
 * moment it paints it covers. Nothing is ever hidden before its replacement
 * exists, which is the rule at the top of this file.
 *
 * The alternative - wait for a presented frame, then swap - cannot work, and
 * measuring is the only way to find that out. `requestVideoFrameCallback` fires
 * only for an element that is actually being composited, and an element at
 * opacity 0 is not. So waiting on a hidden element always falls through to the
 * timeout: measured 18 animation frames (~300 ms) in which the outgoing clip
 * was frozen on screen while the incoming one's AUDIO was already running. The
 * mouth does not match the sound for a third of a second.
 *
 * Promote first, then play, then call `retire` once a frame has been presented.
 */
export function promote(incoming, outgoing) {
  cancelHide(incoming);
  cancelHide(outgoing);
  outgoing.style.zIndex = '0';
  outgoing.style.transition = '';
  outgoing.style.opacity = '1';
  incoming.style.zIndex = '1';
  incoming.style.transition = '';
  incoming.style.opacity = '1';
}

/** Drop the outgoing element. Safe only once the incoming one has painted. */
export function retire(outgoing) {
  cancelHide(outgoing);
  outgoing.style.transition = '';
  outgoing.style.opacity = '0';
}

/**
 * Cross-dissolve `incoming` over `outgoing`, or hard-cut when ms <= 0.
 *
 * ⚠️ THE OBVIOUS IMPLEMENTATION DIMS THE PICTURE. Fading the old one out while
 * fading the new one in leaves both semi-transparent at the midpoint, and over
 * a dark background the composite is 0.5*new + 0.5*(0.5*old) - a visible dip,
 * even between two identical frames. That artifact is why projects conclude
 * "do not use transitions" and hard-cut everything.
 *
 * The correct form: the outgoing element stays FULLY OPAQUE and the incoming
 * one fades in on top of it. The composite is a*new + (1-a)*old, a true
 * dissolve. Two identical frames stay identical throughout.
 *
 * ⚠️ The hard-cut path must still set z-index. Setting the new element opaque
 * does not cover the old one if it is underneath; then the old one goes
 * transparent and for one frame neither is visible. That bug only appeared
 * once the fade duration was set to 0 for other reasons.
 */
/**
 * How long the outgoing element stays opaque underneath after a hard cut.
 * Two frames at 60 Hz plus margin - long enough to cover a late first paint,
 * short enough that it is not a fade.
 */
const HOLD_MS = 120;

/**
 * Cancel a pending "hide this element" timer.
 *
 * ⚠️ Both transition paths hide the outgoing element on a timer. If a SECOND
 * handover starts before that timer fires - which is exactly what rapid outfit
 * switching does - the timer from the first one fires against an element the
 * second one has since promoted to the front, and hides the picture that is
 * supposed to be visible. Observed: switch looks three times quickly and both
 * video layers end at opacity 0, leaving only the backdrop.
 *
 * So every promotion cancels whatever hide was queued against that element.
 */
function cancelHide(el) {
  if (el && el._hideTimer) { clearTimeout(el._hideTimer); el._hideTimer = null; }
}

export function crossfade(incoming, outgoing, ms) {
  cancelHide(incoming);
  cancelHide(outgoing);
  if (ms <= 0) {
    outgoing.style.zIndex = '0';
    incoming.style.zIndex = '1';
    incoming.style.transition = '';
    incoming.style.opacity = '1';
    /**
     * ⚠️ DO NOT hide the outgoing element here. It used to be set to
     * opacity 0 on this line, and that is a direct violation of the rule at the
     * top of this file - it hides a frame we have for one we may not.
     *
     * Measured in the demo: 3 animation frames in which the element on top had
     * readyState 0 or 1, i.e. nothing to draw. A video element with no frame is
     * transparent, so the player showed its own background colour. That is the
     * black flash.
     *
     * Leaving the outgoing element opaque underneath costs nothing. Both sides
     * of a hard cut are pivot-aligned by construction, so for the two frames it
     * lingers it is showing the same picture the incoming one is about to show.
     * If the incoming element is not painting yet, the viewer sees the pivot
     * frame instead of the background - which is the entire point.
     */
    outgoing.style.transition = '';
    outgoing.style.opacity = '1';
    outgoing._hideTimer = setTimeout(() => {
      outgoing._hideTimer = null;
      outgoing.style.opacity = '0';
    }, HOLD_MS);
    return;
  }

  outgoing.style.zIndex = '0';
  outgoing.style.transition = '';
  outgoing.style.opacity = '1';
  incoming.style.zIndex = '1';
  incoming.style.transition = '';
  incoming.style.opacity = '0';

  // ⚠️ Do NOT start the transition from requestAnimationFrame. rAF does not
  // fire while the page is not being composited - a background tab, an
  // obscured window, a phone switched away. The incoming element would sit at
  // opacity 0 and the outgoing at 1 forever, and the user returns to a frozen
  // picture while the background element is happily playing. Observed: front
  // element stuck at 3.88 s and paused, back element's currentTime advancing.
  //
  // A forced reflow is synchronous and does not depend on compositing. If the
  // animation itself never runs, the final value still applies.
  void incoming.offsetHeight;
  incoming.style.transition = `opacity ${ms}ms linear`;
  incoming.style.opacity = '1';

  outgoing._hideTimer = setTimeout(() => {
    outgoing._hideTimer = null;
    outgoing.style.opacity = '0';
  }, ms + 20);
}

/**
 * Play, and recover from the two ways play() fails.
 *
 * A bare `.catch(() => {})` leaves the element frozen on its first frame with
 * readyState 4, no error, and paused stuck true. That happens.
 *
 * ⚠️ The second failure is autoplay policy, and it has a specific trigger worth
 * knowing: returning from an external redirect (an OAuth sign-in, say) is a
 * fresh page load with no user gesture, so play() is refused. If your opening
 * clip fades in from black, the user sees a black screen and no explanation.
 * `onBlocked` is called so you can show one; a single tap anywhere resumes.
 */
export function play(el, { onBlocked } = {}) {
  el.play().catch(() => {
    const retry = () => {
      void el.play().catch(() => {
        onBlocked?.();
        const kick = () => {
          void el.play().catch(() => {});
        };
        // Capture phase: app code calls stopPropagation() constantly, and a
        // bubble listener would never hear the tap that unblocks playback.
        document.addEventListener('pointerdown', kick, { once: true, capture: true });
        document.addEventListener('keydown', kick, { once: true, capture: true });
      });
    };
    el.addEventListener('canplay', retry, { once: true });
    if (el.readyState >= 3) retry();
  });
}
