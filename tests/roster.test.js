import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, flattenSentences, draftScript, labeledNames } from '../js/script-parser.js';
import {
  countBlockedNote,
  migrateNames,
  resolveRoster,
  applyRoster,
  assignRoundRobin,
  renameSpeaker,
  stripSpeakers,
  isAutoAssigned,
  cleanName,
  nameProblem,
  placeholderName,
  keepHidden,
  namesForNewText,
  planCount,
} from '../js/roster.js';
import { defaultVoices } from '../js/voices.js';

const DRAFT = 'Slide 1\nWelcome. Our plan.\n\nSlide 2\nThe problem.\n\nSlide 3\nThe fix.\n\nSlide 4\nThe ask.\n\nSlide 5\nThanks.';
const speakersOf = (text, names = [], slideCount = 5) => parseScript(text, { slideCount, names }).speakers;
const firstSpeakers = (text, names, slideCount = 5) =>
  parseScript(text, { slideCount, names }).slides.map((s) => s.paragraphs[0]?.speaker ?? null);

test('Count detection: 1 by default, the number of named presenters otherwise, at most 3', () => {
  assert.equal(resolveRoster({ speakers: [], names: [] }).count, 1);
  assert.equal(resolveRoster({ speakers: ['Alex'], names: [] }).count, 1);
  assert.equal(resolveRoster({ speakers: ['Alex', 'Sam'], names: [] }).count, 2);
  assert.equal(resolveRoster({ speakers: ['A', 'B', 'C', 'D'], names: [] }).count, 3);
  assert.deepEqual(speakersOf(DRAFT), []);
  const sample = 'Slide 1\nAlex: Hi.\nSam: Hello.\n\nSlide 2\nAlex: Bye.\nSam: Bye.';
  assert.deepEqual(speakersOf(sample, [], 2), ['Alex', 'Sam']);
});

test('Rows: names from the script fill the rows, placeholders fill the rest', () => {
  assert.deepEqual(resolveRoster({ speakers: [], names: [] }).rows, ['You']);
  assert.deepEqual(resolveRoster({ speakers: [], names: [], count: 2 }).rows, ['Presenter 1', 'Presenter 2']);
  assert.deepEqual(resolveRoster({ speakers: ['Alex', 'Sam'], names: [], count: 3 }).rows, ['Alex', 'Sam', 'Presenter 3']);
  // A placeholder saved for another count is not a name.
  assert.deepEqual(resolveRoster({ speakers: [], names: ['Presenter 1', 'Presenter 2'], count: 1 }).rows, ['You']);
  assert.deepEqual(resolveRoster({ speakers: [], names: ['You'], count: 2 }).rows, ['Presenter 1', 'Presenter 2']);
  // A typed name with no lines yet stays in its row.
  assert.deepEqual(resolveRoster({ speakers: ['Alex', 'Sam'], names: ['Alex', 'Sam', 'Kim'], count: 3 }).rows, ['Alex', 'Sam', 'Kim']);
  // A speaker keeps its saved row even when another speaks first.
  assert.deepEqual(resolveRoster({ speakers: ['Sam', 'Alex'], names: ['Alex', 'Sam'] }).rows, ['Alex', 'Sam']);
  // A pasted answer with new names replaces the old ones.
  assert.deepEqual(resolveRoster({ speakers: ['Riley', 'Jordan'], names: ['Alex', 'Sam'] }).rows, ['Riley', 'Jordan']);
  assert.equal(placeholderName(0, 1), 'You');
  assert.equal(placeholderName(2, 3), 'Presenter 3');
});

test('Round robin: slide 1 to presenter 1, slide 2 to presenter 2, repeating', () => {
  const two = assignRoundRobin(DRAFT, ['Presenter 1', 'Presenter 2']);
  assert.match(two, /^Slide 1\nPresenter 1: Welcome\. Our plan\.\n\nSlide 2\nPresenter 2: The problem\./);
  const names = ['Presenter 1', 'Presenter 2'];
  assert.deepEqual(firstSpeakers(two, names), ['Presenter 1', 'Presenter 2', 'Presenter 1', 'Presenter 2', 'Presenter 1']);
  const three = assignRoundRobin(DRAFT, ['Alex', 'Sam', 'Kim']);
  assert.deepEqual(firstSpeakers(three, ['Alex', 'Sam', 'Kim']), ['Alex', 'Sam', 'Kim', 'Alex', 'Sam']);
  // Every name used once is still read as a presenter because it is a known name.
  assert.deepEqual(speakersOf(assignRoundRobin('Slide 1\nA.\n\nSlide 2\nB.\n\nSlide 3\nC.', ['Alex', 'Sam', 'Kim']), ['Alex', 'Sam', 'Kim'], 3), ['Alex', 'Sam', 'Kim']);
});

test('Round robin: only the first line of a slide, empty slides skipped, bullets kept', () => {
  const text = 'Intro chatter\nSlide 1\n- First point.\nSecond line.\n\nSlide 2\n\nSlide 3\n## Heading line';
  const out = assignRoundRobin(text, ['Alex', 'Sam']);
  assert.equal(out, 'Intro chatter\nSlide 1\n- Alex: First point.\nSecond line.\n\nSlide 2\n\nSlide 3\n## Sam: Heading line');
  const parsed = parseScript(out, { slideCount: 3, names: ['Alex', 'Sam'] });
  assert.equal(parsed.slides[0].paragraphs[0].text, 'First point. Second line.');
  assert.equal(parsed.slides[2].paragraphs[0].speaker, 'Sam');
});

test('Round robin without Slide lines shares paragraphs in turn', () => {
  const out = assignRoundRobin('One.\nStill one.\n\nTwo.\n\nThree.', ['Alex', 'Sam']);
  assert.equal(out, 'Alex: One.\nStill one.\n\nSam: Two.\n\nAlex: Three.');
});

test('Rename changes "Name:" at line starts only', () => {
  const text = 'Slide 1\nAlex: Hi, I am Alex: the host.\nSam: Alex: said hi.\n**Alex:** Bold line.\n- Alex: Bullet.\nSlide 2\nAlexandra: Not the same.';
  const out = renameSpeaker(text, 'Alex', 'Robin');
  assert.equal(
    out,
    'Slide 1\nRobin: Hi, I am Alex: the host.\nSam: Alex: said hi.\n**Robin:** Bold line.\n- Robin: Bullet.\nSlide 2\nAlexandra: Not the same.',
  );
  assert.equal(renameSpeaker(text, 'Alex', 'Alex'), text);
});

test('Rename keeps the lines with the renamed presenter', () => {
  const text = 'Slide 1\nAlex: Hi.\nSam: Hello.\n\nSlide 2\nAlex: Bye.';
  const renamed = renameSpeaker(text, 'Alex', 'Robin');
  const parsed = parseScript(renamed, { slideCount: 2, names: ['Robin', 'Sam'] });
  assert.deepEqual(parsed.speakers, ['Robin', 'Sam']);
  assert.deepEqual(flattenSentences(parsed).map((s) => s.speaker), ['Robin', 'Sam', 'Robin']);
});

test('Our own prefixes are recognized, and taking them out restores the text', () => {
  const names = ['Presenter 1', 'Presenter 2'];
  const two = assignRoundRobin(DRAFT, names);
  assert.equal(isAutoAssigned(two, names), true);
  assert.equal(stripSpeakers(two, names), DRAFT);
  assert.equal(isAutoAssigned(two.replace('Presenter 1: The fix.', 'Presenter 2: The fix.'), names), false);
  assert.equal(isAutoAssigned(DRAFT, names), false);
  const renamed = renameSpeaker(two, 'Presenter 1', 'Alex');
  assert.equal(isAutoAssigned(renamed, ['Alex', 'Presenter 2']), true);
});

test('Count 1 override: every line plays as presenter 1, the text is untouched', () => {
  const text = 'Slide 1\nAlex: Hi.\nSam: Hello.\n\nSlide 2\nSam: Bye.';
  const raw = parseScript(text, { slideCount: 2, names: ['Alex', 'Sam'] });
  const roster = resolveRoster({ speakers: raw.speakers, names: ['Alex', 'Sam'], count: 1 });
  assert.equal(roster.count, 1);
  assert.equal(roster.solo, true);
  assert.deepEqual(roster.rows, ['Alex']);
  const played = flattenSentences(applyRoster(raw, roster));
  assert.deepEqual(played.map((s) => s.speaker), ['Alex', 'Alex', 'Alex']);
  assert.deepEqual(played.map((s) => s.text), ['Hi.', 'Hello.', 'Bye.']);
  // Without the override the script keeps its two presenters.
  const auto = resolveRoster({ speakers: raw.speakers, names: ['Alex', 'Sam'] });
  assert.equal(auto.solo, false);
  assert.equal(applyRoster(raw, auto), raw);
});

test('A script without names plays as the first row name', () => {
  const raw = parseScript(draftScript([{ title: 'Hello', lines: ['World'] }]), { slideCount: 1, names: ['Maya'] });
  const roster = resolveRoster({ speakers: raw.speakers, names: ['Maya'] });
  assert.deepEqual(flattenSentences(applyRoster(raw, roster)).map((s) => s.speaker), ['Maya', 'Maya']);
});

test('Typed names become names the script reads back', () => {
  assert.equal(cleanName('  alex '), 'Alex');
  assert.equal(cleanName('mary ann smith'), 'Mary Ann');
  assert.equal(cleanName('zoë'), 'Zoë');
  assert.equal(cleanName('Dr.'), 'Dr');
  assert.equal(cleanName('42'), '');
  assert.equal(cleanName('<b>Sam</b>'), 'B Sam');
  assert.equal(cleanName(''), '');
  for (const name of ['Alex', 'Mary Ann', 'Zoë', 'Presenter 2']) {
    const parsed = parseScript(`Slide 1\n${name}: Hi.\nOther: Yes.\n${name}: Bye.\nOther: Ok.`, { slideCount: 1 });
    assert.ok(parsed.speakers.includes(name), name);
  }
});

test('Name problems: reserved words and duplicates', () => {
  assert.match(nameProblem('Note', 0, ['You']), /script format/);
  assert.match(nameProblem('sam', 0, ['Alex', 'Sam']), /share a name/);
  assert.equal(nameProblem('Robin', 0, ['Alex', 'Sam']), '');
});

test('Name problems: a name that already starts a line in the script, and placeholders', () => {
  const text = 'Slide 1\nPresenter 1: Welcome.\nQ: How much does it cost?\n- **Kim:** Bold.';
  assert.match(nameProblem('Q', 0, ['Presenter 1', 'Presenter 2'], text), /already has lines that start with "Q:"/);
  assert.match(nameProblem('kim', 1, ['Presenter 1', 'Presenter 2'], text), /already has lines/);
  // Words inside a line do not count, and the row's own name is fine.
  assert.equal(nameProblem('Welcome', 0, ['Presenter 1', 'Presenter 2'], text), '');
  assert.equal(nameProblem('alex', 0, ['Alex', 'Sam'], 'Slide 1\nAlex: Hi.'), '');
  assert.match(nameProblem('Presenter 3', 0, ['Alex', 'Sam']), /rows without a name/);
  assert.match(nameProblem('You', 1, ['Alex', 'Sam']), /rows without a name/);
});

// The Script step in miniature: derive the rows, keep them saved, pick a count, rename.
const derive = (s) => {
  const raw = parseScript(s.text, { slideCount: 5, names: s.names });
  return resolveRoster({ speakers: raw.speakers, names: s.names, count: s.count });
};
const sync = (s) => ({ ...s, names: keepHidden(derive(s).rows, s.names) });
const pick = (s, count) => {
  const plan = planCount({ text: s.text, roster: derive(s), names: s.names, count });
  return sync({ ...s, count, text: plan.text, names: plan.names });
};
const rename = (s, i, to) => {
  const { rows } = derive(s);
  const next = { ...s, text: renameSpeaker(s.text, rows[i], to), names: keepHidden(rows.map((r, j) => (j === i ? to : r)), s.names) };
  return sync(next);
};

test('2 then 1 then 2 brings back the hidden presenter: name, voice and prefixes', () => {
  let s = sync({ text: DRAFT, names: [], count: null });
  s = pick(s, 2);
  s = rename(s, 0, 'Alex');
  s = rename(s, 1, 'Sam');
  const voices = { Sam: 'af_bella' };
  const two = s.text;
  s = pick(s, 1);
  assert.equal(s.text, DRAFT);
  assert.deepEqual(derive(s).rows, ['Alex']);
  assert.deepEqual(s.names, ['Alex', 'Sam']);
  s = pick(s, 2);
  const { rows } = derive(s);
  assert.deepEqual(rows, ['Alex', 'Sam']);
  assert.equal(s.text, two);
  assert.deepEqual(firstSpeakers(s.text, s.names), ['Alex', 'Sam', 'Alex', 'Sam', 'Alex']);
  assert.doesNotMatch(s.text, /Presenter 2/);
  assert.equal(defaultVoices(rows, voices).Sam, 'af_bella');
});

test('3 then 1 then 3 keeps every typed name', () => {
  let s = pick(sync({ text: DRAFT, names: [], count: null }), 3);
  s = rename(rename(rename(s, 0, 'Alex'), 1, 'Sam'), 2, 'Kim');
  s = pick(pick(s, 1), 3);
  assert.deepEqual(derive(s).rows, ['Alex', 'Sam', 'Kim']);
  assert.deepEqual(firstSpeakers(s.text, s.names), ['Alex', 'Sam', 'Kim', 'Alex', 'Sam']);
});

test('Names without capital letters are presenters: Persian and Chinese', () => {
  for (const name of ['فاطمة', '李明', 'محمد\u200Cرضا', 'فاطمة الزهراء']) {
    assert.equal(cleanName(name), name, name);
    const text = assignRoundRobin(DRAFT, [name, 'Sam']);
    const parsed = parseScript(text, { slideCount: 5, names: [name, 'Sam'] });
    assert.deepEqual(parsed.speakers, [name, 'Sam'], name);
    assert.deepEqual(firstSpeakers(text, [name, 'Sam']), [name, 'Sam', name, 'Sam', name]);
    const played = flattenSentences(parsed);
    assert.ok(played.every((x) => !x.text.includes(`${name}:`)), `${name} is not read aloud`);
    // Without saved names too, once a name is used twice.
    assert.deepEqual(speakersOf(text), [name, 'Sam'], name);
  }
});

test('A saved name is a presenter whatever its case', () => {
  const parsed = parseScript('Slide 1\nalex: Hi.\nSAM: Hello.', { slideCount: 1, names: ['Alex', 'Sam'] });
  assert.deepEqual(parsed.speakers, ['Alex', 'Sam']);
  assert.deepEqual(flattenSentences(parsed).map((x) => x.text), ['Hi.', 'Hello.']);
});

test('Name problems: a name that reads as a Slide line is refused', () => {
  for (const typed of ['Slide 2', 'slide 12', 'SLIDE 3']) {
    const name = cleanName(typed);
    assert.match(nameProblem(name, 1, ['Presenter 1', 'Presenter 2']), /looks like a slide line/, typed);
  }
  assert.equal(nameProblem('Slider', 0, ['Presenter 1', 'Presenter 2']), '');
  assert.equal(nameProblem('Slide Deck', 0, ['Presenter 1', 'Presenter 2']), '');
  // Why: round robin with that name would turn the first line of each slide into a Slide line.
  const text = assignRoundRobin('Slide 1\nWelcome.\n\nSlide 2\nNext.\n\nSlide 3\nBye.', ['Alex', 'Slide 2']);
  assert.ok(parseScript(text, { slideCount: 3, names: ['Alex', 'Slide 2'] }).warnings.some((w) => w.kind === 'empty-slide'));
});

test('A count lower than the presenters the script names says why and names who to move', () => {
  const text = 'Slide 1\nAlex: Hi.\nSam: Yes.\nKim: Ok.\n\nSlide 2\nAlex: Bye.\nSam: Bye.\nKim: Bye.';
  const names = ['Alex', 'Sam', 'Kim'];
  const raw = parseScript(text, { slideCount: 2, names });
  const roster = resolveRoster({ speakers: raw.speakers, names, count: 3 });
  const plan = planCount({ text, roster, names, count: 2 });
  assert.equal(plan.text, text);
  const tried = resolveRoster({ speakers: parseScript(plan.text, { slideCount: 2, names: plan.names }).speakers, names: plan.names, count: 2 });
  assert.equal(tried.count, 3);
  assert.equal(
    countBlockedNote(tried, 2),
    "Your script gives lines to 3 presenters. To have 2, give Kim's lines to someone else, or pick 1 to play every line in one voice.",
  );
  assert.match(countBlockedNote({ rows: ['A', 'B', 'C'], speakers: ['A', 'B', 'C', 'D'] }, 2), /give C's and D's lines/);
});

test('A new text whose names are each used once keeps its names, with nothing added', () => {
  const text = 'Slide 1\nAna: Hello there.\n\nSlide 2\nBen: Next part.\n';
  assert.deepEqual(labeledNames(text), ['Ana', 'Ben']);
  // Picking 3 adopts those names and leaves the text alone.
  const roster = resolveRoster({ speakers: [], names: ['Mary Anne', 'Presenter 2', 'Kai'], count: 1 });
  const plan = planCount({ text, roster, names: ['Mary Anne', 'Presenter 2', 'Kai'], count: 3 });
  assert.equal(plan.text, text);
  const parsed = parseScript(plan.text, { slideCount: 2, names: plan.names });
  assert.deepEqual(parsed.speakers, ['Ana', 'Ben']);
  assert.deepEqual(flattenSentences(parsed).map((s) => s.text), ['Hello there.', 'Next part.']);
  assert.deepEqual(resolveRoster({ speakers: parsed.speakers, names: plan.names, count: 3 }).rows, ['Ana', 'Ben', 'Kai']);
  // One slide title with a colon in a draft is not a presenter.
  assert.deepEqual(labeledNames('Slide 1\nAgenda: Q3 plan.\n\nSlide 2\nThe problem.\n\nSlide 3\nThe fix.'), []);
});

test('A new text that brings an unknown presenter name is not collapsed into one voice', () => {
  // What Write my script hands over: two presenters, one of them saved here already.
  const value = 'Slide 1\nAlex: Good morning everyone.\nSam: We are glad you came.\n\nSlide 2\nAlex: Here is the plan.';
  const saved = ['Alex'];
  const { speakers } = parseScript(value, { slideCount: 2, names: saved });
  assert.deepEqual(speakers, ['Alex'], 'a name used once is not a presenter on its own');
  const found = labeledNames(value);
  assert.deepEqual(found, ['Alex', 'Sam']);
  const names = namesForNewText(found, speakers);
  assert.deepEqual(names, ['Alex', 'Sam'], 'the names the text labels win');

  const parsed = parseScript(value, { slideCount: 2, names });
  const roster = resolveRoster({ speakers: parsed.speakers, names, count: null });
  assert.equal(roster.count, 2);
  assert.deepEqual(roster.rows, ['Alex', 'Sam']);
  const played = flattenSentences(applyRoster(parsed, roster));
  assert.deepEqual(played.map((s) => s.speaker), ['Alex', 'Sam', 'Alex']);
  assert.deepEqual(played.map((s) => s.text), ['Good morning everyone.', 'We are glad you came.', 'Here is the plan.']);
  assert.ok(played.every((s) => !/^[\p{L}][\p{L} ]*:/u.test(s.text)), 'no name is left to be read aloud');

  // A text the parser already reads in full keeps the presenters it has.
  assert.equal(namesForNewText(['Ana', 'Ben'], ['Ana', 'Ben']), null);
  assert.equal(namesForNewText([], ['Ana']), null);
  assert.deepEqual(namesForNewText(['A', 'B', 'C', 'D'], []), ['A', 'B', 'C']);
});

test('Migration: names from the old AI helper do not rename a script without names', () => {
  assert.deepEqual(migrateNames({ pageCount: 2 }, 'Slide 1\nHello.\n\nSlide 2\nBye.', ['Alex', 'Sam']), []);
  assert.deepEqual(migrateNames({ pageCount: 2 }, 'Slide 1\nAlex: Hello.\n\nSlide 2\nSam: Bye.', ['Alex', 'Sam']), ['Alex', 'Sam']);
  assert.deepEqual(migrateNames({ pageCount: 2, count: null }, 'Slide 1\nHello.', ['Alex']), ['Alex']);
});
