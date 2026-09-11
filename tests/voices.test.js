import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultVoices, voiceLabel, VOICES } from '../js/voices.js';

test('new presenters get different voices', () => {
  const v = defaultVoices(['Alex', 'Sam', 'Kim']);
  assert.equal(new Set(Object.values(v)).size, 3);
});

test('a voice the user gave to two presenters stays with both', () => {
  const v = defaultVoices(['Alex', 'Sam'], { Alex: 'am_michael', Sam: 'am_michael' });
  assert.deepEqual(v, { Alex: 'am_michael', Sam: 'am_michael' });
});

test('defaults skip voices the user already picked', () => {
  const v = defaultVoices(['Alex', 'Sam'], { Sam: 'am_michael' });
  assert.equal(v.Sam, 'am_michael');
  assert.notEqual(v.Alex, 'am_michael');
});

test('unknown saved voices fall back to a default', () => {
  const v = defaultVoices(['Alex'], { Alex: 'nope' });
  assert.ok(VOICES.some((x) => x.id === v.Alex));
});

test('voice labels say accent and gender', () => {
  assert.equal(voiceLabel(VOICES.find((x) => x.id === 'af_heart')), 'Heart, US female');
});
