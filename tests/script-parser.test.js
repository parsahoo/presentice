import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScript, flattenSentences, draftScript, buildPrompt } from '../js/script-parser.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shape = (parsed) => parsed.slides.map((s) => s.paragraphs.map((p) => `${p.speaker}: ${p.text}`));

test('ChatGPT style: uses the fenced block, drops preamble and closing chatter', () => {
  const parsed = parseScript(fixture('chatgpt.md'), { slideCount: 3 });
  assert.deepEqual(parsed.presenters, ['Riley', 'Jordan']);
  assert.deepEqual(shape(parsed), [
    ['Riley: Good morning, everyone. Thanks for joining us.', 'Jordan: Today we will show you how Lumen Garden helps schools grow food.'],
    ['Jordan: Most school yards have unused space.', 'Riley: Teachers want gardens, but they lack time and tools.'],
    ['Riley: Lumen Garden ships a ready-made bed kit.', 'Jordan: Each kit comes with a planting calendar for the whole year.'],
  ]);
  assert.equal(parsed.warnings.length, 0);
});

test('Claude style: headings, bold names, a single Note line, trailing chatter after ---', () => {
  const parsed = parseScript(fixture('claude.md'), { slideCount: 3 });
  assert.deepEqual(parsed.presenters, ['Riley', 'Jordan']);
  assert.deepEqual(shape(parsed), [
    ["Riley: Hello and welcome. I'm Riley.", "Jordan: And I'm Jordan. We run a small repair café."],
    ['Jordan: People bring broken things, and volunteers help fix them. Note: bring your own tools if you can.', 'Riley: Last year we fixed toasters, lamps, and bikes.'],
    ['Riley: We meet on the first Saturday of each month.', 'Jordan: Come by, even if nothing is broken.'],
  ]);
});

test('Gemini style: bold markers, bullets, quotes, Revenue: and Step 1: stay text', () => {
  const parsed = parseScript(fixture('gemini.md'), { slideCount: 3 });
  assert.deepEqual(parsed.presenters, ['Sam', 'Alex']);
  assert.deepEqual(shape(parsed), [
    ['Sam: Welcome to our quarterly update.', 'Alex: We have good news to share.'],
    ['Alex: Revenue: grew faster than we planned this quarter.', 'Sam: Step 1: we simplified the sign-up page.', 'Sam: That change alone doubled our trial starts.'],
    ['Alex: Next, we will focus on retention.', 'Sam: Thank you for listening.'],
  ]);
});

test('No markers: paragraphs spread evenly with a warning, one default presenter', () => {
  const parsed = parseScript(fixture('no-markers.txt'), { slideCount: 3 });
  assert.deepEqual(parsed.presenters, ['You']);
  assert.equal(parsed.hasMarkers, false);
  assert.deepEqual(parsed.slides.map((s) => s.paragraphs.length), [2, 2, 1]);
  assert.ok(parsed.warnings.some((w) => w.kind === 'no-markers'));
});

test('Three presenters with two-word names and continuation paragraphs', () => {
  const parsed = parseScript(fixture('three-presenters.md'), { slideCount: 3 });
  assert.deepEqual(parsed.presenters, ['Mary Ann', 'Dr. Kim', 'Leo']);
  assert.deepEqual(shape(parsed)[1], [
    'Mary Ann: Our first point is safety. It matters more than speed.',
    'Mary Ann: We keep a checklist on every cart.',
    'Dr. Kim: The checklist has five items.',
    'Leo: And it takes under a minute.',
  ]);
  assert.deepEqual(shape(parsed)[2], ['Leo: That is our talk.', 'Mary Ann: Questions are welcome.']);
});

test('Names from the AI panel count as speakers even when used once', () => {
  const text = 'Slide 1\nAlex: Hi there.\nSam: Hello.\nSlide 2\nAlex: Bye.';
  const parsed = parseScript(text, { slideCount: 2, names: ['Alex', 'Sam'] });
  assert.deepEqual(parsed.presenters, ['Alex', 'Sam']);
  assert.equal(parsed.slides[0].paragraphs[1].speaker, 'Sam');
});

test('Empty slides and overflow produce warnings', () => {
  const parsed = parseScript('Slide 1\nHello.\n\nSlide 4\nToo far.', { slideCount: 3 });
  assert.ok(parsed.warnings.some((w) => w.kind === 'empty-slide' && w.slide === 1));
  assert.ok(parsed.warnings.some((w) => w.kind === 'overflow'));
  assert.equal(parsed.slides[2].paragraphs[0].text, 'Too far.');
});

test('HTML in the script stays plain text', () => {
  const parsed = parseScript('Slide 1\n<img src=x onerror=alert(1)> is not a tag here.', { slideCount: 1 });
  assert.equal(parsed.slides[0].paragraphs[0].text, '<img src=x onerror=alert(1)> is not a tag here.');
});

test('A sentence that starts with "Slide 3" is not a marker', () => {
  const parsed = parseScript('Slide 1\nSlide 3 shows the plan.', { slideCount: 3 });
  assert.equal(parsed.slides[0].paragraphs[0].text, 'Slide 3 shows the plan.');
});

test('flattenSentences keeps slide and speaker for each sentence', () => {
  const parsed = parseScript(fixture('chatgpt.md'), { slideCount: 3 });
  const sentences = flattenSentences(parsed);
  assert.equal(sentences.length, 7);
  assert.deepEqual(sentences[1], { index: 1, slide: 0, para: 0, speaker: 'Riley', text: 'Thanks for joining us.' });
});

test('draftScript turns titles and bullets into sentences and skips footers', () => {
  const pages = [
    { title: 'Brightside', lines: ['Shared bikes for small towns', 'Fictional sample'] },
    { title: 'The problem', lines: ['Buses run once an hour', 'Fictional sample', '2 / 3'] },
    { title: '', lines: ['Fictional sample'] },
  ];
  assert.equal(draftScript(pages), 'Slide 1\nBrightside. Shared bikes for small towns.\n\nSlide 2\nThe problem. Buses run once an hour.\n\nSlide 3');
  const parsed = parseScript(draftScript(pages), { slideCount: 3 });
  assert.ok(parsed.slides[0].paragraphs.length > 0 && parsed.slides[1].paragraphs.length > 0);
  assert.equal(draftScript([{ title: '', lines: [] }]), '');
});

test('buildPrompt includes slide text, names and the format', () => {
  const prompt = buildPrompt({ pages: [{ title: 'Hello', lines: ['World'] }], count: 2, names: ['Alex', ''] });
  assert.match(prompt, /2 presenters: Alex, Presenter B/);
  assert.match(prompt, /Slide 1: Hello \/ World/);
  assert.match(prompt, /one code block/);
  assert.doesNotMatch(prompt, /[\u2014\u2013\u201c\u201d\u2018\u2019]/);
});

test('buildPrompt leaves out footers repeated on most slides', () => {
  const pages = [
    { title: 'Brightside', lines: ['Shared bikes', 'Fictional sample deck'] },
    { title: 'The problem', lines: ['Buses run once an hour', 'Fictional sample deck'] },
    { title: 'The plan', lines: ['Forty bikes', 'Fictional sample deck'] },
  ];
  const prompt = buildPrompt({ pages, count: 1, names: [] });
  assert.match(prompt, /Slide 2: The problem \/ Buses run once an hour\n/);
  assert.doesNotMatch(prompt, /Fictional sample deck/);
});
