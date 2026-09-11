import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPua, splitBullets, bulletItems, lineKey, repeatedLines, cleanPages, pageText } from '../js/slide-text.js';
import { draftScript, buildPrompt, parseScript, flattenSentences } from '../js/script-parser.js';

// Private-use bullets as symbol fonts (Wingdings, Symbol) put them in PDFs.
const PUA_BULLET = '\uF097';
const PUA_ARROW = '\uF0D8';

test('the test strings really contain private-use characters', () => {
  assert.equal(PUA_BULLET.codePointAt(0), 0xf097);
  assert.equal(stripPua(PUA_BULLET + PUA_ARROW), '');
});

test('stripPua removes the BMP and supplementary private use areas only', () => {
  assert.equal(stripPua('A\uE000B\uF8FFC'), 'ABC');
  assert.equal(stripPua('x\u{F0000}y\u{FFFFD}z\u{100000}w\u{10FFFD}'), 'xyzw');
  assert.equal(stripPua('Café • \u{1F600} ﬁ'), 'Café • \u{1F600} ﬁ');
});

test('PUA bullets become separate items without the glyph', () => {
  assert.deepEqual(bulletItems('Title\n\uF097 First point\n\uF097 Second point'), ['Title', 'First point', 'Second point']);
  assert.deepEqual(splitBullets('\uF097Glued to the text'), [{ text: 'Glued to the text', bullet: true }]);
});

test('PUA bullets inside one line split it into items', () => {
  assert.deepEqual(bulletItems('\uF097 First point \uF097 Second point'), ['First point', 'Second point']);
  assert.deepEqual(bulletItems('Supplementary \u{F0001} bullet'), ['Supplementary', 'bullet']);
});

test('a PUA glyph inside a word is removed without splitting the word', () => {
  assert.deepEqual(bulletItems('e\uE123x'), ['ex']);
});

test('fi and fl ligatures in the private use area become their letters', () => {
  assert.deepEqual(bulletItems('ef\uF001cient \uF002ow'), ['efficient flow']);
  assert.equal(stripPua('\uF001nal'), 'final');
  assert.deepEqual(bulletItems('\uF001rst point'), ['first point']);
});

test('common bullet glyphs at line start are markers', () => {
  const glyphs = ['•', '◦', '▪', '‣', '∙', '●', '○', '■', '□', '➢', '➤', '✓'];
  for (const g of glyphs) {
    assert.deepEqual(splitBullets(`${g} Point`), [{ text: 'Point', bullet: true }], `glyph U+${g.codePointAt(0).toString(16)}`);
  }
  assert.deepEqual(splitBullets('- Dash item'), [{ text: 'Dash item', bullet: true }]);
  assert.deepEqual(splitBullets('-5% churn'), [{ text: '-5% churn', bullet: false }]);
});

test('list separators between spaces split a line', () => {
  assert.deepEqual(bulletItems('Fast • Cheap • Local'), ['Fast', 'Cheap', 'Local']);
  assert.deepEqual(bulletItems('One · Two ▪ Three ◦ Four ● Five'), ['One', 'Two', 'Three', 'Four', 'Five']);
});

test('arrows, triangles and check marks inside a line do not split it', () => {
  assert.deepEqual(bulletItems('Idea → Prototype → Launch'), ['Idea → Prototype → Launch']);
  assert.deepEqual(bulletItems('Press ▶ to start'), ['Press ▶ to start']);
  assert.deepEqual(bulletItems('Tests ✓ passing'), ['Tests ✓ passing']);
  assert.deepEqual(splitBullets('→ Next step'), [{ text: 'Next step', bullet: true }]);
});

test('lineKey normalizes digits only in page counters', () => {
  assert.equal(lineKey('Page 3 of 9'), lineKey('page  12 of 9'));
  assert.equal(lineKey('Slide 4'), lineKey('Slide 5'));
  assert.equal(lineKey('3 / 9'), lineKey('4 / 9'));
  assert.equal(lineKey('12'), lineKey('13'));
  assert.equal(lineKey('Acme | 3'), lineKey('Acme | 4'));
  assert.equal(lineKey('\uF0D8 Acme 2026'), 'acme 2026');
  assert.notEqual(lineKey('Revenue grew 20%'), lineKey('Revenue grew 35%'));
});

test('repeatedLines: a short line on more than half of the pages, and on 3 or more', () => {
  const pages = [
    { title: 'A', lines: ['Page 1 of 4', 'Alpha'] },
    { title: 'B', lines: ['Page 2 of 4', 'Beta'] },
    { title: 'C', lines: ['Page 3 of 4', 'Gamma'] },
    { title: 'D', lines: ['Delta'] },
  ];
  const repeated = repeatedLines(pages);
  assert.equal(repeated('Page 9 of 4'), true);
  assert.equal(repeated('Alpha'), false);
  assert.equal(repeatedLines(pages.slice(0, 2))('Page 1 of 4'), false);
});

test('repeatedLines keeps a line on only half of the pages', () => {
  const pages = [
    { title: 'A', lines: ['Why now?'] },
    { title: 'B', lines: ['Why now?'] },
    { title: 'C', lines: ['Gamma'] },
    { title: 'D', lines: ['Delta'] },
  ];
  assert.equal(repeatedLines(pages)('Why now?'), false);
  assert.deepEqual(cleanPages(pages).map((p) => p.lines), [['Why now?'], ['Why now?'], ['Gamma'], ['Delta']]);
  assert.match(buildPrompt({ pages, count: 1, names: [] }), /Slide 2: B \/ Why now\?/);
});

test('repeatedLines keeps a line on 2 of 3 pages', () => {
  const pages = [
    { title: 'A', lines: ['Why now?'] },
    { title: 'B', lines: ['Why now?'] },
    { title: 'C', lines: ['Gamma'] },
  ];
  assert.equal(repeatedLines(pages)('Why now?'), false);
});

test('stat lines that differ only in their numbers are kept', () => {
  const pages = [
    { title: 'A', lines: ['Revenue grew 20%'] },
    { title: 'B', lines: ['Revenue grew 35%'] },
    { title: 'C', lines: ['Revenue grew 50%'] },
    { title: 'D', lines: ['Delta'] },
  ];
  const prompt = buildPrompt({ pages, count: 1, names: [] });
  for (const n of ['20%', '35%', '50%']) assert.match(prompt, new RegExp(`Revenue grew ${n}`));
  assert.match(draftScript(pages), /Revenue grew 20%\./);
});

test('a long line repeated on every page is content, not a footer', () => {
  const long = 'We help small teams ship reliable software every single week';
  const pages = ['A', 'B', 'C'].map((title) => ({ title, lines: [long] }));
  assert.equal(repeatedLines(pages)(long), false);
});

test('cleanPages strips glyphs, splits bullets and drops footers', () => {
  const pages = [
    { title: '\uF0D8 Intro', lines: ['\uF097 First point \uF097 Second point', 'Confidential 2026'] },
    { title: 'Plan', lines: ['Step one', 'Confidential 2026'] },
    { title: 'End', lines: ['Thanks', 'Confidential 2026'] },
  ];
  assert.deepEqual(cleanPages(pages), [
    { title: 'Intro', lines: ['First point', 'Second point'] },
    { title: 'Plan', lines: ['Step one'] },
    { title: 'End', lines: ['Thanks'] },
  ]);
});

test('draftScript: each bullet is its own sentence ending in a period', () => {
  const pages = [{ title: 'Title', lines: ['\uF097 First point', '\uF097 Second point'] }];
  assert.equal(draftScript(pages), 'Slide 1\nTitle. First point. Second point.');
  const sentences = flattenSentences(parseScript(draftScript(pages), { slideCount: 1 }));
  assert.deepEqual(sentences.map((s) => s.text), ['Title.', 'First point.', 'Second point.']);
});

test('draftScript drops "Page N of M" footers repeated on most of the pages', () => {
  const pages = [
    { title: 'One', lines: ['Alpha', 'Page 1 of 4'] },
    { title: 'Two', lines: ['Beta', 'Page 2 of 4'] },
    { title: 'Three', lines: ['Gamma', 'Page 3 of 4'] },
    { title: 'Four', lines: ['Delta'] },
  ];
  assert.doesNotMatch(draftScript(pages), /Page/);
});

test('buildPrompt gets the same cleanup', () => {
  const pages = [
    { title: 'Title', lines: ['\uF097 First point \uF097 Second point', 'Footer'] },
    { title: 'Next', lines: ['Footer'] },
    { title: 'Last', lines: ['Footer'] },
  ];
  const prompt = buildPrompt({ pages, count: 1, names: [] });
  assert.match(prompt, /Slide 1: Title \/ First point \/ Second point\n/);
  assert.doesNotMatch(prompt, /Footer|[\uE000-\uF8FF]/);
});

test('parseScript strips PUA characters from saved scripts', () => {
  const parsed = parseScript('Slide 1\n\uF097 Hello there. Next one.', { slideCount: 1 });
  assert.equal(parsed.slides[0].paragraphs[0].text, 'Hello there. Next one.');
});

// Synthetic pdf.js text items: one per string, laid out top to bottom.
const item = (str, y, { x = 50, size = 18, width = str.length * size * 0.5 } = {}) => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
  height: size,
  hasEOL: false,
});

test('pageText: a PUA bullet glyph item starts a new line, even in lowercase', () => {
  const items = [
    item('Title', 700, { size: 36 }),
    item('\uF097', 600, { x: 50, width: 10 }),
    item('first point', 600, { x: 70 }),
    item('\uF097', 560, { x: 50, width: 10 }),
    item('second point', 560, { x: 70 }),
  ];
  assert.deepEqual(pageText(items), { title: 'Title', lines: ['first point', 'second point'] });
});

test('pageText still joins a wrapped line that starts in lowercase', () => {
  const items = [item('Title', 700, { size: 36 }), item('A long sentence that', 600), item('wraps here', 575)];
  assert.deepEqual(pageText(items), { title: 'Title', lines: ['A long sentence that wraps here'] });
});
