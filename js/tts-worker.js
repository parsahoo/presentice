// Dedicated module worker: loads Kokoro and generates one sentence at a time.
// The page never runs inference.
import { trimSilence, encodeWav } from './wav.js';
import { MODEL_ID } from './keys.js';

const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

// onnxruntime prints routine warnings (such as node placement on WebGPU) through
// console.error, and kokoro-js exposes no log level. Keep them out of the error log.
const ORT_WARNING = /\[W:onnxruntime/;
const consoleError = console.error.bind(console);
console.error = (...args) => {
  if (typeof args[0] === 'string' && ORT_WARNING.test(args[0])) console.debug(...args);
  else consoleError(...args);
};
let KokoroTTS = null;
let tts = null;
let initPending = false;

// A stray error only means "the engine failed" while it is still starting.
// Once it is ready, one bad sentence reports a job-error and the rest keep working.
function onStrayError(message) {
  if (initPending) post({ type: 'error', message });
  else console.warn('Voice engine:', message);
}
self.addEventListener('error', (e) => onStrayError(e.message || 'Unknown error in the voice engine'));
self.addEventListener('unhandledrejection', (e) => onStrayError(String(e.reason?.message || e.reason)));
let queue = [];
let busy = false;
const done = new Set();

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

async function hasWebGpu() {
  try {
    if (!self.navigator?.gpu) return false;
    const adapter = await self.navigator.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

function progressReporter() {
  const files = new Map();
  let last = 0;
  return (p) => {
    if (!p || !p.file) return;
    if (p.status === 'progress' || p.status === 'done') {
      const prev = files.get(p.file) || { loaded: 0, total: 0 };
      const total = p.total || prev.total;
      const loaded = p.status === 'done' ? total || prev.loaded : p.loaded ?? prev.loaded;
      files.set(p.file, { loaded, total });
      const now = Date.now();
      if (p.status === 'done' || now - last > 150) {
        last = now;
        let sumLoaded = 0;
        let sumTotal = 0;
        for (const f of files.values()) {
          sumLoaded += f.loaded || 0;
          sumTotal += f.total || 0;
        }
        post({ type: 'progress', loaded: sumLoaded, total: sumTotal });
      }
    }
  };
}

async function load(device, dtype) {
  return KokoroTTS.from_pretrained(MODEL_ID, { dtype, device, progress_callback: progressReporter() });
}

// The page picks the engine (Voice quality) and never changes it behind the user's
// back, so a failure here is reported as it is instead of quietly loading something else.
function loadFailure(device) {
  return device === 'webgpu'
    ? 'High quality could not start on this computer. Switch Voice quality to Standard.'
    : 'The voice engine could not start. Check your connection and try again.';
}

async function init({ device, dtype }) {
  initPending = true;
  post({ type: 'backend', device, dtype });
  try {
    if (device === 'webgpu' && !(await hasWebGpu())) {
      throw new Error('This browser has no WebGPU adapter.');
    }
    if (!KokoroTTS) ({ KokoroTTS } = await import(KOKORO_URL));
    tts = await load(device, dtype);
    initPending = false;
    post({ type: 'ready', device, dtype });
    pump();
  } catch (err) {
    console.warn('Voice engine load failed', device, dtype, err);
    post({ type: 'error', message: loadFailure(device) });
  } finally {
    initPending = false;
  }
}

// Near-silent output would trim to nothing: keep the untrimmed audio instead.
function clipFrom(raw) {
  const trimmed = trimSilence(raw.audio, raw.sampling_rate);
  return trimmed.length ? trimmed : raw.audio;
}

async function pump() {
  if (busy || !tts) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    if (done.has(job.key)) continue;
    post({ type: 'started', key: job.key });
    try {
      const raw = await tts.generate(job.text, { voice: job.voice });
      const samples = clipFrom(raw);
      if (!samples.length) throw new Error('The voice engine returned no audio for this sentence.');
      const wav = encodeWav(samples, raw.sampling_rate);
      done.add(job.key);
      post({ type: 'audio', key: job.key, wav, duration: samples.length / raw.sampling_rate }, [wav]);
    } catch (err) {
      post({ type: 'job-error', key: job.key, message: String(err?.message || err) });
    }
  }
  busy = false;
}

self.onmessage = ({ data }) => {
  if (data.type === 'init') init(data);
  if (data.type === 'queue') {
    // Replace pending work; the generation in flight (if any) finishes on its own.
    queue = data.jobs.filter((j) => !done.has(j.key));
    pump();
  }
  if (data.type === 'forget') {
    if (Array.isArray(data.keys)) for (const key of data.keys) done.delete(key);
    else done.clear();
  }
};
