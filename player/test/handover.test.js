/**
 * The handover invariant, pinned.
 *
 * These tests exist because the bug they describe shipped, was invisible in
 * review, and was only found by sampling the composited page every animation
 * frame. Reading the code did not reveal it - twice. A test does.
 *
 * THE INVARIANT: never hide a frame you have for a frame you do not.
 *
 * A <video> element with no decoded frame is transparent, not black. So the
 * moment the outgoing element goes to opacity 0 while the incoming one has
 * nothing to draw, the player shows its own background - which readers report
 * as "it flashes black between clips".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossfade, promote, retire } from '../src/handover.js';

/** The parts of an HTMLElement these functions touch. */
function fakeEl(id) {
  return { id, style: {}, offsetHeight: 0 };
}

test('hard cut does not hide the outgoing element in the same tick', () => {
  const inc = fakeEl('in');
  const out = fakeEl('out');
  out.style.opacity = '1';

  crossfade(inc, out, 0);

  // Incoming is on top and opaque...
  assert.equal(inc.style.opacity, '1');
  assert.equal(inc.style.zIndex, '1');
  // ...and the outgoing is STILL VISIBLE underneath it. This is the whole
  // point: if the incoming element has not painted yet it is transparent, and
  // what shows through is the previous clip's pivot frame rather than the page
  // background.
  assert.equal(out.style.opacity, '1',
    'outgoing must stay opaque through a hard cut, not be hidden immediately');
  assert.equal(out.style.zIndex, '0');
});

test('hard cut releases the outgoing element eventually', async () => {
  const inc = fakeEl('in');
  const out = fakeEl('out');
  crossfade(inc, out, 0);
  assert.equal(out.style.opacity, '1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(out.style.opacity, '0', 'outgoing must be released after the hold');
});

test('fade keeps the outgoing element fully opaque, and only the incoming moves', () => {
  const inc = fakeEl('in');
  const out = fakeEl('out');

  crossfade(inc, out, 120);

  // ⚠️ The obvious implementation fades the old one out while fading the new
  // one in, which leaves both semi-transparent at the midpoint and dips the
  // picture even between two identical frames. The outgoing element must stay
  // at 1 so the composite is a*new + (1-a)*old, a true dissolve.
  assert.equal(out.style.opacity, '1');
  assert.equal(out.style.zIndex, '0');
  assert.equal(inc.style.zIndex, '1');
  assert.equal(inc.style.opacity, '1');
  assert.match(inc.style.transition, /opacity 120ms/);
  assert.equal(out.style.transition, '', 'the outgoing element must not animate');
});

test('promote puts the incoming on top without touching the outgoing frame', () => {
  const inc = fakeEl('in');
  const out = fakeEl('out');
  promote(inc, out);
  assert.equal(inc.style.zIndex, '1');
  assert.equal(inc.style.opacity, '1');
  assert.equal(out.style.zIndex, '0');
  assert.equal(out.style.opacity, '1',
    'promote must never hide the outgoing element - retire() does that, later');
  retire(out);
  assert.equal(out.style.opacity, '0');
});

test('a fade sets no transition on the element that must not move', () => {
  // Regression guard for the dip: if a future edit animates the outgoing
  // element, this catches it before anyone has to see it.
  const inc = fakeEl('in');
  const out = fakeEl('out');
  out.style.transition = 'opacity 400ms linear';
  crossfade(inc, out, 200);
  assert.equal(out.style.transition, '');
});

test('a second handover cancels the first one hide timer', async () => {
  // ⚠️ Regression. Both transition paths hide the outgoing element on a timer.
  // A second handover starting before that timer fires used to let it run
  // against an element the second handover had just promoted - hiding the
  // picture that was supposed to be visible. Switching outfits three times
  // quickly left BOTH layers at opacity 0 and only the backdrop showing.
  const a = fakeEl('a');
  const b = fakeEl('b');

  crossfade(a, b, 120);          // a incoming, b outgoing, hide b in 140ms
  crossfade(b, a, 120);          // reversed before that fires

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.style.opacity, '1',
    'b was promoted by the second handover and must not be hidden by the first');
});

test('hard cut cancels a pending hide the same way', async () => {
  const a = fakeEl('a');
  const b = fakeEl('b');
  crossfade(a, b, 0);            // schedules b hidden at HOLD_MS
  promote(b, a);                 // b promoted straight back
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.style.opacity, '1', 'the stale hold timer must not hide b');
});
