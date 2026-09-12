// Voice engine lifecycle and memory trimming in js/tts.js, with a fake store,
// a fake worker and fake object URLs. Tests share the module state, so each one
// starts with fresh() and they run in order.
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as tts from '../js/tts.js';
import { audioKey, legacyAudioKey } from '../js/keys.js';

const DTYPE = 'q8';
const ENGINE = { dtype: 'q8', device: 'wasm' }; // Standard, the default quality
const HIGH_ENGINE = { dtype: 'fp32', device: 'webgpu' };
const VOICE = 'af_heart';
const realTimeout = globalThis.setTimeout;

// Fake object URLs -----------------------------------------------------------
let urlCount = 0;
const revoked = new Set();
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

// Fake IndexedDB store -------------------------------------------------------
function fakeStore(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    failGets: new Set(), // keys whose read rejects
    holdSets: false, // when true, set() never settles (the clip stays unsaved)
    async get(key) {
      if (this.failGets.has(key)) throw new Error('read failed');
      return data.get(key);
    },
    set(key, value) {
      if (this.holdSets) return new Promise(() => {});
      data.set(key, value);
      return Promise.resolve();
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
    async delMany(keys) {
      for (const k of keys) data.delete(k);
    },
  };
}

// Fake worker ----------------------------------------------------------------
const workers = []; // created during the current test
const allWorkers = [];
class FakeWorker {
  constructor() {
    this.sent = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    workers.push(this);
    allWorkers.push(this);
  }
  postMessage(message) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** Deliver a message the way a real worker would: only if a handler is attached. */
  reply(data) {
    this.onmessage?.({ data });
  }
  lastQueue() {
    return [...this.sent].reverse().find((m) => m.type === 'queue');
  }
}

const clipRecord = (seconds = 1) => ({ wav: new ArrayBuffer(8), duration: seconds });
const keyOf = (text) => audioKey(text, VOICE, ENGINE);
const item = (text) => ({ text, voice: VOICE });

/** Let async work (hashing, fake store reads) finish. */
async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => realTimeout(resolve, 2));
}

let store;
/** A clean module state with these sentences already saved, and no engine. */
async function fresh(savedTexts = [], { warm = true, legacy = [], legacyFp32 = [] } = {}) {
  // A loading engine is never unloaded: let any live one finish loading first.
  for (const w of allWorkers) if (!w.terminated) w.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  tts.setQuality('standard');
  tts.reset();
  mock.timers.tick(tts.IDLE_UNLOAD_MS + 1);
  assert.equal(tts.isEngineLoaded(), false, 'the previous test left no engine');
  const entries = warm ? { 'app:warm': ['standard'] } : {};
  for (const text of savedTexts) entries[`audio:${await keyOf(text)}`] = clipRecord();
  // Clips written by the released version, whose key had no device in it. That version
  // ran q8 on a WebAssembly machine and fp32 on a WebGPU one, so both dtypes exist out there.
  for (const text of legacy) entries[`audio:${await legacyAudioKey(text, VOICE, DTYPE)}`] = clipRecord();
  for (const text of legacyFp32) entries[`audio:${await legacyAudioKey(text, VOICE, 'fp32')}`] = clipRecord();
  store = fakeStore(entries);
  tts.setTestDeps({ store });
  await tts.init();
  workers.length = 0;
  revoked.clear();
}

before(() => {
  URL.createObjectURL = () => `blob:fake/${(urlCount += 1)}`;
  URL.revokeObjectURL = (url) => revoked.add(url);
  tts.setTestDeps({ createWorker: () => new FakeWorker() });
  mock.timers.enable({ apis: ['setTimeout'] });
});

after(() => {
  mock.timers.reset();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

test('no worker starts when every needed clip is saved', async () => {
  await fresh(['One.', 'Two.']);
  tts.prioritize([item('One.'), item('Two.')]);
  tts.prepare();
  await flush();
  const clip = await tts.get('One.', VOICE);
  await flush();
  assert.equal(workers.length, 0);
  assert.equal(tts.isEngineLoaded(), false);
  assert.match(clip.url, /^blob:fake\//);
  assert.equal(tts.getStatus().readyCount, 2);
  assert.equal(tts.getStatus().totalCount, 2);
});

test('prepare downloads the model early only on a first visit', async () => {
  await fresh([], { warm: false });
  tts.prepare();
  await flush();
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].sent[0], { type: 'init', device: 'wasm', dtype: 'q8' });

  await fresh([], { warm: true });
  tts.prepare();
  await flush();
  assert.equal(workers.length, 0);
});

test('a missing clip starts the engine, then it unloads after IDLE_UNLOAD_MS', async () => {
  await fresh(['One.']);
  tts.prioritize([item('One.'), item('Two.')]);
  await flush();
  assert.equal(workers.length, 1);
  const worker = workers[0];
  worker.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  const twoKey = await keyOf('Two.');
  assert.deepEqual(worker.lastQueue().jobs.map((j) => j.key), [twoKey]);

  const pending = tts.get('Two.', VOICE);
  await flush();
  worker.reply({ type: 'audio', key: twoKey, wav: new ArrayBuffer(8), duration: 1.5 });
  const clip = await pending;
  await flush();
  assert.equal(clip.duration, 1.5);
  assert.ok(store.data.has(`audio:${twoKey}`));
  assert.equal(tts.getStatus().readyCount, 2);

  mock.timers.tick(tts.IDLE_UNLOAD_MS - 1);
  assert.equal(worker.terminated, false);
  mock.timers.tick(2);
  assert.equal(worker.terminated, true);
  assert.equal(tts.isEngineLoaded(), false);
  assert.equal(tts.getStatus().phase, 'idle');
});

test('the engine stays while a caller waits, and restarts on demand after unloading', async () => {
  await fresh([]);
  tts.prioritize([item('One.')]);
  await flush();
  const first = workers[0];
  first.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  const oneKey = await keyOf('One.');
  first.reply({ type: 'audio', key: oneKey, wav: new ArrayBuffer(8), duration: 1 });
  await flush();

  // The unload timer is running. A caller now waits for a new sentence.
  const waiting = tts.get('Three.', VOICE);
  await flush();
  mock.timers.tick(tts.IDLE_UNLOAD_MS * 2);
  assert.equal(first.terminated, false, 'no unload while a caller waits');
  first.reply({ type: 'audio', key: await keyOf('Three.'), wav: new ArrayBuffer(8), duration: 1 });
  await waiting;
  await flush();

  mock.timers.tick(tts.IDLE_UNLOAD_MS + 1);
  assert.equal(first.terminated, true);

  const again = tts.get('Four.', VOICE);
  await flush();
  assert.equal(workers.length, 2, 'a new engine starts on demand');
  const second = workers[1];
  second.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  second.reply({ type: 'audio', key: await keyOf('Four.'), wav: new ArrayBuffer(8), duration: 1 });
  assert.equal((await again).duration, 1);
});

test('a late message from a terminated worker is ignored', async () => {
  await fresh([]);
  tts.prioritize([item('One.')]);
  await flush();
  const old = workers[0];
  old.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  tts.prioritize([]);
  await flush();
  mock.timers.tick(tts.IDLE_UNLOAD_MS + 1);
  assert.equal(old.terminated, true);

  const before = tts.getStatus();
  old.reply({ type: 'error', message: 'late crash' });
  old.reply({ type: 'audio', key: await keyOf('One.'), wav: new ArrayBuffer(8), duration: 1 });
  await flush();
  assert.equal(old.onmessage, null);
  assert.equal(tts.getStatus().phase, before.phase);
  assert.equal(tts.getStatus().error, null);
  assert.equal(store.data.has(`audio:${await keyOf('One.')}`), false);
});

test('trimMemory drops clips outside the window but never the served one', async () => {
  await fresh(['A.', 'B.', 'C.']);
  await tts.setWindow([item('A.')]);
  await flush();
  const a = await tts.get('A.', VOICE);
  const c = await tts.get('C.', VOICE); // served last: it may be playing
  await tts.setWindow([item('B.')]);
  await flush();
  assert.ok(revoked.has(a.url), 'A left the window');
  assert.equal(revoked.has(c.url), false, 'the served clip stays');
});

test('trimMemory never drops a clip that is not saved yet', async () => {
  await fresh([]);
  tts.prioritize([item('New.')]);
  await flush();
  const worker = workers[0];
  worker.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  store.holdSets = true;
  const pending = tts.get('New.', VOICE);
  await flush();
  worker.reply({ type: 'audio', key: await keyOf('New.'), wav: new ArrayBuffer(8), duration: 1 });
  const clip = await pending;
  await tts.get('Other.', VOICE, { signal: AbortSignal.abort() }).catch(() => {});
  await tts.setWindow([]);
  await flush();
  assert.equal(revoked.has(clip.url), false);
});

test('reset during a pending requeue does not start the engine for the old project', async () => {
  await fresh([]);
  tts.prioritize([item('Old project sentence.')]);
  tts.reset(); // before the key hashing finishes
  await flush();
  assert.equal(workers.length, 0);
  assert.equal(tts.getStatus().totalCount, 0);
});

test('an unreadable saved clip is logged, counted as pending and made again', async () => {
  await fresh(['Broken.']);
  store.failGets.add(`audio:${await keyOf('Broken.')}`);
  const warn = mock.method(console, 'warn', () => {});
  const pending = tts.get('Broken.', VOICE);
  await flush();
  assert.equal(warn.mock.callCount(), 1);
  warn.mock.restore();
  assert.equal(workers.length, 1, 'the sentence is generated instead');
  const worker = workers[0];
  worker.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  worker.reply({ type: 'audio', key: await keyOf('Broken.'), wav: new ArrayBuffer(8), duration: 2 });
  assert.equal((await pending).duration, 2);
});

test('Standard is what loads by default', async () => {
  await fresh([], { warm: false });
  tts.prepare();
  await flush();
  assert.equal(tts.getQuality(), 'standard');
  assert.deepEqual(workers[0].sent[0], { type: 'init', device: 'wasm', dtype: 'q8' });
  assert.equal(tts.getStatus().dtype, 'q8');
  assert.equal(tts.getStatus().device, 'wasm');
  // Leave no engine behind for the next test.
  workers[0].reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
});

test('switching quality regenerates and keeps the clips of the other setting', async () => {
  await fresh(['One.']);
  tts.prioritize([item('One.')]);
  await flush();
  assert.equal(workers.length, 0, 'Standard already has this sentence');

  tts.setQuality('high');
  await flush();
  assert.equal(workers.length, 1, 'High needs its own clip');
  const worker = workers[0];
  assert.deepEqual(worker.sent[0], { type: 'init', device: 'webgpu', dtype: 'fp32' });
  worker.reply({ type: 'ready', device: 'webgpu', dtype: 'fp32' });
  await flush();
  const highKey = await audioKey('One.', VOICE, HIGH_ENGINE);
  const standardKey = await keyOf('One.');
  assert.notEqual(highKey, standardKey, 'the cache key includes the dtype and device');
  assert.deepEqual(worker.lastQueue().jobs.map((j) => j.key), [highKey]);
  worker.reply({ type: 'audio', key: highKey, wav: new ArrayBuffer(8), duration: 1 });
  await flush();

  // Pruning must not throw away the Standard clip of the same sentence.
  mock.timers.tick(5000);
  await flush();
  assert.ok(store.data.has(`audio:${standardKey}`), 'the Standard clip is kept');
  assert.ok(store.data.has(`audio:${highKey}`));

  // Back to Standard: nothing to make, and the engine is freed at once.
  tts.setQuality('standard');
  await flush();
  assert.equal(worker.terminated, true, 'the High model and its GPU memory are freed');
  assert.equal(tts.isEngineLoaded(), false);
  assert.equal(tts.getStatus().readyCount, 1);
  assert.equal(tts.getStatus().totalCount, 1);
});

test('an engine error rejects waiters, and retry starts a new engine', async () => {
  await fresh([]);
  const pending = tts.get('One.', VOICE);
  await flush();
  const broken = workers[0];
  broken.reply({ type: 'error', message: 'no backend' });
  await assert.rejects(pending, /no backend/);
  assert.equal(broken.terminated, true);
  assert.equal(tts.getStatus().phase, 'error');
  await assert.rejects(tts.get('One.', VOICE), /no backend/);

  tts.retry();
  await flush();
  assert.equal(workers.length, 2);
  assert.equal(tts.getStatus().phase, 'loading');
  // Leave a clean state behind.
  workers[1].reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  tts.reset();
  mock.timers.tick(tts.IDLE_UNLOAD_MS + 1);
});

test('a clip saved before the cache key changed is carried over, not made again', async () => {
  await fresh([], { legacy: ['One.'] });
  const legacyKey = await legacyAudioKey('One.', VOICE, DTYPE);
  const key = await keyOf('One.');
  assert.notEqual(key, legacyKey, 'the key format did change');
  tts.prioritize([item('One.')]);
  await flush();
  assert.equal(workers.length, 0, 'nothing is made again');
  assert.equal(tts.getStatus().readyCount, 1);
  assert.equal(tts.getStatus().totalCount, 1);
  const clip = await tts.get('One.', VOICE);
  await flush();
  assert.equal(clip.duration, 1);
  assert.ok(store.data.has(`audio:${key}`), 'the clip now has the current key');
  assert.equal(store.data.has(`audio:${legacyKey}`), false, 'and is kept only once');
});

test('a clip from a pre-upgrade WebGPU machine is carried over to High, never swept', async () => {
  await fresh([], { legacyFp32: ['One.'] });
  const legacyKey = await legacyAudioKey('One.', VOICE, 'fp32');
  const highKey = await audioKey('One.', VOICE, HIGH_ENGINE);
  // The upgraded app opens on Standard, so this deck's clips belong to the other quality.
  assert.equal(tts.getQuality(), 'standard');
  tts.prioritize([item('One.')]);
  await flush();
  workers[0].reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  mock.timers.tick(5000); // the prune that used to delete it
  await flush();
  assert.ok(store.data.has(`audio:${highKey}`), 'it now has the High key');
  assert.equal(store.data.has(`audio:${legacyKey}`), false, 'and is kept only once');

  tts.setQuality('high');
  await flush();
  assert.equal(tts.isEngineLoaded(), false, 'High has nothing to make: the clip was saved');
  assert.equal(tts.getStatus().readyCount, 1);
  assert.equal(tts.getStatus().totalCount, 1);
});

test('picking High before the first practice keeps the pre-upgrade Standard clips', async () => {
  await fresh([], { legacy: ['One.'] });
  const legacyKey = await legacyAudioKey('One.', VOICE, DTYPE);
  const standardKey = await keyOf('One.');
  const highKey = await audioKey('One.', VOICE, HIGH_ENGINE);
  tts.setQuality('high'); // before anything was ever queued at Standard
  tts.prioritize([item('One.')]);
  await flush();
  const worker = workers[0];
  assert.deepEqual(worker.sent[0], { type: 'init', device: 'webgpu', dtype: 'fp32' });
  worker.reply({ type: 'ready', device: 'webgpu', dtype: 'fp32' });
  await flush();
  worker.reply({ type: 'audio', key: highKey, wav: new ArrayBuffer(8), duration: 1 });
  await flush();
  mock.timers.tick(5000);
  await flush();
  assert.ok(store.data.has(`audio:${standardKey}`), 'the saved deck was carried over, not deleted');
  assert.equal(store.data.has(`audio:${legacyKey}`), false, 'and is kept only once');

  tts.setQuality('standard');
  await flush();
  assert.equal(tts.isEngineLoaded(), false, 'nothing is made again at Standard');
  assert.equal(tts.getStatus().readyCount, 1);
});

test('the status estimate appears once enough sentences are measured', async () => {
  await fresh([]);
  const texts = ['First one here.', 'Second one here.', 'Third one here.', 'Fourth one here.'];
  tts.prioritize(texts.map(item));
  await flush();
  const worker = workers[0];
  worker.reply({ type: 'ready', device: 'wasm', dtype: DTYPE });
  await flush();
  assert.equal(tts.getStatus().etaMs, null, 'nothing is estimated before a sentence is measured');
  const seen = [];
  for (const text of texts.slice(0, 3)) {
    const key = await keyOf(text);
    worker.reply({ type: 'started', key });
    await flush(); // time passes while the worker makes this sentence
    worker.reply({ type: 'audio', key, wav: new ArrayBuffer(8), duration: 1 });
    await flush();
    seen.push(tts.getStatus().etaMs);
  }
  assert.deepEqual(seen.slice(0, 2), [null, null], 'one or two sentences are not evidence yet');
  assert.equal(typeof seen[2], 'number', 'the fourth sentence has a measured estimate');
  assert.ok(seen[2] > 0);
  // Leave a clean state behind.
  tts.reset();
  mock.timers.tick(tts.IDLE_UNLOAD_MS + 1);
});
