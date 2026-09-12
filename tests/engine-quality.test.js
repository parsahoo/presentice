// The Voice quality table in js/engine-quality.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUALITY,
  QUALITIES,
  QUALITY_IDS,
  engineFor,
  normalizeQuality,
  qualityForEngine,
  qualityOf,
} from '../js/engine-quality.js';

test('Standard is the default for everyone', () => {
  assert.equal(DEFAULT_QUALITY, 'standard');
  assert.deepEqual(engineFor(DEFAULT_QUALITY), { dtype: 'q8', device: 'wasm' });
});

test('High is the full model on the graphics card', () => {
  assert.deepEqual(engineFor('high'), { dtype: 'fp32', device: 'webgpu' });
});

test('only the two measured combinations are offered', () => {
  assert.deepEqual(QUALITY_IDS, ['standard', 'high']);
  // fp16 on webgpu was much quieter, and q8 on webgpu took 157 s for a 13 s line.
  assert.equal(QUALITIES.some((q) => q.dtype === 'fp16'), false);
  assert.equal(QUALITIES.some((q) => q.dtype === 'q8' && q.device === 'webgpu'), false);
});

test('an unknown or missing stored value falls back to Standard', () => {
  for (const value of [undefined, null, '', 'fastest', 42, {}]) {
    assert.equal(normalizeQuality(value), 'standard');
    assert.equal(qualityOf(value).dtype, 'q8');
  }
});

test('every quality carries a short honest note', () => {
  for (const q of QUALITIES) {
    assert.match(q.note, /^[A-Z]/);
    assert.equal(/[\u2014\u2013\u2018\u2019\u201c\u201d]/.test(q.note), false, 'no dashes or curly quotes');
  }
});

test('an engine maps back to the quality that made its clips', () => {
  assert.equal(qualityForEngine('q8', 'wasm'), 'standard');
  assert.equal(qualityForEngine('fp32', 'webgpu'), 'high');
  assert.equal(qualityForEngine('q8', 'webgpu'), null);
});
