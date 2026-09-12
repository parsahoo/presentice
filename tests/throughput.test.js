// The measured estimate in js/throughput.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSample, etaMs, etaText, msPerChar } from '../js/throughput.js';

const many = (n, sample) => Array.from({ length: n }, () => sample);

test('samples are kept newest first and never grow without limit', () => {
  let samples = [];
  for (let i = 1; i <= 20; i += 1) samples = addSample(samples, { chars: i, ms: 100 });
  assert.equal(samples.length, 12);
  assert.equal(samples[samples.length - 1].chars, 20);
  assert.equal(samples[0].chars, 9);
});

test('a sample with no time or no text is ignored', () => {
  let samples = [];
  samples = addSample(samples, { chars: 0, ms: 100 });
  samples = addSample(samples, { chars: 10, ms: 0 });
  samples = addSample(samples, null);
  assert.deepEqual(samples, []);
});

test('nothing is estimated before there is evidence', () => {
  const two = [{ chars: 100, ms: 1000 }, { chars: 100, ms: 1000 }];
  assert.equal(msPerChar([]), null);
  assert.equal(msPerChar(two), null);
  assert.equal(etaMs(two, 5000), null, 'no guess from two sentences');
  assert.equal(etaText(etaMs(two, 5000)), '');
});

test('the estimate is the measured rate over the text still to make', () => {
  const samples = many(4, { chars: 100, ms: 2000 }); // 20 ms per character
  assert.equal(msPerChar(samples), 20);
  assert.equal(etaMs(samples, 12000), 240000);
  assert.equal(etaMs(samples, 0), null);
});

test('slow and fast sentences average out', () => {
  const samples = [
    { chars: 100, ms: 1000 },
    { chars: 100, ms: 3000 },
    { chars: 200, ms: 4000 },
  ];
  assert.equal(msPerChar(samples), 8000 / 400);
});

test('the wording is short and honest', () => {
  assert.equal(etaText(240000), 'about 4 minutes left');
  assert.equal(etaText(60000), 'about a minute left');
  assert.equal(etaText(100000), 'about 2 minutes left');
  assert.equal(etaText(20000), 'under a minute left');
  assert.equal(etaText(0), '');
  assert.equal(etaText(null), '');
});
