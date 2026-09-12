// Writing the script with the user's own Google Gemini key.
//
// The key lives in this browser and is sent to Google only, in a header, never in a
// URL or a query string, and never to any server of ours. Nothing here logs it.
//
// Model: gemini-2.0-flash was shut down, so this uses gemini-3.8-flash, listed as the
// newest stable flash model on ai.google.dev/gemini-api/docs/models on 2026-09-12.
// Models do get retired, so a 404 from Google is reported as "this app needs an
// update" and points at Copy prompt, which never depends on a model id.
import { classifyLine } from './script-parser.js';

export const MODEL_ID = 'gemini-3.8-flash';
export const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;
export const KEY_STORAGE = 'presentice:ai-key';
export const KEY_PAGE = 'https://aistudio.google.com/apikey';
export const TIMEOUT_MS = 90000;

const MESSAGES = {
  'no-key': 'Paste your Gemini API key first, or use Copy prompt instead.',
  'invalid-key': 'Google refused that key. Check it in AI Studio, or paste a new one.',
  'rate-limit': 'This key has reached its free limit for now. Wait a minute and try again, or use Copy prompt.',
  offline: 'This browser is offline. Connect and try again.',
  blocked: 'The browser blocked the request to Google. Use Copy prompt instead.',
  server: 'Google could not answer just now. Try again in a moment.',
  'model-gone': 'The AI writer needs an update. Use Copy prompt instead.',
  refused: 'Google would not answer this prompt. Use Copy prompt and a chat instead.',
  empty: 'Google sent back an empty answer. Try again, or use Copy prompt.',
  unusable: 'The answer had no Slide lines in it, so it was not used. Try again, or use Copy prompt.',
  timeout: 'Google did not answer in time. Try again, or use Copy prompt.',
};

/** One failure the user can be told about plainly. `kind` is a key of MESSAGES. */
export class AiError extends Error {
  constructor(kind) {
    super(MESSAGES[kind] || MESSAGES.empty);
    this.name = 'AiError';
    this.kind = kind;
  }
}

/** The sentence to show for any failure, including ones we did not raise. */
export function errorText(err) {
  if (err instanceof AiError) return err.message;
  if (err?.name === 'AbortError') return MESSAGES.timeout;
  return MESSAGES.empty;
}

/**
 * The request for one prompt. The key goes in the x-goog-api-key header, so it never
 * appears in the URL, in a referrer or in the browser history.
 */
export function buildRequest(prompt, key) {
  return {
    url: ENDPOINT,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 },
      }),
    },
  };
}

function kindForStatus(status) {
  if (status === 400 || status === 401 || status === 403) return 'invalid-key';
  if (status === 429) return 'rate-limit';
  // Google answers 404 NOT_FOUND for a model id that no longer exists: retrying never helps.
  if (status === 404) return 'model-gone';
  return 'server';
}

/** The text of the answer. Throws AiError('refused') when Google declined to answer. */
export function parseResponse(json) {
  const candidate = json?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
  if (text) return text;
  const blocked = json?.promptFeedback?.blockReason
    || (candidate?.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS');
  throw new AiError(blocked ? 'refused' : 'empty');
}

/** The contents of the first fenced code block, or the whole text when there is none. */
function unfence(text) {
  const fenced = /(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*(?:\n|$)/.exec(text);
  if (fenced) return fenced[2].trim();
  // An answer cut off at the token cap opens its fence and never closes it. Keep what
  // came after the opening fence, so the preamble and the backticks are not spoken aloud.
  const opened = /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n/.exec(text);
  return (opened ? text.slice(opened.index + opened[0].length) : text).trim();
}

/**
 * The script inside an answer: the code block if there is one, the plain text otherwise.
 * Throws AiError('unusable') for an answer with no Slide lines, such as a refusal in prose.
 */
export function extractScript(answer) {
  const script = unfence(String(answer ?? ''));
  if (!script) throw new AiError('empty');
  const hasSlides = script.split('\n').some((line) => classifyLine(line) === 'marker');
  if (!hasSlides) throw new AiError('unusable');
  return script;
}

/**
 * One request's signal: the caller's, and a deadline that always exists. AbortSignal.timeout
 * and AbortSignal.any are missing in older browsers, where a request with no deadline would
 * leave the button on "Writing your script" for good, with no way to ask again.
 * @returns {{ signal: AbortSignal, timedOut: () => boolean, cancel: () => void }}
 */
function deadline(signal, timeoutMs) {
  if (AbortSignal.timeout && (!signal || AbortSignal.any)) {
    const timer = AbortSignal.timeout(timeoutMs);
    return {
      signal: signal ? AbortSignal.any([signal, timer]) : timer,
      timedOut: () => timer.aborted,
      cancel: () => {},
    };
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new DOMException('The request took too long.', 'TimeoutError')), timeoutMs);
  const relay = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', relay, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.reason?.name === 'TimeoutError',
    cancel: () => {
      clearTimeout(id);
      signal?.removeEventListener('abort', relay);
    },
  };
}

/**
 * Ask Google for the script. `fetchImpl` exists so tests can stub the network.
 * @returns {Promise<string>} the script text, ready for the textarea
 */
export async function requestScript(prompt, key, { fetchImpl, signal, timeoutMs = TIMEOUT_MS } = {}) {
  if (!String(key || '').trim()) throw new AiError('no-key');
  const send = fetchImpl || globalThis.fetch;
  const { url, options } = buildRequest(prompt, String(key).trim());
  const clock = deadline(signal, timeoutMs);
  try {
    let res;
    try {
      res = await send(url, { ...options, signal: clock.signal });
    } catch (err) {
      if (err?.name === 'TimeoutError' || clock.timedOut()) throw new AiError('timeout');
      if (err?.name === 'AbortError') throw err;
      // fetch rejects the same way for a blocked request and for no network at all.
      throw new AiError(globalThis.navigator?.onLine === false ? 'offline' : 'blocked');
    }
    if (!res.ok) throw new AiError(kindForStatus(res.status));
    let json;
    try {
      json = await res.json();
    } catch (err) {
      // The deadline can fire once the headers are in: that is a timeout, not a bad answer.
      if (err?.name === 'TimeoutError' || clock.timedOut()) throw new AiError('timeout');
      if (err?.name === 'AbortError' && signal?.aborted) throw err;
      throw new AiError('empty');
    }
    return extractScript(parseResponse(json));
  } finally {
    clock.cancel();
  }
}

// Key storage. localStorage throws in some privacy modes, so every call is guarded.
export function loadKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function saveKey(key) {
  try {
    localStorage.setItem(KEY_STORAGE, String(key).trim());
    return true;
  } catch {
    return false;
  }
}

export function removeKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Nothing to clean up: the key was never stored.
  }
}
