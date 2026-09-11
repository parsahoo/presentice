// Script parsing, draft-from-slides and the AI prompt. Pure functions.
import { splitSentences } from './sentences.js';
import { cleanPages, stripPua } from './slide-text.js';

export const DEFAULT_PRESENTER = 'You';

const FENCE = /^\s*(```|~~~)/;
const SEPARATOR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const MARKER = /^[[(]?slide\s+(\d{1,3})[\])]?(?:\s*[:\-\u2013\u2014|)]\s*(.*?)|\s+\((.*)\)|)\s*\.?\s*$/i;
// A name is one or two words that start with a capital, or with a letter from a script
// without capitals (Persian, Arabic, Chinese, Hebrew): "Alex:", "Mary Ann:", "Zoë:", "فاطمة:".
// U+200C and U+200D join the parts of a Persian name.
const SPEAKER = /^([\p{Lu}\p{Lt}\p{Lo}][\p{L}\p{M}\u200C\u200D'.-]*(?: [\p{Lu}\p{Lt}\p{Lo}\p{N}][\p{L}\p{M}\p{N}\u200C\u200D'.-]*)?)\s*:\s*(.*)$/u;
const NOT_SPEAKERS = new Set([
  'note', 'notes', 'tip', 'title', 'subtitle', 'transition', 'visual', 'image',
  'speaker notes', 'duration', 'time', 'timing', 'script', 'slide', 'http', 'https',
]);

function cleanLine(line) {
  let s = line.trim();
  while (/^>\s?/.test(s)) s = s.replace(/^>\s?/, '');
  s = s.replace(/^#{1,6}\s+/, '');
  s = s.replace(/^[-*•]\s+/, '');
  s = s.replace(/\*\*|__/g, '');
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2');
  s = s.replace(/`/g, '');
  return s.trim();
}

/** True for words the script format uses as labels, never as presenter names. */
export function isReservedName(name) {
  return NOT_SPEAKERS.has(String(name).trim().toLowerCase());
}

/** What one raw script line is: 'fence', 'sep', 'blank', 'marker' (Slide N) or 'line'. */
export function classifyLine(raw) {
  if (FENCE.test(raw)) return 'fence';
  if (SEPARATOR.test(raw)) return 'sep';
  const clean = cleanLine(raw);
  if (!clean) return 'blank';
  return matchMarker(clean) ? 'marker' : 'line';
}

function matchMarker(clean) {
  const m = MARKER.exec(clean);
  if (!m) return null;
  return { n: Number(m[1]), rest: (m[2] ?? m[3] ?? '').trim() };
}

/** Pick the lines to parse: the fenced block that holds Slide markers, if any. */
function selectSource(lines) {
  const blocks = [];
  let open = null;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      if (open === null) open = i;
      else {
        blocks.push([open + 1, i]);
        open = null;
      }
    }
  });
  const withMarkers = blocks.filter(([a, b]) => lines.slice(a, b).some((l) => matchMarker(cleanLine(l))));
  if (withMarkers.length) {
    return { lines: withMarkers.flatMap(([a, b]) => lines.slice(a, b)), fromFence: true };
  }
  return { lines, fromFence: false };
}

function tokenize(lines) {
  return lines.map((raw) => {
    if (FENCE.test(raw)) return { type: 'fence' };
    if (SEPARATOR.test(raw)) return { type: 'sep' };
    const clean = cleanLine(raw);
    if (!clean) return { type: 'blank' };
    const marker = matchMarker(clean);
    if (marker) return { type: 'marker', ...marker };
    return { type: 'line', text: clean };
  });
}

function speakerPrefix(text) {
  const m = SPEAKER.exec(text);
  if (!m) return null;
  const name = m[1].replace(/\.$/, '');
  if (NOT_SPEAKERS.has(name.toLowerCase())) return null;
  return { name, rest: m[2].trim() };
}

function countPrefixes(tokens) {
  const counts = new Map();
  for (const t of tokens) {
    const text = t.type === 'line' ? t.text : t.type === 'marker' ? t.rest : '';
    const p = text && speakerPrefix(text);
    if (p) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  }
  return counts;
}

/**
 * The names of a script written as "Name: line" throughout, in the order they first
 * appear, even names used only once. Empty unless at least half of the spoken lines
 * start with a name, so one slide title like "Agenda: Q3 plan" is not a presenter.
 * Lines before the first Slide line are left out.
 */
export function labeledNames(text) {
  const lines = stripPua(String(text ?? '')).replace(/\r\n?/g, '\n').split('\n');
  let tokens = tokenize(selectSource(lines).lines);
  const firstMarker = tokens.findIndex((t) => t.type === 'marker');
  if (firstMarker >= 0) tokens = tokens.slice(firstMarker);
  const spoken = tokens.filter((t) => t.type === 'line');
  const labeled = spoken.filter((t) => speakerPrefix(t.text));
  if (!labeled.length || labeled.length * 2 < spoken.length) return [];
  return [...countPrefixes(tokens).keys()];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Name: rest" for a name the user gave, whatever its case: "alex:" is Alex. */
function knownPrefix(names) {
  const list = names.filter((n) => n && !NOT_SPEAKERS.has(n.toLowerCase())).sort((a, b) => b.length - a.length);
  if (!list.length) return () => null;
  const re = new RegExp(`^(${list.map(escapeRe).join('|')})\\s*:\\s*(.*)$`, 'iu');
  return (text) => {
    const m = re.exec(text);
    return m ? { name: m[1], rest: m[2].trim() } : null;
  };
}

function makeSpeakerResolver(tokens, names) {
  const counts = countPrefixes(tokens);
  const given = names.filter(Boolean).map((n) => n.trim()).filter(Boolean);
  const known = new Map(given.map((n) => [n.toLowerCase(), n]));
  const byName = knownPrefix(given);
  return (text) => {
    const p = byName(text) || speakerPrefix(text);
    if (!p) return null;
    const saved = known.get(p.name.toLowerCase());
    if (saved) return { name: saved, rest: p.rest };
    if ((counts.get(p.name) || 0) >= 2) return { name: p.name, rest: p.rest };
    return null;
  };
}

/** Group tokens into raw chunks: [{ n (slide number or null), paragraphs }]. */
function buildChunks(tokens, resolveSpeaker, useSeparators) {
  const chunks = [];
  let chunk = null;
  let para = null;
  let boundary = 'start';
  const newChunk = (n) => {
    chunk = { n, paragraphs: [] };
    chunks.push(chunk);
    para = null;
    boundary = 'start';
  };
  const addText = (text) => {
    if (!chunk) newChunk(null);
    const sp = resolveSpeaker(text);
    if (sp) {
      para = { speaker: sp.name, explicit: true, text: sp.rest, boundary };
      chunk.paragraphs.push(para);
    } else if (para) {
      para.text = para.text ? `${para.text} ${text}` : text;
    } else {
      para = { speaker: null, explicit: false, text, boundary };
      chunk.paragraphs.push(para);
    }
    boundary = null;
  };
  for (const t of tokens) {
    if (t.type === 'marker') {
      newChunk(t.n);
      if (t.rest && resolveSpeaker(t.rest)) addText(t.rest);
    } else if (t.type === 'sep') {
      if (useSeparators) newChunk(null);
      else {
        para = null;
        boundary = 'hard';
      }
    } else if (t.type === 'fence') {
      para = null;
      boundary = 'hard';
    } else if (t.type === 'blank') {
      para = null;
      if (boundary !== 'hard') boundary = 'blank';
    } else {
      addText(t.text);
    }
  }
  return chunks.map((c) => ({ ...c, paragraphs: c.paragraphs.filter((p) => p.text || p.explicit) }));
}

function dropTrailingChatter(chunks) {
  const all = chunks.flatMap((c) => c.paragraphs);
  if (!all.some((p) => p.explicit)) return chunks;
  const last = chunks[chunks.length - 1];
  const lastExplicit = last.paragraphs.map((p) => p.explicit).lastIndexOf(true);
  if (lastExplicit < 0) return chunks;
  const trailing = last.paragraphs.slice(lastExplicit + 1);
  if (!trailing.length || !trailing[0].boundary) return chunks;
  const trailingSet = new Set(trailing);
  const othersUnprefixed = all.some((p) => !p.explicit && !trailingSet.has(p) && p.boundary !== 'start');
  const hard = trailing[0].boundary === 'hard';
  if (!hard && othersUnprefixed) return chunks;
  const kept = { ...last, paragraphs: last.paragraphs.slice(0, lastExplicit + 1) };
  return [...chunks.slice(0, -1), kept];
}

function spreadEvenly(paragraphs, slideCount) {
  const slides = Array.from({ length: slideCount }, () => []);
  paragraphs.forEach((p, i) => {
    const idx = Math.min(slideCount - 1, Math.floor((i * slideCount) / paragraphs.length));
    slides[idx].push(p);
  });
  return slides;
}

/**
 * Parse a script into slides and speakers.
 * @param {string} text
 * @param {{ slideCount: number, names?: string[] }} options
 */
export function parseScript(text, { slideCount, names = [] } = {}) {
  const count = Math.max(1, slideCount || 1);
  // Private-use glyphs (symbol font bullets pasted from slides) never carry speech.
  const lines = stripPua(String(text ?? '').replace(/^\uFEFF/, '')).replace(/\r\n?/g, '\n').split('\n');
  const source = selectSource(lines);
  let tokens = tokenize(source.lines);
  const firstMarker = tokens.findIndex((t) => t.type === 'marker');
  const hasMarkers = firstMarker >= 0;
  if (hasMarkers) tokens = tokens.slice(firstMarker);
  const hasSeparators = tokens.some((t) => t.type === 'sep');
  const useSeparators = !hasMarkers && hasSeparators;
  const resolveSpeaker = makeSpeakerResolver(tokens, names);
  let chunks = buildChunks(tokens, resolveSpeaker, useSeparators);
  if (hasMarkers) chunks = dropTrailingChatter(chunks);

  const warnings = [];
  let slides = Array.from({ length: count }, () => []);
  if (hasMarkers) {
    let overflow = 0;
    for (const c of chunks) {
      const n = c.n ?? 1;
      if (n > count) overflow = Math.max(overflow, n);
      const idx = Math.min(count, Math.max(1, n)) - 1;
      slides[idx].push(...c.paragraphs);
    }
    if (overflow) {
      warnings.push({ kind: 'overflow', text: `The script goes up to Slide ${overflow}, but the deck has ${count} slides. Extra lines were added to slide ${count}.` });
    }
  } else if (useSeparators) {
    chunks.forEach((c, i) => slides[Math.min(count - 1, i)].push(...c.paragraphs));
    if (chunks.length > count) {
      warnings.push({ kind: 'overflow', text: `The script has ${chunks.length} sections, but the deck has ${count} slides. Extra lines were added to slide ${count}.` });
    }
  } else {
    const paragraphs = chunks.flatMap((c) => c.paragraphs);
    if (paragraphs.length) {
      slides = spreadEvenly(paragraphs, count);
      warnings.push({ kind: 'no-markers', text: 'No slide markers found, paragraphs were spread evenly.' });
    }
  }

  // Resolve speakers: explicit names, then continuation of the previous speaker.
  const order = [];
  for (const p of slides.flat()) if (p.explicit && !order.includes(p.speaker)) order.push(p.speaker);
  const given = names.map((n) => n && n.trim()).filter(Boolean);
  const presenters = [
    ...given.filter((n) => order.includes(n)),
    ...order.filter((n) => !given.includes(n)),
  ];
  if (!presenters.length) presenters.push(given[0] || DEFAULT_PRESENTER);
  let current = presenters[0];
  const outSlides = slides.map((paras) => ({
    paragraphs: paras
      .map((p) => {
        if (p.explicit) current = p.speaker;
        return { speaker: current, text: p.text.trim() };
      })
      .filter((p) => p.text),
  }));

  outSlides.forEach((s, i) => {
    if (!s.paragraphs.length) warnings.push({ kind: 'empty-slide', slide: i, text: `Slide ${i + 1} has no script` });
  });

  // speakers: the presenters named by a "Name:" prefix; empty when the script has none.
  return { slides: outSlides, presenters, speakers: order.length ? presenters : [], warnings, hasMarkers };
}

/** Flatten a parsed script into the sentence list used by the player. */
export function flattenSentences(parsed) {
  const sentences = [];
  parsed.slides.forEach((slide, slideIndex) => {
    slide.paragraphs.forEach((para, paraIndex) => {
      for (const text of splitSentences(para.text)) {
        sentences.push({ index: sentences.length, slide: slideIndex, para: paraIndex, speaker: para.speaker, text });
      }
    });
  });
  return sentences;
}

function asSentence(line) {
  const t = line.replace(/\s+/g, ' ').trim().replace(/[\s:;,-]+$/, '');
  if (!t) return '';
  return /[.!?…]["')\]]?$/.test(t) ? t : `${t}.`;
}

/**
 * Draft a one-presenter script from slide text: every bullet becomes its own
 * sentence, and headers or footers repeated across the deck are left out.
 * @param {{ title: string, lines: string[] }[]} pages
 */
export function draftScript(pages) {
  const clean = cleanPages(pages);
  if (!clean.some((p) => p.title || p.lines.length)) return '';
  return clean
    .map((page, i) => {
      const lines = page.lines.filter((l) => /\p{L}/u.test(l));
      const body = [page.title, ...lines].map(asSentence).filter(Boolean).join(' ');
      return body ? `Slide ${i + 1}\n${body}` : `Slide ${i + 1}`;
    })
    .join('\n\n');
}

/**
 * The prompt a user pastes into an AI chat.
 * @param {{ pages: { title: string, lines: string[] }[], count: number, names: string[] }} input
 */
export function buildPrompt({ pages, count, names }) {
  const n = Math.max(1, Math.min(3, count || 1));
  const labels = Array.from({ length: n }, (_, i) => (names[i] || '').trim() || `Presenter ${i + 1}`);
  const usePrefixes = n > 1 || Boolean((names[0] || '').trim());
  const who = n === 1 ? `one presenter (${labels[0]})` : `${n} presenters: ${labels.join(', ')}`;
  const example = usePrefixes
    ? ['Slide 1', `${labels[0]}: First sentence of the script.`, `${labels[n > 1 ? 1 : 0]}: Next sentence.`, '', 'Slide 2', `${labels[0]}: ...`]
    : ['Slide 1', 'First sentence of the script. Next sentence.', '', 'Slide 2', '...'];
  const slideText = cleanPages(pages)
    .map((p, i) => {
      const text = [p.title, ...p.lines].filter(Boolean).join(' / ');
      return `Slide ${i + 1}: ${text || '(no text on this slide)'}`;
    })
    .join('\n');
  const rules = [
    `Write the spoken script for a ${pages.length}-slide presentation given by ${who}.`,
    'Base it on the slide text below. Keep every fact from the slides and do not invent numbers.',
    '',
    'Rules:',
    '- Put the whole script inside one code block.',
    `- Use one "Slide N" line for each of the ${pages.length} slides, in order, even if a slide is short.`,
    usePrefixes ? `- Start every line with the presenter's name and a colon, exactly as written here: ${labels.map((l) => `${l}:`).join(' ')}` : '- Do not put names or labels in front of the lines.',
    n > 1 ? '- Share the slides fairly between the presenters. Hand over with a short natural line.' : null,
    '- Write plain spoken English in short sentences. About 20 to 60 seconds of speech per slide.',
    '- No markdown, no bullet points, no stage directions, no notes.',
    '',
    'Format:',
    '```',
    ...example,
    '```',
    '',
    'Slide text:',
    slideText,
  ];
  return rules.filter((r) => r !== null).join('\n');
}
