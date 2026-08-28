import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoodPicker, pickOther } from '../src/picker.js';

/** Deterministic rng so these assert behaviour, not luck. */
const seq = (...vals) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

test('rotation never produces A-B-A-B ping-pong with three candidates', () => {
  const pool = ['a.mp4', 'b.mp4', 'c.mp4'];
  const p = new MoodPicker({ isStill: () => false, rng: seq(0, 0, 0, 0, 0, 0) });

  const played = [];
  let cur = null;
  for (let i = 0; i < 6; i += 1) {
    cur = p.pick(pool, cur, true);
    played.push(cur);
  }

  // Excluding only the last clip would allow a,b,a,b,a,b even with a fixed rng.
  // Excluding the last two forces a three-cycle.
  for (let i = 2; i < played.length; i += 1) {
    assert.notEqual(played[i], played[i - 1], 'immediate repeat');
    assert.notEqual(played[i], played[i - 2], 'ping-pong at distance 2');
  }
});

test('a speculative pick leaves no trace', () => {
  const pool = ['still.mp4', 'gesture.mp4', 'idle_2.mp4'];
  const p = new MoodPicker({ rng: () => 0 });

  // Rest for a while after a motion clip.
  p.pick(pool, 'gesture.mp4', true);
  const holdAfterCommit = p.holdLeft;

  // The preloader asks repeatedly. None of these may advance the counter -
  // the bug this guards was the rest interval being burned by preloads, so
  // gestures fired constantly and the character never settled.
  for (let i = 0; i < 10; i += 1) p.pick(pool, 'still.mp4', false);
  assert.equal(p.holdLeft, holdAfterCommit, 'speculative picks must be pure');

  const recentBefore = p.recent.slice();
  p.pick(pool, 'still.mp4', false);
  assert.deepEqual(p.recent, recentBefore, 'speculative picks must not touch recent');
});

test('resting returns the clip already playing, so the caller can replay in place', () => {
  const pool = ['x_still.mp4', 'gesture.mp4'];
  const p = new MoodPicker({ rng: () => 0, holdMinS: 10, holdMaxS: 10 });
  p.noteStillDuration(5);

  const first = p.pick(pool, 'gesture.mp4', true);
  assert.equal(first, 'x_still.mp4', 'after motion, go and rest');
  assert.ok(p.holdLeft >= 1, 'a 10s rest over a 5s clip is more than one play');

  const again = p.pick(pool, 'x_still.mp4', true);
  assert.equal(again, 'x_still.mp4', 'still resting: same clip, zero-handover path');
});

test('rest length follows the clip duration rather than a hard-coded guess', () => {
  const pool = ['x_still.mp4', 'gesture.mp4'];
  const short = new MoodPicker({ rng: () => 0, holdMinS: 10, holdMaxS: 10 });
  const long = new MoodPicker({ rng: () => 0, holdMinS: 10, holdMaxS: 10 });

  short.noteStillDuration(2.5);
  long.noteStillDuration(10);
  short.pick(pool, 'gesture.mp4', true);
  long.pick(pool, 'gesture.mp4', true);

  assert.ok(short.holdLeft > long.holdLeft,
    'a short still clip must be replayed more times to fill the same rest');
});

test('broken clips are excluded from every pool', () => {
  const broken = new Set(['bad.mp4']);
  const p = new MoodPicker({ isStill: () => false, rng: () => 0 });
  p.markBroken(broken);
  for (let i = 0; i < 5; i += 1) {
    assert.notEqual(p.pick(['bad.mp4', 'good.mp4'], null, true), 'bad.mp4');
  }
});

test('pickOther degrades instead of returning undefined', () => {
  assert.equal(pickOther(['only.mp4'], ['only.mp4', 'only.mp4'], () => 0), 'only.mp4');
  assert.equal(pickOther(['a.mp4'], [], () => 0.999), 'a.mp4');
});
