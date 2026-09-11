// Silence trimming and 16-bit PCM WAV encoding. Pure, used by the TTS worker.

const PAD_SECONDS = 0.08;
const WINDOW_SECONDS = 0.01;
const RMS_THRESHOLD = 0.01;

/** Trim leading and trailing silence, keeping about 80 ms of padding. */
export function trimSilence(samples, sampleRate) {
  const win = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  const pad = Math.round(sampleRate * PAD_SECONDS);
  const loud = (start) => {
    let sum = 0;
    const end = Math.min(samples.length, start + win);
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, end - start)) > RMS_THRESHOLD;
  };
  let first = -1;
  for (let i = 0; i < samples.length; i += win) {
    if (loud(i)) {
      first = i;
      break;
    }
  }
  if (first < 0) return samples.slice(0, 0);
  let last = samples.length;
  for (let i = samples.length - win; i >= 0; i -= win) {
    if (loud(i)) {
      last = i + win;
      break;
    }
  }
  const start = Math.max(0, first - pad);
  const end = Math.min(samples.length, last + pad);
  return samples.slice(start, end);
}

/** Encode mono Float32 samples as a 16-bit PCM WAV ArrayBuffer. */
export function encodeWav(samples, sampleRate) {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return buffer;
}

/** A short silent WAV, used to unlock audio playback on the first click. */
export function silentWav(sampleRate = 8000, seconds = 0.05) {
  return encodeWav(new Float32Array(Math.round(sampleRate * seconds)), sampleRate);
}
