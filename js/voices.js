// Curated Kokoro voices and per-presenter defaults. Pure.

export const VOICES = [
  { id: 'am_michael', name: 'Michael', accent: 'US', gender: 'male' },
  { id: 'af_heart', name: 'Heart', accent: 'US', gender: 'female' },
  { id: 'bm_george', name: 'George', accent: 'UK', gender: 'male' },
  { id: 'bf_emma', name: 'Emma', accent: 'UK', gender: 'female' },
  { id: 'am_adam', name: 'Adam', accent: 'US', gender: 'male' },
  { id: 'af_bella', name: 'Bella', accent: 'US', gender: 'female' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'UK', gender: 'male' },
  { id: 'af_sarah', name: 'Sarah', accent: 'US', gender: 'female' },
];

export const VOICE_IDS = VOICES.map((v) => v.id);

/** The name shown in the voice picker, for example "Heart, US female". */
export function voiceLabel(voice) {
  return `${voice.name}, ${voice.accent} ${voice.gender}`;
}

/**
 * Assign voices: keep every saved choice that is still valid (two presenters may
 * share a voice if the user picked that), give everyone else the next voice
 * nobody uses yet.
 */
export function defaultVoices(presenters, saved = {}) {
  const out = {};
  const used = new Set();
  for (const p of presenters) {
    if (VOICE_IDS.includes(saved[p])) {
      out[p] = saved[p];
      used.add(saved[p]);
    }
  }
  let next = 0;
  for (const p of presenters) {
    if (out[p]) continue;
    while (next < VOICE_IDS.length && used.has(VOICE_IDS[next])) next += 1;
    const id = VOICE_IDS[next % VOICE_IDS.length] || VOICE_IDS[0];
    out[p] = id;
    used.add(id);
    next += 1;
  }
  return out;
}
