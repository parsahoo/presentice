// TTS client: worker lifecycle, generation queue and the audio cache.
import * as store from './store.js';
import { audioKey, sampleKey } from './keys.js';

const PRUNE_DELAY_MS = 4000;

const listeners = new Set();
const storageListeners = new Set();
const memory = new Map(); // cache key -> { url, duration }
const loading = new Map(); // cache key -> in-flight IndexedDB read
const waiters = new Map(); // cache key -> { text, voice, list: [{ resolve, reject, retry }] }
const failed = new Set(); // keys whose generation failed this session: never retried in the background
const keyMemo = new Map(); // `${dtype}\n${voice}\n${text}` -> key
let stored = new Set(); // cache keys present in IndexedDB
let worker = null;
let manifest = null;
let manifestBase = null;
let sampleMemo = new Map();
let queueToken = 0;
let lastOrder = [];
let lastKeys = new Set(); // keys of lastOrder, filled by requeue
let pruneTimer = 0;
let storageWarned = false;

const status = {
  phase: 'idle', // idle | loading | ready | error
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

function guessDtype() {
  return status.dtype || ('gpu' in navigator ? 'fp32' : 'q8');
}

/** Read preferences and the list of cached clips. */
export async function init() {
  const [saved, keys] = await Promise.all([store.get('app:dtype'), store.keys('audio:')]);
  if (saved && !status.dtype) status.dtype = saved;
  stored = new Set(keys.map((k) => k.slice('audio:'.length)));
}

/** Start loading the model. Safe to call more than once. */
export function start() {
  if (worker) return;
  status.phase = 'loading';
  status.error = null;
  emit();
  try {
    worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
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
}

export function retry() {
  worker?.terminate();
  worker = null;
  failed.clear();
  start();
}

function settle(key, fn) {
  const entry = waiters.get(key);
  waiters.delete(key);
  if (entry) for (const w of entry.list) fn(w);
}

function fail(message) {
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
      status.device = data.device;
      status.dtype = data.dtype;
      store.set('app:dtype', data.dtype).catch(() => {});
      if (changed) {
        keyMemo.clear();
        const pending = [...waiters.values()].flatMap((e) => e.list);
        waiters.clear();
        for (const w of pending) w.retry();
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

function accept(key, wav, duration) {
  if (!(duration > 0)) {
    failed.add(key);
    settle(key, (w) => w.reject(new Error('The voice engine returned no audio for this sentence.')));
    requeue();
    return;
  }
  const clip = remember(key, { url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })), duration });
  store.set(`audio:${key}`, { wav, duration }).then(
    () => stored.add(key),
    (err) => {
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
    const read = store
      .get(`audio:${key}`)
      .then((rec) => {
        if (!rec || !(rec.duration > 0)) {
          stored.delete(key);
          return null;
        }
        return memory.get(key) || remember(key, { url: URL.createObjectURL(new Blob([rec.wav], { type: 'audio/wav' })), duration: rec.duration });
      })
      .catch(() => null)
      .finally(() => loading.delete(key));
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
  if (memory.has(key)) return memory.get(key);
  const cached = await fromStore(key);
  if (cached) return cached;
  if (signal?.aborted) throw abortError();
  if (status.phase === 'error') throw new Error(status.error);
  // An explicit request gives a failed sentence one more try.
  failed.delete(key);
  start();
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
  emit();
  if (worker && status.phase === 'ready') worker.postMessage({ type: 'queue', jobs });
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
 * Forget the current project. The model stays loaded.
 * `keepStored`: the saved clips still belong to this project (a reload), so keep using them.
 */
export function reset({ keepStored = false } = {}) {
  clearTimeout(pruneTimer);
  for (const clip of memory.values()) URL.revokeObjectURL(clip.url);
  memory.clear();
  loading.clear();
  keyMemo.clear();
  failed.clear();
  if (!keepStored) stored = new Set();
  for (const key of [...waiters.keys()]) settle(key, (w) => w.reject(abortError()));
  lastOrder = [];
  lastKeys = new Set();
  manifest = null;
  sampleMemo = new Map();
  status.readyCount = 0;
  status.totalCount = 0;
  worker?.postMessage({ type: 'queue', jobs: [] });
  worker?.postMessage({ type: 'forget' });
  emit();
}
