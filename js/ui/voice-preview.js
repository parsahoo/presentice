// Voice previews: one short pre-rendered clip per curated voice. Never starts the voice engine.

const audio = new Audio();
audio.preload = 'none';
let owner = null; // who asked for the clip that plays, for example "row-1"
const listeners = new Set();

function setOwner(next) {
  if (owner === next) return;
  owner = next;
  for (const fn of listeners) fn(owner);
}

audio.addEventListener('ended', () => setOwner(null));
audio.addEventListener('error', () => setOwner(null));

export function clipUrl(voiceId) {
  return new URL(`../../assets/voices/${voiceId}.mp3`, import.meta.url).href;
}

/** Play the clip for `voiceId`. `onError` runs when the browser refuses to play it. */
export function playVoice(voiceId, who, onError) {
  audio.pause();
  audio.src = clipUrl(voiceId);
  setOwner(who);
  audio.play().catch((err) => {
    if (err?.name === 'AbortError') return;
    setOwner(null);
    onError?.(err);
  });
}

export function stopVoice() {
  audio.pause();
  setOwner(null);
}

/** Who the playing clip belongs to, or null. */
export function previewOwner() {
  return owner;
}

export function onPreviewChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
