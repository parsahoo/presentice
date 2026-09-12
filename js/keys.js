// Cache keys. Works in browsers, workers and Node (globalThis.crypto.subtle).
import { normalizeText } from './sentences.js';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Key for generated audio: text, voice, model build (dtype), device and model id all
 * change the sound, so each combination is cached on its own and none is served for another.
 * @param {{ dtype: string, device: string }} engine
 */
export function audioKey(text, voice, engine, modelId = MODEL_ID) {
  const { dtype, device } = engine || {};
  return sha256Hex([normalizeText(text), voice, dtype, device, modelId].join('\n'));
}

/**
 * The key the previous released version used, before the device became part of it.
 * That version picked its engine from the machine, so this key stands for q8 on
 * WebAssembly or fp32 on WebGPU, which are Standard and High today. js/tts.js carries
 * such a clip over to the key of the quality that made it instead of making it again.
 */
export function legacyAudioKey(text, voice, dtype, modelId = MODEL_ID) {
  return sha256Hex([normalizeText(text), voice, dtype, modelId].join('\n'));
}

/** Key for the pre-rendered sample clips, independent of the local backend. */
export function sampleKey(text, voice) {
  return sha256Hex([normalizeText(text), voice].join('\n'));
}
