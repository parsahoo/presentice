// Presenters on the Script step: how many, their names, and the script edits that
// follow from them (slides shared in turn, renames). Pure functions.
import { classifyLine, isReservedName, labeledNames, parseScript } from './script-parser.js';

export const MAX_PRESENTERS = 3;
const SOLO_PLACEHOLDER = 'You';
const MAX_NAME = 30;

// What may sit in front of a name at the start of a line: quotes, a heading, a bullet, bold.
const LEAD = String.raw`\s*(?:>\s?)*(?:#{1,6}\s+)?(?:[-*•]\s+)?`;
const LEAD_RE = new RegExp(`^${LEAD}`, 'u');

/** The name a presenter has while its field is empty. */
export function placeholderName(index, count) {
  return count === 1 ? SOLO_PLACEHOLDER : `Presenter ${index + 1}`;
}

export function isPlaceholder(name) {
  return name === SOLO_PLACEHOLDER || /^Presenter \d$/.test(name || '');
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function upperFirst(word) {
  return word ? word[0].toLocaleUpperCase() + word.slice(1) : '';
}

/**
 * Turn what someone typed into a name the script format reads back as a presenter:
 * one or two words, capitalized, letters first. Empty when nothing usable is left.
 */
export function cleanName(raw) {
  const words = String(raw ?? '')
    .normalize('NFC')
    // U+200C and U+200D join the parts of a Persian name, so they stay.
    .replace(/[^\p{L}\p{M}\p{N}\u200C\u200D'. -]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const first = (words[0] || '').replace(/\p{N}/gu, '').replace(/^[^\p{L}]+/u, '');
  if (!first) return '';
  const second = (words[1] || '').replace(/^[^\p{L}\p{N}]+/u, '');
  const name = [upperFirst(first), upperFirst(second)].filter(Boolean).join(' ').slice(0, MAX_NAME);
  return name.replace(/[.'-]+$/u, '');
}

/**
 * Why a name cannot be used for presenter `index`, or '' when it can.
 * `text`: the script. A name that already starts a line there ("Q: How much?") would
 * take that line over, so it is refused unless it is the row's own name.
 */
export function nameProblem(name, index, rows, text = '') {
  if (isReservedName(name)) return `"${name}" is a word the script format uses. Pick another name.`;
  // "Slide 2: Welcome." at a line start is read as a Slide line, so its text would leave the speech.
  if (classifyLine(`${name}: x`) !== 'line' || /^slide\s+\p{N}/iu.test(name)) {
    return `"${name}" looks like a slide line. Pick another name.`;
  }
  if (isPlaceholder(name)) return `"${name}" is kept for rows without a name. Pick another name.`;
  if (rows.some((other, j) => j !== index && same(other, name))) return 'Two presenters cannot share a name.';
  if (!same(rows[index] || '', name) && usesLabel(text, name)) {
    return `Your script already has lines that start with "${name}:". Pick another name.`;
  }
  return '';
}

/**
 * A project saved before the presenter count existed kept the names typed into the old AI
 * helper even when its answer was never pasted. With no names in the script they are
 * dropped, so the one presenter stays "You" with the voice picked for it.
 * @param {{ count?: number|null, pageCount?: number }} meta
 */
export function migrateNames(meta, script, names) {
  if (meta.count !== undefined || !names.length) return names;
  const { speakers } = parseScript(script, { slideCount: meta.pageCount, names });
  return speakers.length ? names : [];
}

/** The saved rows with the first ones replaced: rows hidden by a smaller count keep their names. */
export function keepHidden(rows, names = []) {
  return [...rows, ...names.slice(rows.length, MAX_PRESENTERS)];
}

/**
 * What picking `count` does to the script and the saved rows.
 * @param {{ text: string, roster: { rows: string[], speakers: string[] }, names: string[], count: number }} input
 *   roster: the rows before the change; names: every saved row, hidden ones too.
 * @returns {{ text: string, names: string[] }}
 */
export function planCount({ text, roster, names = [], count }) {
  const saved = keepHidden(roster.rows, names);
  // Rows for the new count before the text changes: typed names stay, empty ones get placeholders.
  const planned = resolveRoster({ speakers: [], names: saved, count }).rows;
  let next = text;
  if (isAutoAssigned(text, roster.rows)) {
    // Only our own untouched prefixes: share the slides again, or take them back out for 1.
    const base = stripSpeakers(text, roster.rows);
    next = count > 1 ? assignRoundRobin(base, planned) : base;
  } else if (count > 1 && !roster.speakers.length) {
    // Lines that already carry names, each used once: those are the presenters, the text stays.
    const found = labeledNames(text);
    if (found.length) return { text, names: keepHidden(found.slice(0, MAX_PRESENTERS), saved) };
    next = assignRoundRobin(text, planned);
  }
  return { text: next, names: count > 1 && next !== text ? keepHidden(planned, saved) : saved };
}

/**
 * The names a whole new text (a paste, a file, an AI answer) settles on, or null to keep
 * the presenters already picked. The names the text labels win whenever it labels more of
 * them than the parser recognized on its own: with one saved name, an answer written for
 * "Alex:" and "Sam:" would otherwise collapse into Alex alone, with "Sam:" spoken aloud.
 * @param {string[]} found names labeledNames() read out of the text
 * @param {string[]} speakers the presenters parseScript() recognized with the saved names
 */
export function namesForNewText(found = [], speakers = []) {
  return found.length > speakers.length ? found.slice(0, MAX_PRESENTERS) : null;
}

/**
 * Why picking `count` changed nothing: the script itself gives lines to more presenters.
 * @param {{ rows: string[], speakers: string[] }} roster the rows as they would be with that count
 */
export function countBlockedNote(roster, count) {
  const kept = roster.rows.slice(0, count);
  const extra = roster.speakers.filter((s) => !kept.some((k) => same(k, s))).map((s) => `${s}'s`);
  const whose = extra.length > 1 ? `${extra.slice(0, -1).join(', ')} and ${extra[extra.length - 1]}` : extra[0];
  return `Your script gives lines to ${roster.speakers.length} presenters. To have ${count}, give ${whose} lines to someone else, or pick 1 to play every line in one voice.`;
}

/**
 * Settle the presenter rows.
 * @param {{ speakers: string[], names: string[], count?: number|null }} input
 *   speakers: names found as "Name:" prefixes; names: the saved rows; count: the
 *   number the user picked, or null to follow the script.
 * @returns {{ count: number, rows: string[], solo: boolean, speakers: string[] }}
 *   solo: the user picked 1 while the script names several presenters.
 */
export function resolveRoster({ speakers = [], names = [], count = null }) {
  const picked = [1, 2, 3].includes(count) ? count : null;
  const n = picked === 1 ? 1 : Math.max(1, Math.min(MAX_PRESENTERS, Math.max(picked ?? 1, speakers.length)));
  const known = names.slice(0, MAX_PRESENTERS).map((x) => String(x || '').trim());
  const rows = Array(n).fill('');
  const leftovers = [];
  // A speaker keeps the row it was saved in, so voices and colors do not swap.
  for (const sp of speakers) {
    const j = known.findIndex((k) => k && same(k, sp));
    if (j >= 0 && j < n && !rows[j]) rows[j] = sp;
    else leftovers.push(sp);
  }
  for (let i = 0; i < n; i += 1) if (!rows[i] && leftovers.length) rows[i] = leftovers.shift();
  for (let i = 0; i < n; i += 1) {
    if (rows[i]) continue;
    const saved = known[i];
    const free = saved && !isPlaceholder(saved) && !rows.some((r) => r && same(r, saved));
    rows[i] = free ? saved : placeholderName(i, n);
  }
  return { count: n, rows, solo: n === 1 && speakers.length > 1, speakers: [...speakers] };
}

/**
 * Speakers for playback. With no prefixes, or with 1 picked while the script names
 * several presenters, every line belongs to presenter 1. The text is not touched.
 */
export function applyRoster(parsed, roster) {
  if (!roster.solo && roster.speakers.length) return parsed;
  const speaker = roster.rows[0];
  return {
    ...parsed,
    presenters: [speaker],
    slides: parsed.slides.map((s) => ({ ...s, paragraphs: s.paragraphs.map((p) => ({ ...p, speaker })) })),
  };
}

/**
 * Share the slides between presenters in turn: the first line of each slide with
 * text gets the next name (slide 1 to names[0], slide 2 to names[1], and so on).
 * A script without Slide lines is shared by paragraph instead.
 */
export function assignRoundRobin(text, names) {
  const list = names.filter(Boolean);
  if (!list.length) return String(text ?? '');
  const lines = String(text ?? '').split('\n');
  const hasMarkers = lines.some((l) => classifyLine(l) === 'marker');
  // Lines before the first Slide line are never spoken, so they are not given out.
  let waiting = !hasMarkers;
  let turn = 0;
  const out = lines.map((line) => {
    const kind = classifyLine(line);
    if (kind === 'marker') waiting = true;
    else if (kind !== 'line') {
      if (!hasMarkers) waiting = true;
    } else if (waiting) {
      waiting = false;
      const name = list[turn % list.length];
      turn += 1;
      return line.replace(LEAD_RE, (lead) => `${lead}${name}: `);
    }
    return line;
  });
  return out.join('\n');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const labelRe = (name) => new RegExp(`^(${LEAD}(?:\\*\\*|__)?)${escapeRe(name)}(?=(?:\\*\\*|__)?\\s*:)`, 'iu');

/** True when a script line already starts with "name:" (any case, after a bullet or bold). */
export function usesLabel(text, name) {
  if (!name) return false;
  const re = labelRe(name);
  return String(text ?? '')
    .split('\n')
    .some((line) => classifyLine(line) === 'line' && re.test(line));
}

/** Rename a presenter's "Name:" prefixes. Only at line starts; the words inside lines stay. */
export function renameSpeaker(text, from, to) {
  if (!from || !to || from === to) return String(text ?? '');
  const re = labelRe(from);
  return String(text ?? '')
    .split('\n')
    .map((line) => (classifyLine(line) === 'line' ? line.replace(re, (_, lead) => `${lead}${to}`) : line))
    .join('\n');
}

/** Remove "Name: " prefixes written by assignRoundRobin. */
export function stripSpeakers(text, names) {
  const alts = names.filter(Boolean).map(escapeRe).join('|');
  if (!alts) return String(text ?? '');
  const re = new RegExp(`^(${LEAD})(?:${alts}): `, 'u');
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(re, '$1'))
    .join('\n');
}

/**
 * True when the only prefixes in the script are the ones assignRoundRobin gave
 * these names, untouched: changing the count may then share the slides again.
 */
export function isAutoAssigned(text, names) {
  if (names.length < 2) return false;
  const base = stripSpeakers(text, names);
  return base !== text && assignRoundRobin(base, names) === text;
}
