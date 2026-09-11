import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, wordTimings, wordAt, normalizeText } from '../js/sentences.js';
import { trimSilence, encodeWav } from '../js/wav.js';

test('splits plain sentences', () => {
  assert.deepEqual(splitSentences('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!']);
});

test('keeps abbreviations, decimals and ellipses together', () => {
  assert.deepEqual(splitSentences('Dr. Lee met Ms. Park in the U.S. last year.'), ['Dr. Lee met Ms. Park in the U.S. last year.']);
  assert.deepEqual(splitSentences('It grew 3.5 percent. Then it stopped.'), ['It grew 3.5 percent.', 'Then it stopped.']);
  assert.deepEqual(splitSentences('Use a kit, e.g. seeds and soil. Done.'), ['Use a kit, e.g. seeds and soil.', 'Done.']);
  assert.deepEqual(splitSentences('Wait... and then it worked.'), ['Wait... and then it worked.']);
});

test('hard-splits very long sentences at commas', () => {
  const long = `${'word '.repeat(40)}and more, ${'text '.repeat(50)}end.`;
  const parts = splitSentences(long);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 300));
});

test('normalizeText folds whitespace and curly quotes', () => {
  assert.equal(normalizeText('  It\u2019s\n  here  '), "It's here");
});

test('word timings cover the whole duration and grow with length', () => {
  const { tokens, words } = wordTimings('Hi, we have 2026 bikes.', 3);
  assert.equal(words.length, 5);
  assert.equal(tokens[words[0].token].text, 'Hi');
  assert.ok(Math.abs(words[words.length - 1].end - 3) < 1e-9);
  const dur = (w) => w.end - w.start;
  assert.ok(dur(words[3]) > dur(words[1]), 'a number takes longer than a short word');
  assert.equal(wordAt(words, 0), 0);
  assert.equal(wordAt(words, 2.99), 4);
});

test('trimSilence keeps padding around the loud part', () => {
  const rate = 1000;
  const s = new Float32Array(3000);
  for (let i = 1000; i < 2000; i += 1) s[i] = 0.5;
  const out = trimSilence(s, rate);
  assert.ok(out.length >= 1000 && out.length <= 1200, `length ${out.length}`);
  const wav = encodeWav(out, rate);
  assert.equal(wav.byteLength, 44 + out.length * 2);
});
