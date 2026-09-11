// Cache keys. Works in browsers, workers and Node (globalThis.crypto.subtle).
import { normalizeText } from './sentences.js';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Key for generated audio: text, voice, dtype and model all change the sound. */
export function audioKey(text, voice, dtype, modelId = MODEL_ID) {
  return sha256Hex([normalizeText(text), voice, dtype, modelId].join('\n'));
}

/** Key for the pre-rendered sample clips, independent of the local backend. */
export function sampleKey(text, voice) {
  return sha256Hex([normalizeText(text), voice].join('\n'));
}
