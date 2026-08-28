/**
 * Wiring for the interactive demo, shared by index.html and the standalone
 * example page.
 *
 * Three things here are worth knowing about.
 *
 * `ask()` cuts straight to the answer, interrupting whatever rotation clip is
 * on screen. It used to play a "let me think" filler first, which is what
 * production does - see docs/04-latency.md, where after the model choice, the
 * pipelining and the caching what remains is genuine computation and the only
 * move left is to cover it with something the character is plausibly doing.
 * Nothing is computed here, so the filler covered nothing and cost four seconds
 * per answer. A filler is worth exactly as much as the wait it hides.
 *
 * The transcript is driven by player EVENTS, not timers. The answer bubble
 * appears on `speakstart` for the answer clip, so text and mouth cannot drift
 * apart however long a clip takes to become playable.
 *
 * ⚠️ Bubbles carry BOTH languages and CSS picks one, exactly like the static
 * page. Rendering only the active language would leave any bubble written
 * before a language switch stranded in the old one.
 */
import { PivotStage } from '../player/src/index.js';
import { library, LOOKS, NAME, QUESTIONS, poolFor } from '../player/examples/clips.js';

const SIZES = ['s', 'm', 'l'];

export function mountDemo({ els }) {
  const LIB = library();
  let lookKey = LOOKS[0];
  let look = LIB[lookKey];
  let pending = null;   // the answer clip we are waiting to caption

  const log = (m) => {
    if (!els.log) return;
    const t = new Date().toISOString().slice(11, 19);
    els.log.textContent = `${t}  ${m}\n` + els.log.textContent;
  };

  const stage = new PivotStage({
    a: els.a,
    b: els.b,
    poster: els.poster,
    /**
     * ⚠️ 120 ms on both, and the number is a purchase, not a preference.
     *
     * Every clip is rendered over a base that begins and ends on the pivot
     * frame, with the audio padded to exactly that base's length. The bases are
     * excellent — measured against each other, first frames agree to a worst
     * 12x12 block of 4.1-5.5 out of 255 and last frames to 5.0-7.2. If the
     * renders inherited that, every join here would be a free hard cut.
     *
     * They do not. The generator adds drift at the END of a sequence, where it
     * has the least future context, and how much depends on mouth amplitude:
     *
     *     amplitude   seam (worst block, last frame vs the canonical first)
     *     0.45        7.7      mouth movement rejected as too small
     *     0.60       10.2
     *     0.90       14.3
     *     1.20       17.5     the amplitude actually shipped
     *
     * First frames stay put throughout — 0.00-7.3 — so this is specifically an
     * end-of-sequence effect, not a misalignment. The engine's own expression
     * fade made it worse (29.7 to 54.1), and ending each clip on the best of
     * its last 25 frames recovered almost nothing (22.2 to 19.9), which is how
     * you know the whole tail drifted rather than one frame being bad.
     *
     * So: 120 ms of dissolve. Shorter than the 200 ms this used before, and it
     * buys back the mouth movement she needs to look like she is talking.
     *
     * ⚠️ Do not read this as "always fade". docs/06-playback.md has three user
     * reports of ghosting caused by fading clips that were genuinely aligned.
     * Fade because you measured a gap, not because fading feels safer.
     */
    reactionFadeMs: 120,
    speechFadeMs: 120,
    holdMinS: 5,
    holdMaxS: 10,
  });

  // ---- transcript ---------------------------------------------------------

  function bubble(who, en, zh, cls) {
    if (!els.chatLog) return null;
    const row = document.createElement('div');
    row.className = `bubble ${who}` + (cls ? ` ${cls}` : '');
    const a = document.createElement('span');
    a.setAttribute('data-l', 'en');
    a.textContent = en;
    const b = document.createElement('span');
    b.setAttribute('data-l', 'zh');
    b.textContent = zh;
    row.append(a, b);
    els.chatLog.append(row);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    return row;
  }

  // ⚠️ There is no "typing..." state here, deliberately. It belonged to the
  // filler clip: something had to fill the four seconds before the answer
  // started. The answer now starts in the same tick as the click - measured at
  // 17 ms to the bubble - so an indicator would appear and vanish inside one
  // frame. Removing the cause removed the need for the indicator.

  /**
   * ⚠️ The unlock has a deadline, and it is not belt-and-braces.
   *
   * The buttons are re-enabled by the player's `idle` event. If that event
   * never arrives the page is permanently unusable, and it does not arrive in
   * at least two situations that are not bugs: the browser refuses to play the
   * clip because there has been no user gesture yet, and a background tab
   * throttles media loading so far that the clip never finishes. Reproduced
   * here by clearing the transcript mid-turn - the buttons stayed disabled for
   * good, with nothing on screen explaining why.
   *
   * A stuck control is worse than a repeated one, so the deadline wins. Clips
   * here run under 5 s; 20 s is far past any legitimate turn.
   */
  let unlockTimer = null;
  function setAsking(busy) {
    for (const b of els.askButtons || []) b.disabled = busy;
    clearTimeout(unlockTimer);
    if (busy) {
      unlockTimer = setTimeout(() => {
        log('unlocked    no idle event arrived — releasing the buttons');
            pending = null;
        for (const b of els.askButtons || []) b.disabled = false;
      }, 20000);
    }
  }

  // ---- player events ------------------------------------------------------

  stage.on('speakstart', (u) => {
    log(`speaking    ${u.split('/').pop()}`);
    if (pending && u === pending.url) {
        bubble('her', pending.q.answerEn, pending.q.answerZh);
      pending = null;
    }
  });
  stage.on('idle', () => {
    log('idle        back to the rotation');
    pending = null;
    setAsking(false);
  });
  stage.on('blocked', () => {
    log('BLOCKED     the browser refused audio — click the page once');
    if (els.blocked) els.blocked.hidden = false;
  });

  if (els.poster) els.poster.src = look.poster;
  stage.setPool(poolFor(look));
  stage.start();

  // Report handovers, because they are the thing this player is about: every
  // visual defect happens at one, and resting replays in place to avoid them.
  let last = null;
  setInterval(() => {
    if (stage.playing !== last) {
      const to = stage.playing ? stage.playing.split('/').pop() : '—';
      log(`handover    ${last ? last.split('/').pop() : '(start)'} -> ${to}`);
      last = stage.playing;
    }
  }, 150);

  // ---- looks --------------------------------------------------------------

  function setLook(key) {
    if (!LIB[key]) return;
    lookKey = key;
    look = LIB[key];
    // The backdrop is this look's pivot frame; it must change with the look or
    // it becomes a different person showing through a gap.
    if (els.poster) els.poster.src = look.poster;
    if (els.lookTag) {
      els.lookTag.textContent =
        document.documentElement.getAttribute('data-lang') === 'zh'
          ? look.labelZh : look.label;
    }
    stage.setPool(poolFor(look));
    log(`look        ${key}`);
    for (const b of els.lookButtons || []) {
      b.setAttribute('aria-pressed', String(b.dataset.look === key));
    }
  }

  // ---- asking -------------------------------------------------------------

  /**
   * Ask a canned question.
   *
   * ⚠️ `speakNow`, not `setSpeakQueue`. The queue is only consulted at the next
   * handover, so setting it would make the viewer sit out the rest of whatever
   * idle clip is playing - up to five seconds of nothing happening after they
   * clicked. Measured click-to-answer with this: 17 ms.
   */
  function ask(i) {
    const q = QUESTIONS[i];
    const answer = look.answers[i];
    if (!q || !answer) return;
    bubble('you', q.en, q.zh);
    pending = { url: answer, q };
    setAsking(true);
    // Straight to the answer, cutting the rotation clip off where it stands.
    // Nothing is being rendered, so there is no wait to cover and nothing to
    // gain by making the viewer sit through the rest of an idle clip first.
    stage.speakNow([answer]);
    log(`asked #${i + 1}   answering immediately — pre-rendered`);
  }

  // ---- size ---------------------------------------------------------------

  function setSize(size) {
    if (!els.demo || !SIZES.includes(size)) return;
    els.demo.dataset.size = size;
    for (const b of els.sizeButtons || []) {
      b.setAttribute('aria-pressed', String(b.dataset.size === size));
    }
    try { localStorage.setItem('demoSize', size); } catch { /* blocked storage */ }
  }

  /**
   * ⚠️ The Fullscreen API is refused in more places than people expect — an
   * iframe without `allowfullscreen`, several in-app browsers, and any call not
   * made inside a user gesture. So the class goes on either way and the CSS for
   * it covers the viewport by itself. Real fullscreen is the upgrade, not the
   * mechanism.
   */
  function toggleFull() {
    if (!els.demo) return;
    const on = !els.demo.classList.contains('is-full');
    els.demo.classList.toggle('is-full', on);
    document.body.classList.toggle('demo-full', on);
    if (els.fullButton) els.fullButton.setAttribute('aria-pressed', String(on));
    try {
      if (on && els.demo.requestFullscreen) els.demo.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch { /* refused; the class still covers the viewport */ }
  }

  function leaveFull() {
    if (!els.demo || !els.demo.classList.contains('is-full')) return;
    els.demo.classList.remove('is-full');
    document.body.classList.remove('demo-full');
    if (els.fullButton) els.fullButton.setAttribute('aria-pressed', 'false');
  }

  // Leaving fullscreen with Esc must not strand the page in the overlay state.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) leaveFull();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { leaveFull(); try { document.exitFullscreen?.(); } catch {} }
  });

  // ---- listeners ----------------------------------------------------------

  for (const b of els.lookButtons || []) {
    b.addEventListener('click', () => setLook(b.dataset.look));
  }
  for (const b of els.askButtons || []) {
    b.addEventListener('click', () => ask(Number(b.dataset.q)));
  }
  for (const b of els.sizeButtons || []) {
    b.addEventListener('click', () => setSize(b.dataset.size));
  }
  if (els.fullButton) els.fullButton.addEventListener('click', toggleFull);
  if (els.breakButton) {
    els.breakButton.addEventListener('click', () => {
      const missing = look.still.replace(/[^/]+$/, 'does_not_exist.mp4');
      stage.setPool([...poolFor(look), missing]);
      stage.setSpeakQueue([missing], { fresh: true });
      log('broke it    queued a missing clip — skipped, not fatal');
    });
  }

  let saved = 'm';
  try { saved = localStorage.getItem('demoSize') || 'm'; } catch { /* blocked */ }
  setSize(SIZES.includes(saved) ? saved : 'm');
  setLook(lookKey);

  // A first gesture anywhere unblocks audio, which browsers refuse until then.
  document.addEventListener('pointerdown', () => {
    if (els.blocked) els.blocked.hidden = true;
  }, { once: true, capture: true });

  // Keep the look label in the header honest when the page language flips.
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.langbtn')) setTimeout(() => setLook(lookKey), 0);
  });

  return { stage, setLook, setSize, ask, NAME, QUESTIONS, LOOKS };
}
