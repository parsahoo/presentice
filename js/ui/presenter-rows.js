// Presenters section on the Script step: how many, a name and a voice for each.
import { $, h, clear, icon } from './dom.js';
import { VOICES, voiceLabel } from '../voices.js';
import { MAX_PRESENTERS, placeholderName } from '../roster.js';
import { playVoice, stopVoice, previewOwner, onPreviewChange } from './voice-preview.js';

const PLAY = ['M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z'];
const STOP = ['M7 7h10v10H7z'];

/**
 * @param {{
 *   onCount: (n: number) => void,
 *   onRename: (index: number, raw: string) => { name: string, error?: string, note?: string },
 *   onVoice: (index: number, voiceId: string) => void,
 *   onPreviewError: () => void,
 * }} handlers
 */
export function initPresenterRows({ onCount, onRename, onVoice, onPreviewError }) {
  const block = $('#presentersBlock');
  const countGroup = $('#presenterCount');
  const list = $('#presenterRows');
  const note = $('#presenterNote');
  // One polite live region: a screen reader hears why a name was refused or changed.
  const live = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  block.append(live);
  let last = null;
  // Why the last count picked did not apply, kept while the script and the count stay as they were.
  let countNote = null;
  countGroup.setAttribute('aria-describedby', note.id);

  const countButtons = Array.from({ length: MAX_PRESENTERS }, (_, i) =>
    h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', onclick: () => onCount(i + 1) }, String(i + 1)),
  );
  countGroup.append(...countButtons);

  /** The text the name field shows for a row name: empty for a placeholder. */
  const fieldValue = (i, name) => (last && name === placeholderName(i, last.roster.count) ? '' : name);

  const rows = Array.from({ length: MAX_PRESENTERS }, (_, i) => {
    const who = `row-${i}`;
    const input = h('input', {
      class: 'input pb-name',
      type: 'text',
      id: `pbName${i}`,
      maxlength: '30',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
      'aria-describedby': `pbProblem${i} pbMeta${i}`,
    });
    const select = h('select', { class: 'pb-voice', id: `pbVoice${i}` }, ...VOICES.map((v) => h('option', { value: v.id }, voiceLabel(v))));
    const play = h('button', { type: 'button', class: 'btn pb-play' });
    const meta = h('p', { class: 'pb-meta', id: `pbMeta${i}`, hidden: true });
    const problem = h('p', { class: 'pb-problem', id: `pbProblem${i}`, hidden: true });
    const nameLabel = h('label', { for: input.id, class: 'visually-hidden' });
    const voiceLabelEl = h('label', { for: select.id, class: 'visually-hidden' });
    const li = h('li', { class: 'pb-row' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), nameLabel, input, voiceLabelEl, select, play, problem, meta);
    const row = { li, input, select, play, meta, nameLabel, voiceLabelEl, who, problemFor: null, showProblem: null };

    /** Show an error (the name was refused) or a note (it was saved changed), or clear both. */
    row.showProblem = (text, { error = true, name = null } = {}) => {
      problem.textContent = text;
      problem.hidden = !text;
      problem.classList.toggle('is-note', Boolean(text) && !error);
      input.setAttribute('aria-invalid', String(Boolean(text) && error));
      row.problemFor = text ? name : null;
      if (text) live.textContent = text;
    };

    // The field text last applied, so leaving the field does not apply it (and clear its message) twice.
    let committed = null;

    /**
     * Apply the typed name. Only now does the script change. A refused name leaves the row as it
     * was and stays in the field, so it can be fixed in place.
     */
    const commit = () => {
      if (!last || li.hidden) return null;
      const result = onRename(i, input.value);
      if (result.error) row.showProblem(result.error, { name: result.name });
      else {
        input.value = fieldValue(i, result.name);
        if (result.note) row.showProblem(result.note, { error: false, name: result.name });
        else row.showProblem('');
      }
      committed = input.value;
      return result;
    };

    input.addEventListener('focus', () => {
      committed = input.value;
    });
    // Typing only edits the field. A problem shown for the last try goes away as soon as it is changed.
    input.addEventListener('input', () => {
      committed = null;
      if (!problem.hidden) row.showProblem('');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (commit()?.error) input.select();
      } else if (e.key === 'Escape' && last) {
        // Back to the name the row has.
        input.value = fieldValue(i, last.roster.rows[i]);
        committed = input.value;
        row.showProblem('');
      }
    });
    input.addEventListener('blur', () => {
      if (input.value !== committed) commit();
      if (last) render(last);
    });
    select.addEventListener('change', () => {
      onVoice(i, select.value);
      playVoice(select.value, who, onPreviewError);
    });
    play.addEventListener('click', () => {
      if (previewOwner() === who) stopVoice();
      else playVoice(select.value, who, onPreviewError);
    });
    list.append(li);
    return row;
  });

  function paintPlay(row) {
    const playing = previewOwner() === row.who;
    const voice = VOICES.find((v) => v.id === row.select.value);
    clear(row.play).append(icon(playing ? STOP : PLAY, { filled: true, size: 16 }));
    row.play.setAttribute('aria-label', playing ? 'Stop the voice sample' : `Hear ${voice ? voice.name : 'this voice'}`);
    row.play.title = playing ? 'Stop' : 'Hear this voice';
    row.play.classList.toggle('is-playing', playing);
  }
  onPreviewChange(() => rows.forEach(paintPlay));

  function noteText(roster) {
    if (roster.solo) return `Every line plays as ${roster.rows[0]}, in one voice. The names in your script stay as they are.`;
    const extra = roster.speakers.length - MAX_PRESENTERS;
    if (extra > 0) {
      return `Your script has ${roster.speakers.length} presenters. The first ${MAX_PRESENTERS} are shown here. Pick voices for the others in Presenters and voices while you practice.`;
    }
    return '';
  }

  /** Show the presenters of the derived script. Never rewrites a field while it is being typed in. */
  function render(derived) {
    last = derived;
    const { roster, voices, colorIndex, lineCounts } = derived;
    const { count } = roster;
    block.classList.toggle('is-single', count === 1);
    countButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === count)));
    rows.forEach((row, i) => {
      row.li.hidden = i >= count;
      if (row.li.hidden) {
        row.showProblem('');
        return;
      }
      const name = roster.rows[i];
      const placeholder = placeholderName(i, count);
      row.li.className = `pb-row pc-${colorIndex[name] ?? i}`;
      row.input.placeholder = placeholder;
      if (document.activeElement !== row.input) row.input.value = name === placeholder ? '' : name;
      // A message about another name (the count or the script changed since) no longer applies.
      if (row.problemFor !== null && row.problemFor !== name) row.showProblem('');
      row.nameLabel.textContent = `Name of presenter ${i + 1}`;
      row.voiceLabelEl.textContent = `Voice of presenter ${i + 1}`;
      if (voices[name]) row.select.value = voices[name];
      const empty = count > 1 && !roster.solo && !lineCounts.get(name);
      row.meta.hidden = !empty;
      row.meta.textContent = empty ? `No lines yet. Start a line with "${name}:" to give it one.` : '';
      paintPlay(row);
    });
    // A note about a count that did not apply lasts until the script or the count changes.
    if (countNote && (countNote.speakers !== roster.speakers.length || countNote.count !== count)) countNote = null;
    const text = countNote?.text || noteText(roster);
    note.hidden = !text;
    note.textContent = text;
  }

  /** Say why the count picked did not apply, or clear that ('' ). */
  function showCountNote(text) {
    countNote = text && last ? { text, speakers: last.roster.speakers.length, count: last.roster.count } : null;
    if (text) live.textContent = text;
    if (last) render(last);
  }

  return { render, showCountNote };
}
