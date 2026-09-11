// Slide text cleanup: line grouping, private-use glyphs, bullets and repeated
// headers or footers. Pure functions, no DOM, runs in Node too.

// Unicode Private Use Areas: the BMP block and the two supplementary planes.
// Symbol fonts (Wingdings and friends) put their bullets and icons here.
const PUA_CLASS = '\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}';
const PUA_ALL = new RegExp(`[${PUA_CLASS}]`, 'gu');
// A run of private-use glyphs at the start of a line or standing alone between spaces.
const PUA_MARKER = new RegExp(`(^|\\s)[${PUA_CLASS}]+(?=\\s|$)`, 'gu');
// Private-use glyphs that start a line, even when the text follows without a space.
const PUA_START = new RegExp(`^\\s*[${PUA_CLASS}]+\\s*`, 'u');
// Common bullet glyphs.
const BULLET_CHARS = '•◦▪▫‣∙●○■□◆◇►▸▹▶▷➢➣➤➔→✓✔✗✘❖⁃·';
// A bullet glyph, or a dash or star followed by a space, at the start of a line.
const BULLET_START = new RegExp(`^\\s*(?:[${BULLET_CHARS}]+|[-*\\u2013\\u2014](?=\\s))\\s*`, 'u');
// Inside a line only real list separators split it ("Fast • Cheap • Local").
// Arrows, triangles and check marks are markers only at the start of a line,
// so "Idea → Prototype" and "Press ▶ to start" stay whole.
const SEPARATOR_CHARS = '•·▪◦●';
const BULLET_INNER = new RegExp(`\\s[${SEPARATOR_CHARS}]+(?=\\s)`, 'gu');
const SPLIT = '\n';
const MARK = '\u0001'; // internal: a bullet marker stood here

// Some fonts put the fi and fl ligatures in the private use area.
const PUA_LIGATURES = [
  [/\uF001/g, 'fi'],
  [/\uF002/g, 'fl'],
];

function fixLigatures(text) {
  return PUA_LIGATURES.reduce((s, [re, to]) => s.replace(re, to), String(text ?? ''));
}

/** Remove private-use characters, which never carry readable text (PUA ligatures become letters). */
export function stripPua(text) {
  return fixLigatures(text).replace(PUA_ALL, '');
}

/**
 * Split slide text into items, one per line or bullet, without bullet markers.
 * Returns [{ text, bullet }], where bullet is true when a marker started the item.
 */
export function splitBullets(text) {
  const out = [];
  for (const line of fixLigatures(text).split(/\r\n?|\n/)) {
    const marked = line
      .replace(PUA_START, MARK)
      .replace(PUA_MARKER, `$1${SPLIT}${MARK}`)
      .replace(BULLET_INNER, `${SPLIT}${MARK}`);
    marked.split(SPLIT).forEach((piece) => {
      let bullet = piece.startsWith(MARK);
      let s = stripPua(bullet ? piece.slice(MARK.length) : piece);
      if (BULLET_START.test(s)) {
        bullet = true;
        s = s.replace(BULLET_START, '');
      }
      s = s.replace(/\s+/g, ' ').trim();
      if (s) out.push({ text: s, bullet });
    });
  }
  return out;
}

/** Slide text as clean items: "Title\n First point" gives ["Title", "First point"]. */
export function bulletItems(text) {
  return splitBullets(text).map((item) => item.text);
}

// A header or footer is short. Longer lines are content even when they repeat.
const MAX_FOOTER_WORDS = 6;
// The fewest pages a line must be on to count as a header or footer.
const MIN_REPEATS = 3;
// Lines whose numbers change from page to page: "Page 3", "Slide 4", "3 of 9", "3 / 9", "Acme | 3".
const NUMBERED_FOOTER = /\b(?:page|slide)\b|\d+\s*(?:of|\/)\s*\d+|\|\s*\d+\s*$|^\s*\d+\s*\|/i;
// A bare page number: only digits and page punctuation ("12", "- 12 -"), never "20%" or "$5".
const BARE_NUMBER = /^[\d\s./|:-]*\d[\d\s./|:-]*$/;

function plain(line) {
  return stripPua(line).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True for a line whose numbers are a page counter, not content. */
function isNumbered(text) {
  return NUMBERED_FOOTER.test(text) || BARE_NUMBER.test(text);
}

/**
 * Key to compare lines across pages. Page counters ("Page 3 of 9", "12") have their
 * digits normalized so they match on every page. Other lines keep their numbers,
 * so "Revenue grew 20%" and "Revenue grew 35%" stay different.
 */
export function lineKey(line) {
  const text = plain(line);
  return isNumbered(text) ? text.replace(/\d+/g, '#') : text;
}

function looksLikeFooter(key) {
  return key.split(' ').length <= MAX_FOOTER_WORDS || isNumbered(key);
}

/**
 * Headers and footers repeat on most pages; they are not worth saying out loud.
 * Returns a test: is this line a short line (or a page counter) on more than half
 * of the pages, and on at least MIN_REPEATS of them?
 */
export function repeatedLines(pages) {
  const counts = new Map();
  for (const page of pages) {
    const keys = new Set(page.lines.flatMap(bulletItems).map(lineKey).filter(Boolean));
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (line) => {
    const key = lineKey(line);
    const count = counts.get(key) || 0;
    return count >= MIN_REPEATS && count > pages.length / 2 && looksLikeFooter(key);
  };
}

/**
 * Pages ready for a draft or a prompt: private-use glyphs gone, every bullet its
 * own line, repeated headers and footers dropped.
 * @param {{ title: string, lines: string[] }[]} pages
 */
export function cleanPages(pages) {
  const repeated = repeatedLines(pages);
  return pages.map((page) => ({
    title: bulletItems(page.title).join(' '),
    lines: page.lines.flatMap(bulletItems).filter((line) => !repeated(line)),
  }));
}

// pdf.js text items to lines -------------------------------------------------

function itemSize(item) {
  const [a, b, c, d] = item.transform;
  return Math.hypot(c, d) || Math.hypot(a, b) || item.height || 0;
}

/** Group pdf.js text items into visual lines: [{ text, size, bullet }]. */
export function groupLines(items) {
  const lines = [];
  let line = null;
  let prev = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const size = itemSize(item);
    const x = item.transform[4];
    const y = item.transform[5];
    if (item.str.trim() === '') {
      if (line && item.str) line.text += ' ';
      if (item.hasEOL) prev = null;
      continue;
    }
    const scale = Math.max(size, prev?.size || 0);
    const breaks =
      !prev ||
      Math.abs(y - prev.y) > scale * 0.5 ||
      x - prev.end > scale * 1.5 ||
      x < prev.x - scale;
    if (breaks) {
      line = { text: item.str, size };
      lines.push(line);
    } else {
      const gap = x - prev.end;
      const needsSpace = gap > scale * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.str);
      line.text += (needsSpace ? ' ' : '') + item.str;
      if (/[\p{L}\p{N}]/u.test(item.str)) line.size = Math.max(line.size, size);
    }
    prev = { x, y, size, end: x + (item.width || 0) };
    if (item.hasEOL) prev = null;
  }
  // A lone glyph run between spaces is a bullet: "A  B" becomes two lines.
  return lines.flatMap((l) => splitBullets(l.text).map((item) => ({ ...item, size: l.size })));
}

/** Pick the title (largest text) and join wrapped lines. Returns { title, lines }. */
export function structure(lines) {
  if (!lines.length) return { title: '', lines: [] };
  const max = Math.max(...lines.map((l) => l.size));
  const titleIndex = lines.findIndex((l) => l.size >= max * 0.92);
  const title = lines[titleIndex].text;
  const rest = [];
  lines.forEach((l, i) => {
    if (i === titleIndex) return;
    const last = rest[rest.length - 1];
    // A new bullet always starts a new line, even when it starts in lowercase.
    const joinable = last && !l.bullet;
    const similar = joinable && l.size / last.size > 0.85 && l.size / last.size < 1.18;
    // A big number over its label ("40" then "bikes") reads as one phrase.
    const numberLabel = joinable && /^[\d.,%$+]+$/.test(last.text) && /^[a-z]/.test(l.text);
    if (numberLabel || (similar && /^[a-z]/.test(l.text))) last.text = `${last.text} ${l.text}`;
    else rest.push({ ...l });
  });
  return { title, lines: rest.map((l) => l.text) };
}

/** { title, lines } for one page of pdf.js text content items. */
export function pageText(items) {
  return structure(groupLines(items));
}
