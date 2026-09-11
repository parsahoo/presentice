// Sentence splitting and word timing. Pure functions, no DOM, runs in Node too.

const MAX_SENTENCE = 300;

// Lowercased abbreviations that end with a period but do not end a sentence.
const ABBREVIATIONS = new Set([
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'st.', 'sr.', 'jr.', 'vs.', 'no.',
  'e.g.', 'i.e.', 'u.s.', 'u.k.', 'etc.', 'approx.', 'inc.', 'ltd.', 'co.',
  'fig.', 'p.', 'pp.', 'jan.', 'feb.', 'mar.', 'apr.', 'jun.', 'jul.',
  'aug.', 'sep.', 'sept.', 'oct.', 'nov.', 'dec.', 'mt.', 'ft.', 'min.',
]);

// "etc." is allowed to end a sentence when the next one starts with a capital.
const SOFT_ABBREVIATIONS = new Set(['etc.']);

let sentenceSegmenter = null;
let wordSegmenter = null;

function getSentenceSegmenter() {
  if (!sentenceSegmenter) sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return sentenceSegmenter;
}

function getWordSegmenter() {
  if (!wordSegmenter) wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });
  return wordSegmenter;
}

export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastToken(text) {
  const match = /(\S+)$/.exec(text);
  return match ? match[1].toLowerCase().replace(/^[("'[]+/, '') : '';
}

function startsLowercase(text) {
  return /^[("'[]*[a-z]/.test(text);
}

function shouldMerge(prev, next) {
  const token = lastToken(prev);
  if (ABBREVIATIONS.has(token)) {
    if (SOFT_ABBREVIATIONS.has(token)) return startsLowercase(next);
    return true;
  }
  // Single capital initial such as "J." in "J. Smith".
  if (/^[A-Z]\.$/.test(prev.trim().split(/\s+/).pop() || '')) return true;
  // Decimal numbers split by a sentence boundary: "3." + "5 percent".
  if (/\d\.$/.test(prev) && /^\d/.test(next)) return true;
  // Ellipsis followed by a lowercase continuation.
  if (/(\.\.\.|…)$/.test(prev) && startsLowercase(next)) return true;
  // A sentence that starts lowercase is almost always a continuation.
  if (startsLowercase(next)) return true;
  return false;
}

function hardSplit(sentence) {
  if (sentence.length <= MAX_SENTENCE) return [sentence];
  const window = sentence.slice(0, MAX_SENTENCE);
  const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
  const at = cut > MAX_SENTENCE * 0.3 ? cut + 1 : window.lastIndexOf(' ');
  if (at <= 0) return [sentence.slice(0, MAX_SENTENCE), ...hardSplit(sentence.slice(MAX_SENTENCE).trim())];
  const head = sentence.slice(0, at).trim();
  const tail = sentence.slice(at).trim();
  return [head, ...hardSplit(tail)];
}

/** Split a paragraph into sentences. Returns trimmed, normalized strings. */
export function splitSentences(text) {
  const clean = normalizeText(text);
  if (!clean) return [];
  const raw = [];
  for (const { segment } of getSentenceSegmenter().segment(clean)) {
    const s = segment.trim();
    if (s) raw.push(s);
  }
  const merged = [];
  for (const s of raw) {
    if (merged.length && shouldMerge(merged[merged.length - 1], s)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${s}`;
    } else {
      merged.push(s);
    }
  }
  return merged.flatMap(hardSplit).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const NUMBER_WORD_WEIGHT = 3.2;
const PAUSE_COMMA = 3;
const PAUSE_STOP = 5;

function wordWeight(word) {
  let weight = 1;
  for (const run of word.match(/\d+|[^\d]+/g) || []) {
    if (/^\d+$/.test(run)) weight += run.length * NUMBER_WORD_WEIGHT + 1;
    else weight += run.replace(/[^\p{L}]/gu, '').length;
  }
  return weight;
}

/**
 * Break a sentence into render tokens and estimate when each word is spoken.
 * Returns { tokens: [{ text, isWord }], words: [{ token, start, end }] } with
 * times in seconds spread over `duration`.
 */
export function wordTimings(sentence, duration) {
  const tokens = [];
  for (const { segment, isWordLike } of getWordSegmenter().segment(sentence)) {
    tokens.push({ text: segment, isWord: Boolean(isWordLike) });
  }
  const weights = [];
  tokens.forEach((token, index) => {
    if (!token.isWord) return;
    let weight = wordWeight(token.text);
    const after = tokens[index + 1]?.text || '';
    if (/^[,;:]/.test(after)) weight += PAUSE_COMMA;
    else if (/^[.!?…]/.test(after) && index + 2 < tokens.length) weight += PAUSE_STOP;
    weights.push({ token: index, weight });
  });
  const total = weights.reduce((sum, w) => sum + w.weight, 0) || 1;
  const safeDuration = Math.max(0, Number(duration) || 0);
  let clock = 0;
  const words = weights.map(({ token, weight }) => {
    const start = clock;
    clock += (weight / total) * safeDuration;
    return { token, start, end: clock };
  });
  return { tokens, words };
}

/** Index into `words` of the word being spoken at time t, or -1 before the first. */
export function wordAt(words, t) {
  if (!words.length || t < 0) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
