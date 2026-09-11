// TTS client: worker lifecycle, generation queue and the audio cache.
//
// Memory rules:
// - The voice engine (a worker holding the Kokoro model) exists only while a needed
//   sentence has no clip in IndexedDB or in the sample's pre-rendered audio. It
//   unloads after IDLE_UNLOAD_MS with nothing to make, and comes back on demand.
// - Clips live in IndexedDB. Object URLs exist only for a window around the
//   playback position (see setWindow); the rest are read back when needed.
import * as realStore from './store.js';
import { audioKey, sampleKey } from './keys.js';

// Replaceable in unit tests (see setTestDeps).
let store = realStore;
let createWorker = () => new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });

/** Tests only: swap the IndexedDB store and the worker factory. */
export function setTestDeps({ store: testStore, createWorker: testCreateWorker } = {}) {
  if (testStore) store = testStore;
  if (testCreateWorker) createWorker = testCreateWorker;
}

const PRUNE_DELAY_MS = 4000;
export const IDLE_UNLOAD_MS = 15000;

const listeners = new Set();
const storageListeners = new Set();
const memory = new Map(); // cache key -> { url, duration }: only clips near the position
const loading = new Map(); // cache key -> in-flight IndexedDB read
const waiters = new Map(); // cache key -> { text, voice, list: [{ resolve, reject, retry }] }
const failed = new Set(); // keys whose generation failed this session: never retried in the background
const unsaved = new Set(); // keys in memory not (yet) in IndexedDB: never dropped from memory
const keyMemo = new Map(); // `${dtype}\n${voice}\n${text}` -> key
let stored = new Set(); // cache keys present in IndexedDB
let worker = null;
let manifest = null;
let manifestBase = null;
let sampleMemo = new Map();
let queueToken = 0;
let lastOrder = [];
let lastKeys = new Set(); // keys of lastOrder, filled by requeue
let windowItems = [];
let windowKeys = new Set();
let windowToken = 0;
let projectEpoch = 0; // bumped by reset(): late async results from the old project are dropped
let served = null; // key of the clip get() handed out last: it may be playing
let pruneTimer = 0;
let unloadTimer = 0;
let storageWarned = false;

const status = {
  phase: 'idle', // idle (engine off) | loading | ready | error
  warm: false, // the model loaded on this device before: it comes from the browser cache
  device: null,
  dtype: null,
  loaded: 0,
  total: 0,
  readyCount: 0,
  totalCount: 0,
  error: null,
};

function emit() {
  for (const fn of listeners) fn({ ...status });
}

export function onStatus(fn) {
  listeners.add(fn);
  fn({ ...status });
  return () => listeners.delete(fn);
}

/** Called once per session when a clip could not be saved (for example, the disk is full). */
export function onStorageError(fn) {
  storageListeners.add(fn);
  return () => storageListeners.delete(fn);
}

export function getStatus() {
  return { ...status };
}

/** True while the voice engine (and so the model) is in memory. */
export function isEngineLoaded() {
  return Boolean(worker);
}

function guessDtype() {
  return status.dtype || ('gpu' in navigator ? 'fp32' : 'q8');
}

/** Read preferences and the list of cached clips. */
export async function init() {
  const [saved, keys] = await Promise.all([store.get('app:dtype'), store.keys('audio:')]);
  if (saved && !status.dtype) status.dtype = saved;
  // The dtype is saved when the model first loads, so it also means "the model is cached".
  status.warm = Boolean(saved);
  stored = new Set(keys.map((k) => k.slice('audio:'.length)));
}

/** Start the voice engine. Only called when there is audio to make. */
function startEngine() {
  if (worker) return;
  cancelUnload();
  status.phase = 'loading';
  status.error = null;
  status.loaded = 0;
  status.total = 0;
  try {
    worker = createWorker();
  } catch (err) {
    fail(String(err?.message || err));
    return;
  }
  worker.onmessage = ({ data }) => handle(data);
  worker.onerror = (e) => {
    e.preventDefault?.();
    fail(e.message || 'The voice engine stopped.');
  };
  worker.postMessage({ type: 'init' });
  emit();
}

function stopEngine() {
  if (!worker) return;
  worker.onmessage = null;
  worker.onerror = null;
  worker.terminate();
  worker = null;
}

/**
 * Download the model early for a new presentation, while the user works on the
 * script. Only when it has never loaded on this device: a cached model starts in
 * seconds when the first sentence needs it.
 */
export function prepare() {
  if (!status.warm && status.phase !== 'error') startEngine();
  requeue();
}

export function retry() {
  stopEngine();
  failed.clear();
  status.phase = 'idle';
  status.error = null;
  requeue();
  // A retry with nothing queued still checks that the engine loads.
  if (!worker) startEngine();
}

function cancelUnload() {
  clearTimeout(unloadTimer);
  unloadTimer = 0;
}

/** Nothing left to make: free the model after a quiet period. Loading is never cut short. */
function scheduleUnload() {
  if (!worker || unloadTimer || status.phase === 'loading') return;
  unloadTimer = setTimeout(() => {
    unloadTimer = 0;
    if (!worker || waiters.size || status.phase === 'loading') return;
    // Terminating the worker frees the model and its GPU buffers.
    stopEngine();
    status.phase = 'idle';
    status.loaded = 0;
    status.total = 0;
    emit();
  }, IDLE_UNLOAD_MS);
}

function settle(key, fn) {
  const entry = waiters.get(key);
  waiters.delete(key);
  if (entry) for (const w of entry.list) fn(w);
}

function fail(message) {
  // A broken engine keeps nothing useful: free it. Try again starts a new one.
  stopEngine();
  cancelUnload();
  status.phase = 'error';
  status.error = message;
  for (const key of [...waiters.keys()]) settle(key, (w) => w.reject(new Error(message)));
  emit();
}

function handle(data) {
  switch (data.type) {
    case 'backend':
      status.device = data.device;
      emit();
      break;
    case 'progress':
      status.loaded = data.loaded;
      status.total = data.total;
      emit();
      break;
    case 'ready': {
      const changed = status.dtype !== data.dtype;
      status.phase = 'ready';
      status.warm = true;
      status.device = data.device;
      status.dtype = data.dtype;
      store.set('app:dtype', data.dtype).catch(() => {});
      if (changed) {
        keyMemo.clear();
        const pending = [...waiters.values()].flatMap((e) => e.list);
        waiters.clear();
        for (const w of pending) w.retry();
        setWindow(windowItems);
      }
      emit();
      requeue();
      break;
    }
    case 'audio':
      accept(data.key, data.wav, data.duration);
      break;
    case 'job-error':
      failed.add(data.key);
      settle(data.key, (w) => w.reject(new Error(data.message)));
      emit();
      requeue();
      break;
    case 'error':
      fail(data.message);
      break;
    default:
      break;
  }
}

function warnStorage(err) {
  if (storageWarned) return;
  storageWarned = true;
  for (const fn of storageListeners) fn(err);
}

function remember(key, clip) {
  const old = memory.get(key);
  if (old && old.url !== clip.url) URL.revokeObjectURL(old.url);
  memory.set(key, clip);
  return clip;
}

function clipFrom(wav, duration) {
  return { url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })), duration };
}

/** Drop object URLs outside the window. Clips not yet saved, or maybe playing, stay. */
function trimMemory() {
  for (const [key, clip] of memory) {
    if (windowKeys.has(key) || key === served || unsaved.has(key) || waiters.has(key)) continue;
    URL.revokeObjectURL(clip.url);
    memory.delete(key);
  }
}

function accept(key, wav, duration) {
  if (!(duration > 0)) {
    failed.add(key);
    settle(key, (w) => w.reject(new Error('The voice engine returned no audio for this sentence.')));
    requeue();
    return;
  }
  const clip = remember(key, clipFrom(wav, duration));
  unsaved.add(key);
  store.set(`audio:${key}`, { wav, duration }).then(
    () => {
      stored.add(key);
      unsaved.delete(key);
      trimMemory();
    },
    (err) => {
      // Not saved: it stays in memory for this session, since it cannot be read back.
      console.warn('Could not save a voice clip', err);
      warnStorage(err);
    },
  );
  settle(key, (w) => w.resolve(clip));
  requeue();
}

/** Use pre-rendered clips for the sample deck. */
export async function useManifest(url) {
  if (!url) {
    manifest = null;
    sampleMemo = new Map();
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('Sample audio list not found');
  manifest = await res.json();
  manifestBase = new URL('.', new URL(url, location.href));
  sampleMemo = new Map();
}

async function keyFor(text, voice) {
  const dtype = guessDtype();
  const memoKey = `${dtype}\n${voice}\n${text}`;
  if (!keyMemo.has(memoKey)) keyMemo.set(memoKey, await audioKey(text, voice, dtype));
  return keyMemo.get(memoKey);
}

async function sampleClip(text, voice) {
  if (!manifest) return null;
  const memoKey = `${voice}\n${text}`;
  if (!sampleMemo.has(memoKey)) sampleMemo.set(memoKey, await sampleKey(text, voice));
  const item = manifest.items[sampleMemo.get(memoKey)];
  return item ? { url: new URL(item.file, manifestBase).href, duration: item.duration } : null;
}

function fromStore(key) {
  if (!stored.has(key)) return Promise.resolve(null);
  // Two callers asking at once share one read and one object URL.
  if (!loading.has(key)) {
    const epoch = projectEpoch;
    const read = store
      .get(`audio:${key}`)
      .then((rec) => {
        // The project changed while reading: this clip is not wanted any more.
        if (epoch !== projectEpoch) return null;
        if (!rec || !(rec.duration > 0)) {
          stored.delete(key);
          return null;
        }
        return memory.get(key) || remember(key, clipFrom(rec.wav, rec.duration));
      })
      .catch((err) => {
        // Unreadable: treat the sentence as pending, so it is counted and made again.
        console.warn('Could not read a saved voice clip', err);
        if (epoch === projectEpoch) stored.delete(key);
        return null;
      })
      .finally(() => {
        if (loading.get(key) === read) loading.delete(key);
      });
    loading.set(key, read);
  }
  return loading.get(key);
}

function abortError() {
  return new DOMException('The request was cancelled.', 'AbortError');
}

/**
 * Get audio for a sentence. Resolves when ready; generation is requested at the
 * front of the queue if needed. Pass an AbortSignal to drop interest.
 */
export async function get(text, voice, { signal } = {}) {
  const sample = await sampleClip(text, voice);
  if (sample) return sample;
  const key = await keyFor(text, voice);
  const cached = memory.get(key) || (await fromStore(key));
  if (cached) {
    served = key;
    return cached;
  }
  if (signal?.aborted) throw abortError();
  if (status.phase === 'error') throw new Error(status.error);
  // An explicit request gives a failed sentence one more try.
  failed.delete(key);
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    const remove = () => {
      const entry = waiters.get(key);
      if (!entry) return;
      entry.list = entry.list.filter((w) => w !== waiter);
      if (!entry.list.length) waiters.delete(key);
    };
    const onAbort = () => {
      remove();
      reject(abortError());
      requeue();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiter.resolve = (clip) => {
      signal?.removeEventListener('abort', onAbort);
      served = key;
      resolve(clip);
    };
    waiter.reject = (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
    // If the backend turns out different, the key changes: ask again.
    waiter.retry = () => {
      signal?.removeEventListener('abort', onAbort);
      get(text, voice, { signal }).then(resolve, reject);
    };
    const entry = waiters.get(key) || { text, voice, list: [] };
    entry.list.push(waiter);
    waiters.set(key, entry);
    requeue();
  });
}

/**
 * Keep these sentences ready in memory ([{ text, voice }], most urgent first):
 * read them from IndexedDB ahead of time, and drop every other object URL.
 */
export async function setWindow(items) {
  windowItems = items;
  const token = ++windowToken;
  const keys = [];
  for (const { text, voice } of items) {
    if (await sampleClip(text, voice)) continue;
    keys.push(await keyFor(text, voice));
  }
  if (token !== windowToken) return;
  windowKeys = new Set(keys);
  trimMemory();
  for (const key of keys) if (!memory.has(key)) fromStore(key);
}

/**
 * Replace the generation order. `items` is [{ text, voice }] in priority order.
 */
export function prioritize(items) {
  lastOrder = items;
  requeue();
}

async function requeue() {
  const token = ++queueToken;
  const jobs = [];
  const seen = new Set();
  let ready = 0;
  // Whatever a caller is waiting for goes first, even if it left the order
  // (a voice change or a script edit while that sentence was waiting).
  for (const [key, entry] of waiters) {
    if (seen.has(key) || memory.has(key)) continue;
    seen.add(key);
    jobs.push({ key, text: entry.text, voice: entry.voice });
  }
  const orderKeys = new Set();
  for (const { text, voice } of lastOrder) {
    if (await sampleClip(text, voice)) {
      ready += 1;
      continue;
    }
    const key = await keyFor(text, voice);
    if (orderKeys.has(key)) continue;
    orderKeys.add(key);
    if (memory.has(key) || stored.has(key)) ready += 1;
    else if (!seen.has(key) && !failed.has(key)) {
      seen.add(key);
      jobs.push({ key, text, voice });
    }
  }
  if (token !== queueToken) return;
  lastKeys = orderKeys;
  const pending = [...orderKeys].filter((k) => !memory.has(k) && !stored.has(k) && !failed.has(k)).length;
  status.readyCount = ready;
  status.totalCount = ready + pending;
  if (jobs.length) {
    cancelUnload();
    // The engine starts only here: a sentence that is needed has no audio anywhere.
    if (!worker && status.phase !== 'error') startEngine();
  }
  emit();
  if (worker && status.phase === 'ready') worker.postMessage({ type: 'queue', jobs });
  if (!jobs.length) scheduleUnload();
  schedulePrune();
}

function schedulePrune() {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(prune, PRUNE_DELAY_MS);
}

/**
 * Drop clips the current script and voices no longer use, from IndexedDB and
 * from memory. Runs only once the backend (and so every key) is known.
 */
async function prune() {
  if (!status.dtype || !lastOrder.length || !lastKeys.size) return;
  const keep = new Set([...lastKeys, ...waiters.keys()]);
  const dropped = [];
  for (const [key, clip] of memory) {
    if (!keep.has(key)) {
      URL.revokeObjectURL(clip.url);
      memory.delete(key);
      unsaved.delete(key);
      dropped.push(key);
    }
  }
  const stale = [...stored].filter((k) => !keep.has(k));
  // The worker skips keys it already made; let it make these again if they come back.
  const forget = [...new Set([...dropped, ...stale])];
  if (forget.length) worker?.postMessage({ type: 'forget', keys: forget });
  if (!stale.length) return;
  try {
    await store.delMany(stale.map((k) => `audio:${k}`));
    for (const k of stale) stored.delete(k);
  } catch (err) {
    console.warn('Could not remove old voice clips', err);
  }
}

/**
 * Forget the current project. A loaded engine stays until it has been idle a while.
 * `keepStored`: the saved clips still belong to this project (a reload), so keep using them.
 */
export function reset({ keepStored = false } = {}) {
  clearTimeout(pruneTimer);
  for (const clip of memory.values()) URL.revokeObjectURL(clip.url);
  memory.clear();
  loading.clear();
  keyMemo.clear();
  failed.clear();
  unsaved.clear();
  if (!keepStored) stored = new Set();
  for (const key of [...waiters.keys()]) settle(key, (w) => w.reject(abortError()));
  lastOrder = [];
  lastKeys = new Set();
  windowItems = [];
  windowKeys = new Set();
  windowToken += 1;
  // A requeue still hashing keys for the old project must not post its jobs or start the engine.
  queueToken += 1;
  projectEpoch += 1;
  served = null;
  manifest = null;
  sampleMemo = new Map();
  status.readyCount = 0;
  status.totalCount = 0;
  worker?.postMessage({ type: 'queue', jobs: [] });
  worker?.postMessage({ type: 'forget' });
  scheduleUnload();
  emit();
}
