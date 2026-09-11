// Script parsing, draft-from-slides and the AI prompt. Pure functions.
import { splitSentences } from './sentences.js';

export const DEFAULT_PRESENTER = 'You';

const FENCE = /^\s*(```|~~~)/;
const SEPARATOR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const MARKER = /^[[(]?slide\s+(\d{1,3})[\])]?(?:\s*[:\-\u2013\u2014|)]\s*(.*?)|\s+\((.*)\)|)\s*\.?\s*$/i;
const SPEAKER = /^([A-Z][A-Za-z'.-]*(?: [A-Z0-9][A-Za-z0-9'.-]*)?)\s*:\s*(.*)$/;
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

function makeSpeakerResolver(tokens, names) {
  const counts = countPrefixes(tokens);
  const known = new Map(names.filter(Boolean).map((n) => [n.trim().toLowerCase(), n.trim()]));
  return (text) => {
    const p = speakerPrefix(text);
    if (!p) return null;
    const given = known.get(p.name.toLowerCase());
    if (given) return { name: given, rest: p.rest };
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
  const lines = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
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

  return { slides: outSlides, presenters, warnings, hasMarkers };
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
 * Footers and headers repeat on most pages; they are not worth saying out loud.
 * Returns a test: is this line on more than half of the pages?
 */
function repeatedLines(pages) {
  const seen = new Map();
  for (const p of pages) for (const l of new Set(p.lines)) seen.set(l, (seen.get(l) || 0) + 1);
  return (l) => pages.length >= 3 && seen.get(l) > pages.length / 2;
}

/**
 * Draft a one-presenter script from slide text.
 * @param {{ title: string, lines: string[] }[]} pages
 */
export function draftScript(pages) {
  if (!pages.some((p) => p.title || p.lines.length)) return '';
  const repeated = repeatedLines(pages);
  return pages
    .map((page, i) => {
      const lines = page.lines.filter((l) => !repeated(l) && /\p{L}/u.test(l));
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
  const labels = Array.from({ length: n }, (_, i) => (names[i] || '').trim() || `Presenter ${String.fromCharCode(65 + i)}`);
  const usePrefixes = n > 1 || Boolean((names[0] || '').trim());
  const who = n === 1 ? `one presenter (${labels[0]})` : `${n} presenters: ${labels.join(', ')}`;
  const example = usePrefixes
    ? ['Slide 1', `${labels[0]}: First sentence of the script.`, `${labels[n > 1 ? 1 : 0]}: Next sentence.`, '', 'Slide 2', `${labels[0]}: ...`]
    : ['Slide 1', 'First sentence of the script. Next sentence.', '', 'Slide 2', '...'];
  const repeated = repeatedLines(pages);
  const slideText = pages
    .map((p, i) => {
      const text = [p.title, ...p.lines.filter((l) => !repeated(l))].filter(Boolean).join(' / ');
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
