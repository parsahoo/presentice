import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialState, generationOrder } from '../js/player-state.js';

// Slide 0: A A B   Slide 1: B B   Slide 2: A B A
const speakers = [['A', 0], ['A', 0], ['B', 0], ['B', 1], ['B', 1], ['A', 2], ['B', 2], ['A', 2]];
const ctx = { sentences: speakers.map(([speaker, slide], index) => ({ index, speaker, slide })), slideCount: 3 };

function run(state, ...actions) {
  return actions.reduce((s, a) => reduce(s, typeof a === 'function' ? a(s) : a, ctx), state);
}
const started = (s) => ({ type: 'AUDIO_STARTED', seq: s.seq });
const ended = (s) => ({ type: 'AUDIO_ENDED', seq: s.seq, duration: 2 });
const gapDone = (s) => ({ type: 'GAP_DONE', seq: s.seq });

test('AC4: only my lines never plays the other presenter, across slides', () => {
  let s = run(initialState(), { type: 'SET_FOCUS', focus: 'A' }, { type: 'PLAY' });
  const played = [];
  for (let k = 0; k < 10 && s.status !== 'paused'; k += 1) {
    s = run(s, started);
    played.push(s.cursor);
    s = run(s, ended);
  }
  assert.deepEqual(played, [0, 1, 5, 7]);
  assert.ok(played.every((i) => ctx.sentences[i].speaker === 'A'));
});

test('AC4: next and previous skip the other presenter; replay returns to my sentence', () => {
  let s = run(initialState({ cursor: 1 }), { type: 'SET_FOCUS', focus: 'A' }, { type: 'NEXT' });
  assert.equal(s.cursor, 5);
  s = run(s, { type: 'PREV' });
  assert.equal(s.cursor, 1);
  s = run(s, { type: 'PLAY' }, started, { type: 'REPLAY' });
  assert.equal(s.cursor, 1);
  assert.equal(s.status, 'waiting');
});

test('focus moves the cursor off a sentence that is not mine', () => {
  const s = run(initialState({ cursor: 2 }), { type: 'SET_FOCUS', focus: 'A' });
  assert.equal(s.cursor, 5);
});

test('AC5: loop repeats the same sentence; next while looping moves and keeps playing', () => {
  let s = run(initialState(), { type: 'TOGGLE_LOOP' }, { type: 'PLAY' }, started, ended);
  assert.equal(s.cursor, 0);
  assert.equal(s.status, 'waiting');
  s = run(s, started, { type: 'NEXT' });
  assert.equal(s.cursor, 1);
  assert.equal(s.status, 'waiting');
  s = run(s, started, ended);
  assert.equal(s.cursor, 1);
});

test('AC5: shadow pauses (duration / rate) x 1.2, then continues', () => {
  let s = run(initialState(), { type: 'TOGGLE_SHADOW' }, { type: 'SET_RATE', rate: 0.8 }, { type: 'PLAY' }, started, ended);
  assert.equal(s.status, 'gap');
  assert.equal(s.gapMs, 3000);
  s = run(s, gapDone);
  assert.equal(s.cursor, 1);
  assert.equal(s.status, 'waiting');
});

test('AC5: loop and shadow combine with only my lines: repeat, pause, repeat', () => {
  let s = run(initialState({ cursor: 3 }), { type: 'SET_FOCUS', focus: 'A' }, { type: 'TOGGLE_LOOP' }, { type: 'TOGGLE_SHADOW' }, { type: 'PLAY' });
  assert.equal(s.cursor, 5);
  s = run(s, started, ended);
  assert.equal(s.status, 'gap');
  s = run(s, gapDone);
  assert.equal(s.cursor, 5);
  assert.equal(s.status, 'waiting');
});

test('AC5: replay during a gap plays the current sentence again', () => {
  let s = run(initialState(), { type: 'TOGGLE_SHADOW' }, { type: 'PLAY' }, started, ended, { type: 'REPLAY' });
  assert.equal(s.status, 'waiting');
  assert.equal(s.cursor, 0);
});

test('AC5: stale audio events are ignored after rapid navigation', () => {
  let s = run(initialState(), { type: 'PLAY' }, started);
  const oldSeq = s.seq;
  for (let k = 0; k < 20; k += 1) s = run(s, { type: k % 3 === 0 ? 'PREV' : 'NEXT' });
  const before = s;
  s = reduce(s, { type: 'AUDIO_ENDED', seq: oldSeq, duration: 1 }, ctx);
  s = reduce(s, { type: 'AUDIO_STARTED', seq: oldSeq }, ctx);
  assert.equal(s, before);
  assert.ok(before.seq > oldSeq + 10);
});

test('slide navigation lands on the first playable sentence; paused shows the chosen slide', () => {
  let s = run(initialState({ status: 'paused' }), { type: 'SET_FOCUS', focus: 'A' }, { type: 'NEXT_SLIDE' });
  assert.equal(s.slide, 1, 'shows slide 1 even though A has no lines there');
  assert.equal(s.cursor, 5);
  s = run(s, { type: 'PLAY' });
  assert.equal(s.slide, 2);
});

test('next on the last playable sentence keeps playing it (no stuck state)', () => {
  const playing = run(initialState({ cursor: 7 }), { type: 'PLAY' }, started);
  assert.equal(reduce(playing, { type: 'NEXT' }, ctx), playing);
  const first = run(initialState(), { type: 'PLAY' }, started);
  assert.equal(reduce(first, { type: 'PREV' }, ctx), first);
  const focused = run(initialState({ cursor: 7 }), { type: 'SET_FOCUS', focus: 'A' }, { type: 'PLAY' }, started);
  assert.equal(reduce(focused, { type: 'NEXT' }, ctx).status, 'playing');
});

test('end of the deck pauses', () => {
  const s = run(initialState({ cursor: 7 }), { type: 'PLAY' }, started, ended);
  assert.equal(s.status, 'paused');
  assert.equal(s.cursor, 7);
});

test('clicking a sentence outside only my lines plays it once and keeps the filter', () => {
  let s = run(initialState(), { type: 'SET_FOCUS', focus: 'A' }, { type: 'GOTO', index: 2 });
  assert.equal(s.focus, 'A');
  assert.equal(s.cursor, 2);
  assert.equal(s.status, 'waiting');
  s = run(s, started, ended);
  assert.equal(s.focus, 'A');
  assert.equal(s.cursor, 5);
  assert.equal(s.slide, 2);
  assert.equal(s.status, 'waiting');
});

test('speed steps stay inside the allowed rates', () => {
  let s = run(initialState(), { type: 'RATE_STEP', step: 1 }, { type: 'RATE_STEP', step: 1 });
  assert.equal(s.rate, 1.1);
  s = run(s, { type: 'RATE_STEP', step: -5 });
  assert.equal(s.rate, 0.8);
});

test('generation order starts at the cursor and prefers playable sentences', () => {
  const s = { ...initialState({ cursor: 1 }), focus: 'A' };
  const order = generationOrder(s, ctx);
  assert.deepEqual(order.slice(0, 4), [1, 5, 7, 0]);
  assert.equal(order.length, 8);
});
