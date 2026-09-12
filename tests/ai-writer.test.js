// Writing the script with a Gemini key (js/ai-writer.js). No real call is ever made:
// fetch is stubbed, so the request itself and every failure path are checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AiError,
  ENDPOINT,
  MODEL_ID,
  buildRequest,
  errorText,
  extractScript,
  parseResponse,
  requestScript,
} from '../js/ai-writer.js';

const KEY = 'test-key-not-a-real-one';
const SCRIPT = 'Slide 1\nAlex: Good morning.\n\nSlide 2\nAlex: Here is the plan.';
const answer = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const failed = (status) => ({ ok: false, status, json: async () => ({}) });

async function kindOf(promise) {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err.kind || err.name;
  }
}

test('the key travels in a header, never in the URL', () => {
  const { url, options } = buildRequest('Write my script', KEY);
  assert.equal(url, ENDPOINT);
  assert.equal(url.includes(KEY), false);
  assert.equal(url.includes('?'), false);
  assert.equal(options.headers['x-goog-api-key'], KEY);
  assert.equal(options.method, 'POST');
  assert.match(ENDPOINT, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\//);
  assert.match(ENDPOINT, new RegExp(`${MODEL_ID}:generateContent$`));
});

test('the prompt is sent exactly as it was built', () => {
  const prompt = 'Slide 1: Brightside\nWrite the spoken script.';
  const { options } = buildRequest(prompt, KEY);
  assert.deepEqual(JSON.parse(options.body).contents, [{ role: 'user', parts: [{ text: prompt }] }]);
});

test('an answer in a code block gives the script inside it', () => {
  const reply = `Here is your script:\n\n\`\`\`\n${SCRIPT}\n\`\`\`\n\nHope it helps.`;
  assert.equal(extractScript(parseResponse(answer(reply))), SCRIPT);
});

test('a fenced block with a language tag works too', () => {
  const reply = `\`\`\`text\n${SCRIPT}\n\`\`\``;
  assert.equal(extractScript(reply), SCRIPT);
});

test('an answer cut off at the token cap keeps the script, not the preamble or the fence', () => {
  const cut = `Here is your script:\n\n\`\`\`\n${SCRIPT}\n\nSlide 3\nAlex: And the last thing to`;
  const reply = { candidates: [{ content: { parts: [{ text: cut }] }, finishReason: 'MAX_TOKENS' }] };
  const script = extractScript(parseResponse(reply));
  assert.ok(script.startsWith('Slide 1'), script);
  assert.equal(script.includes('Here is your script'), false, 'the preamble is not spoken aloud');
  assert.equal(script.includes('```'), false, 'and neither are the backticks');
});

test('a plain answer with Slide lines is used as it is', () => {
  assert.equal(extractScript(`  ${SCRIPT}  `), SCRIPT);
});

test('a refusal in prose is reported, never pasted into the script', () => {
  const refusal = "I'm sorry, I can't help with that request.";
  assert.equal(kindOfSync(() => extractScript(refusal)), 'unusable');
  assert.match(errorText(new AiError('unusable')), /no Slide lines/);
});

test('a blocked prompt and a stopped answer are refusals', () => {
  assert.equal(kindOfSync(() => parseResponse({ promptFeedback: { blockReason: 'SAFETY' } })), 'refused');
  assert.equal(
    kindOfSync(() => parseResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })),
    'refused',
  );
});

test('an empty answer is reported as empty', () => {
  assert.equal(kindOfSync(() => parseResponse({})), 'empty');
  assert.equal(kindOfSync(() => parseResponse(answer('   '))), 'empty');
});

function kindOfSync(fn) {
  try {
    fn();
    return 'returned';
  } catch (err) {
    return err.kind || err.name;
  }
}

test('a good call returns the script and sends one request', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return ok(answer(`\`\`\`\n${SCRIPT}\n\`\`\``));
  };
  const script = await requestScript('the prompt', KEY, { fetchImpl, timeoutMs: 50 });
  assert.equal(script, SCRIPT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes(KEY), false);
  assert.equal(calls[0].options.headers['x-goog-api-key'], KEY);
});

test('no key never reaches the network', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return ok(answer(SCRIPT));
  };
  assert.equal(await kindOf(requestScript('p', '  ', { fetchImpl, timeoutMs: 50 })), 'no-key');
  assert.equal(called, false);
});

test('every HTTP failure has its own plain message', async () => {
  const forStatus = (status) => requestScript('p', KEY, { fetchImpl: async () => failed(status), timeoutMs: 50 });
  assert.equal(await kindOf(forStatus(401)), 'invalid-key');
  assert.equal(await kindOf(forStatus(403)), 'invalid-key');
  assert.equal(await kindOf(forStatus(400)), 'invalid-key');
  assert.equal(await kindOf(forStatus(429)), 'rate-limit');
  assert.equal(await kindOf(forStatus(500)), 'server');
  assert.equal(await kindOf(forStatus(503)), 'server');
  // A retired model id answers 404 forever: say so, instead of "try again in a moment".
  assert.equal(await kindOf(forStatus(404)), 'model-gone');
  assert.match(errorText(new AiError('model-gone')), /Copy prompt/);
});

test('a request the browser refuses to send is reported, not left hanging', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await kindOf(requestScript('p', KEY, { fetchImpl, timeoutMs: 50 })), 'blocked');
  assert.match(errorText(new AiError('blocked')), /Copy prompt/);
});

test('offline is told apart from a blocked request', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  } catch {
    t.skip('navigator cannot be replaced in this runtime');
    return;
  }
  try {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    assert.equal(await kindOf(requestScript('p', KEY, { fetchImpl, timeoutMs: 50 })), 'offline');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});

test('an answer that is not JSON is reported as empty', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('not json');
    },
  });
  assert.equal(await kindOf(requestScript('p', KEY, { fetchImpl, timeoutMs: 50 })), 'empty');
});

test('a request still has a deadline when AbortSignal.timeout is missing', async () => {
  const real = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  delete AbortSignal.timeout;
  try {
    const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    assert.equal(await kindOf(requestScript('p', KEY, { fetchImpl, timeoutMs: 10 })), 'timeout');
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', real);
  }
});

test('a deadline that fires while the answer is read is a timeout, not an empty answer', async () => {
  const fetchImpl = async (url, { signal }) => ({
    ok: true,
    status: 200,
    json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal(await kindOf(requestScript('p', KEY, { fetchImpl, timeoutMs: 10 })), 'timeout');
  assert.match(errorText(new AiError('timeout')), /did not answer in time/);
});

test('every message is one plain sentence with no dashes or curly quotes', () => {
  const kinds = ['no-key', 'invalid-key', 'rate-limit', 'offline', 'blocked', 'server', 'model-gone', 'refused', 'empty', 'unusable', 'timeout'];
  for (const kind of kinds) {
    const text = errorText(new AiError(kind));
    assert.match(text, /^[A-Z].*\.$/, kind);
    assert.equal(/[\u2014\u2013\u2018\u2019\u201c\u201d]/.test(text), false, kind);
  }
});
