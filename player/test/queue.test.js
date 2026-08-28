import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeakQueue } from '../src/queue.js';

/**
 * Both tests here cover bugs that shipped and were reported by users, and the
 * second covers a bug introduced by the fix for the first. Neither needs a DOM,
 * which is the point: this logic caused visible defects and is testable in
 * milliseconds.
 */

test('a finished clip is not resurrected by a stale host sync', () => {
  const q = new SpeakQueue();
  q.sync(['one.mp4', 'two.mp4']);

  assert.equal(q.head(), 'one.mp4');
  q.consume('one.mp4');
  assert.equal(q.head(), 'two.mp4');

  // The host has not applied its own update yet and re-syncs the old list.
  // Without the consumed set this puts one.mp4 back at the head and it plays
  // a second time - and a third, if it happens again.
  q.sync(['one.mp4', 'two.mp4']);
  assert.equal(q.head(), 'two.mp4', 'consumed clip must not come back');
});

test('the pool is not exhausted for the rest of the session', () => {
  const q = new SpeakQueue();

  // Play a filler line.
  q.sync(['filler.mp4']);
  q.consume('filler.mp4');

  // The host applies its update: the item is gone from its list.
  q.sync([]);

  // Later, the same filler is legitimately chosen again. If `consumed` only
  // ever grew, this would be silently dropped and the character would say
  // nothing - the failure the resurrection fix originally introduced.
  q.sync(['filler.mp4']);
  assert.equal(q.head(), 'filler.mp4', 'a clip the host dropped must be replayable');
});

test('consume only removes the head', () => {
  const q = new SpeakQueue();
  q.sync(['a.mp4', 'b.mp4']);
  q.consume('b.mp4');            // not the head
  assert.deepEqual(q.items, ['a.mp4', 'b.mp4'], 'a non-head consume must not reorder the queue');
  assert.equal(q.head(), 'a.mp4');
});

test('reset makes previously played clips available again', () => {
  const q = new SpeakQueue();
  q.sync(['x.mp4']);
  q.consume('x.mp4');
  q.reset();
  q.sync(['x.mp4']);
  assert.equal(q.head(), 'x.mp4');
});

/**
 * The two tests below cover a bug the unit tests did NOT catch and the demo
 * did: queueing a clip that fails to load left the player frozen on the last
 * frame of the previous clip, forever.
 *
 * The rotation pool filtered broken clips. The queue did not - so recovery
 * from the load error immediately chose the same broken clip again.
 */

test('a broken clip is skipped when choosing the queue head', () => {
  const q = new SpeakQueue();
  const broken = new Set(['missing.mp4']);
  q.sync(['missing.mp4', 'good.mp4']);

  assert.equal(q.head(broken), 'good.mp4',
    'an unloadable clip must never be offered as the next thing to play');
  assert.equal(q.head(new Set()), 'missing.mp4',
    'with nothing known broken, the head is just the head');
});

test('dropping a broken clip removes it and stops it coming back', () => {
  const q = new SpeakQueue();
  q.sync(['missing.mp4', 'good.mp4']);
  q.drop('missing.mp4');

  assert.deepEqual(q.items, ['good.mp4']);
  // A host that has not applied its own update yet re-syncs the old list.
  q.sync(['missing.mp4', 'good.mp4']);
  assert.equal(q.head(), 'good.mp4', 'a dropped clip must not be resurrected');
});

test('a repeated turn needs an explicit reset, and gets one', () => {
  // ⚠️ This is the shape of a defect that reached a demo. sync() filters out
  // anything already consumed, which is right for an asynchronous re-sync of a
  // live list and wrong for a new turn that reuses the same clips. Without the
  // reset the queue comes back empty and the caller waits forever for a clip
  // that will never play.
  const q = new SpeakQueue();
  q.sync(['filler.mp4', 'answer.mp4']);
  q.consume('filler.mp4');
  q.consume('answer.mp4');

  q.sync(['filler.mp4', 'answer.mp4']);
  assert.equal(q.length, 0, 'without a reset the same clips are filtered out');

  q.reset();
  q.sync(['filler.mp4', 'answer.mp4']);
  assert.equal(q.length, 2, 'after a reset the turn can be played again');
  assert.equal(q.head(), 'filler.mp4');
});
