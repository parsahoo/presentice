// How fast this computer actually makes voices, and the estimate shown from it.
// Pure: the caller records one sample per finished sentence.

const MAX_SAMPLES = 12;
const MIN_SAMPLES = 3;
const MINUTE = 60000;

/** Add a finished sentence ({ chars, ms }); keeps the newest MAX_SAMPLES. */
export function addSample(samples, sample) {
  if (!(sample?.chars > 0) || !(sample?.ms > 0)) return samples;
  return [...samples, { chars: sample.chars, ms: sample.ms }].slice(-MAX_SAMPLES);
}

/** Milliseconds per character on this machine, or null before there is evidence. */
export function msPerChar(samples) {
  if (samples.length < MIN_SAMPLES) return null;
  let chars = 0;
  let ms = 0;
  for (const s of samples) {
    chars += s.chars;
    ms += s.ms;
  }
  return chars > 0 ? ms / chars : null;
}

/** Milliseconds left for `pendingChars` of script, or null while nothing is measured. */
export function etaMs(samples, pendingChars) {
  const rate = msPerChar(samples);
  if (rate === null || !(pendingChars > 0)) return null;
  return rate * pendingChars;
}

/** "about 4 minutes left". Short and honest; never a countdown by the second. */
export function etaText(ms) {
  if (!(ms > 0)) return '';
  if (ms < 0.75 * MINUTE) return 'under a minute left';
  const minutes = Math.round(ms / MINUTE);
  return minutes <= 1 ? 'about a minute left' : `about ${minutes} minutes left`;
}
