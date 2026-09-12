// Script step: presenters, one textarea, the AI chat helper and a live read-only preview.
import { $, h, clear } from './dom.js';
import { buildPrompt, draftScript, labeledNames } from '../script-parser.js';
import { stripPua } from '../slide-text.js';
import {
  placeholderName,
  assignRoundRobin,
  renameSpeaker,
  cleanName,
  nameProblem,
  keepHidden,
  namesForNewText,
  planCount,
  countBlockedNote,
} from '../roster.js';
import { initPresenterRows } from './presenter-rows.js';
import { initQuality } from './quality.js';
import { AiError, KEY_PAGE, errorText, loadKey, removeKey, requestScript, saveKey } from '../ai-writer.js';

const MAX_TEXT_FILE = 2 * 1024 * 1024;
const MAX_UNDO = 20;
const NO_TEXT_HINT = 'No selectable text found. Paste or write a script.';
const EMPTY_HINT = 'Your script is empty. Paste one, or use Draft from my slides.';
const DRAFT_SUB = 'A draft made from your slides. It is ready to play, or edit it and the preview updates as you type.';
const EDIT_SUB = 'Edit anything. The preview updates as you type.';

const sameList = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameVoices = (a = {}, b = {}) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};
const isUndoKey = (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';

export function initScript({ app }) {
  const textarea = $('#scriptText');
  const startButton = $('#startPracticing');
  const draftButton = $('#draftScript');
  const aiPanel = $('#aiPanel');
  const aiToggle = $('#aiToggle');
  const pasteStatus = $('#pasteStatus');
  const keyInput = $('#aiKey');
  const removeKeyButton = $('#aiKeyRemove');
  const writeButton = $('#aiWrite');
  const undoButton = $('#aiUndo');
  const aiStatus = $('#aiStatus');
  let writing = false;
  // The script, presenters and voices an AI answer replaced, for one step back.
  let beforeWrite = null;
  let current = null; // app.derive() of the text in the textarea
  let loadedFor = null; // the project the textarea holds; nothing is written into another one
  let parseTimer = 0;
  let saveTimer = 0;
  let draftPages = null;
  let draftText = '';
  // Edits made by the presenters section, newest last, so Ctrl+Z or Cmd+Z can take them back.
  let undo = [];

  const isStale = () => !loadedFor || app.project() !== loadedFor;

  /** The draft made from this project's slides, computed once per project. */
  function slideDraft(project) {
    if (draftPages !== project.pages) {
      draftPages = project.pages;
      draftText = draftScript(project.pages).trim();
    }
    return draftText;
  }

  /** The derived script, with the section and the preview showing it. */
  function fresh() {
    renderPreview();
    return current;
  }

  /** Save voices over the saved ones: a presenter hidden for now (1 picked) keeps its voice. */
  function setVoices(voices, drop = null) {
    const next = { ...app.project().voices, ...voices };
    if (drop) delete next[drop];
    if (!sameVoices(next, app.project().voices)) app.setVoices(next);
  }

  /** The presenters and the text as they are now, to take a change back. */
  function snapshot() {
    const { count = null, names = [], voices = {} } = app.project();
    return { text: textarea.value, count, names: [...names], voices: { ...voices } };
  }

  /** Change the text for the presenters section. Keeps the caret, the scroll position and a way back. */
  function setText(value, before) {
    const { scrollTop, selectionStart, selectionEnd } = textarea;
    undo = [...undo.slice(1 - MAX_UNDO), { ...before, after: value }];
    textarea.value = value;
    textarea.scrollTop = scrollTop;
    if (document.activeElement === textarea) textarea.setSelectionRange(Math.min(selectionStart, value.length), Math.min(selectionEnd, value.length));
    queueSave();
  }

  // Setting the text by code clears the browser's own undo, so the last changes made here
  // (a rename, a new count) are taken back by hand, presenters included.
  textarea.addEventListener('keydown', (e) => {
    if (!isUndoKey(e)) return;
    const last = undo[undo.length - 1];
    if (!last || textarea.value !== last.after) return;
    e.preventDefault();
    undo = undo.slice(0, -1);
    const caret = Math.min(textarea.selectionStart, last.text.length);
    textarea.value = last.text;
    textarea.setSelectionRange(caret, caret);
    app.setCount(last.count);
    app.setNames(last.names);
    app.setVoices(last.voices);
    queueSave();
    renderPreview();
  });

  function setCount(n) {
    if (isStale()) return;
    const before = fresh();
    const { roster } = before;
    const text = textarea.value;
    const snap = snapshot();
    const plan = planCount({ text, roster, names: app.project().names, count: n });
    // The script names more presenters than that: nothing is saved, the note says what to do.
    const trial = app.derive(plan.text, { names: plan.names, count: n });
    if (trial.roster.count !== n) {
      presenterRows.showCountNote(countBlockedNote(trial.roster, n));
      return;
    }
    presenterRows.showCountNote('');
    app.setCount(n);
    app.setNames(plan.names);
    if (plan.text !== text) setText(plan.text, snap);
    const after = fresh();
    // Each row keeps its voice when its name changes with the count ("You" becomes "Presenter 1").
    const voices = {};
    after.roster.rows.forEach((name, i) => {
      const prev = roster.rows[i];
      if (prev && prev !== name) voices[name] = before.voices[prev];
    });
    setVoices(voices);
    fresh();
  }

  /**
   * Commit a typed name for row `i`. The script changes only here, from the name the row
   * had to the new one, so a half-typed name never reaches it.
   * @returns {{ name: string, error?: string, note?: string }} name: the row's name now.
   */
  function renameRow(i, raw) {
    if (isStale()) return { name: '' };
    const { roster, voices } = current || fresh();
    const old = roster.rows[i];
    const placeholder = placeholderName(i, roster.count);
    const typed = String(raw ?? '').trim().replace(/\s+/g, ' ');
    const cleaned = cleanName(raw);
    const keep = (error) => ({ name: old, error: `${error} The name stays ${old}.` });
    if (typed && !cleaned) return keep('A name has to start with a letter.');
    const name = cleaned || placeholder;
    // Say so when the name was changed on the way in ("Mary Ann Smith" is saved as "Mary Ann").
    const note = cleaned && typed.toLowerCase() !== cleaned.toLowerCase()
      ? `Saved as ${cleaned}. A name is one or two words and starts with a letter.`
      : '';
    if (name === old) return { name, note };
    if (name !== placeholder) {
      const problem = nameProblem(name, i, roster.rows, textarea.value);
      if (problem) return keep(problem);
    }
    const snap = snapshot();
    const text = textarea.value;
    const next = renameSpeaker(text, old, name);
    const lower = name.toLowerCase();
    const names = keepHidden(roster.rows.map((r, j) => (j === i ? name : r)), app.project().names)
      // A presenter hidden by a smaller count gives the name up, so two rows never share it.
      .map((n, j) => (j >= roster.rows.length && String(n || '').toLowerCase() === lower ? '' : n));
    app.setNames(names);
    // The voice belongs to the row, not to the old name.
    setVoices({ [name]: voices[old] }, old);
    if (next !== text) setText(next, snap);
    fresh();
    return { name, note };
  }

  const presenterRows = initPresenterRows({
    onCount: setCount,
    onRename: renameRow,
    onVoice: (i, voiceId) => {
      if (isStale()) return;
      const { roster, voices } = current || fresh();
      // Every row's voice is saved, so the defaults shown are the ones kept.
      setVoices({ ...voices, [roster.rows[i]]: voiceId });
      fresh();
    },
    onPreviewError: () => app.toast('The voice sample could not play.'),
  });

  const quality = initQuality({
    group: $('#qualityGroup'),
    note: $('#qualityNote'),
    onChange: (id) => {
      app.setQuality(id);
      quality.render(app.quality());
    },
  });

  /**
   * A whole new text (paste, file, draft). A script with names follows its names;
   * one without keeps the presenters picked above, sharing the slides in turn.
   * fromDraft: our own draft from the slides, which never has names.
   */
  function settleWholeText(value, { fromDraft = false } = {}) {
    const project = app.project();
    const { roster } = app.derive(value);
    // Lines that carry names ("Ana: Hello." then "Ben: Next part."): those are the presenters,
    // including the ones the parser did not recognize on its own because they are new here.
    const found = fromDraft ? [] : labeledNames(value);
    const adopt = namesForNewText(found, roster.speakers);
    if (adopt) {
      app.setNames(adopt);
      if (project.count != null) app.setCount(null);
      return value;
    }
    if (roster.speakers.length) {
      if (project.count != null) app.setCount(null);
      return value;
    }
    return roster.count > 1 ? assignRoundRobin(value, roster.rows) : value;
  }

  /** Replace the whole text in a way the browser can undo (Ctrl+Z or Cmd+Z). */
  function replaceText(text, options) {
    const value = settleWholeText(text, options);
    textarea.focus();
    textarea.select();
    let done = false;
    try {
      done = document.execCommand('insertText', false, value);
    } catch {
      done = false;
    }
    if (!done || textarea.value !== value) textarea.value = value;
    textarea.setSelectionRange(0, 0);
    textarea.scrollTop = 0;
    onInput();
  }

  // The "Get a key" link and the request go to one place, named once in js/ai-writer.js.
  $('#aiKeyLink').href = KEY_PAGE;

  aiToggle.addEventListener('click', () => {
    const open = aiPanel.hidden;
    aiPanel.hidden = !open;
    aiToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      renderAiFor();
      $('#copyPrompt').focus();
    }
  });

  /** The prompt for both AI paths: the one Copy prompt hands over, and the one we send. */
  function promptNow() {
    const project = app.project();
    const { roster } = current || fresh();
    // A lone presenter with no name gets no name in the prompt.
    const names = roster.rows.map((r) => (roster.count === 1 && r === placeholderName(0, 1) ? '' : r));
    return buildPrompt({ pages: project.pages, count: roster.count, names });
  }

  $('#copyPrompt').addEventListener('click', () => {
    const prompt = promptNow();
    const status = $('#copyStatus');
    const fallback = () => {
      const box = $('#promptFallback');
      const text = $('#promptText');
      box.hidden = false;
      text.value = prompt;
      text.focus();
      text.select();
      status.textContent = '';
    };
    if (!navigator.clipboard?.writeText) {
      fallback();
      return;
    }
    navigator.clipboard.writeText(prompt).then(
      () => {
        $('#promptFallback').hidden = true;
        status.textContent = 'Copied. Paste it into a chat.';
      },
      fallback,
    );
  });

  $('#pasteHere').addEventListener('click', async () => {
    pasteStatus.textContent = '';
    let text = '';
    if (navigator.clipboard?.readText) {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = '';
      }
    }
    if (text.trim()) {
      replaceText(text);
      pasteStatus.textContent = 'Pasted. Check the preview.';
      return;
    }
    // Reading the clipboard was blocked or it was empty: paste by hand over the selection.
    textarea.focus();
    textarea.select();
    pasteStatus.textContent = 'Press Ctrl+V or Cmd+V to paste.';
  });

  // Writing the script with the user's own Gemini key. Copy prompt above stays the
  // path for everyone without one.
  function forgetWrite() {
    beforeWrite = null;
    undoButton.hidden = true;
  }

  function setWriting(on) {
    writing = on;
    writeButton.disabled = on;
    writeButton.textContent = on ? 'Writing your script' : 'Write my script';
    if (on) writeButton.setAttribute('aria-busy', 'true');
    else writeButton.removeAttribute('aria-busy');
  }

  keyInput.addEventListener('input', () => {
    removeKeyButton.hidden = !keyInput.value.trim();
  });
  // Kept when the field is left or Enter is pressed, not on every keystroke.
  keyInput.addEventListener('change', () => saveKey(keyInput.value));
  keyInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    saveKey(keyInput.value);
    writeButton.click();
  });

  removeKeyButton.addEventListener('click', () => {
    removeKey();
    keyInput.value = '';
    removeKeyButton.hidden = true;
    aiStatus.textContent = 'Key removed from this browser.';
    keyInput.focus();
  });

  writeButton.addEventListener('click', async () => {
    if (writing || isStale()) return;
    const key = keyInput.value.trim();
    if (!key) {
      aiStatus.textContent = errorText(new AiError('no-key'));
      keyInput.focus();
      return;
    }
    saveKey(key);
    const project = app.project();
    const prompt = promptNow();
    setWriting(true);
    aiStatus.textContent = 'Asking Gemini for your script. This takes a few seconds.';
    let script = null;
    let failure = null;
    try {
      script = await requestScript(prompt, key);
    } catch (err) {
      failure = err;
    }
    setWriting(false);
    // Another presentation was opened, or this step was left, while Google answered.
    if (isStale() || app.project() !== project) return;
    if (failure) {
      aiStatus.textContent = errorText(failure);
      return;
    }
    const snap = snapshot();
    replaceText(script);
    beforeWrite = snap;
    undoButton.hidden = false;
    aiStatus.textContent = 'Gemini replaced your script. Check the preview, or undo.';
  });

  undoButton.addEventListener('click', () => {
    const snap = beforeWrite;
    if (!snap) return;
    forgetWrite();
    textarea.value = snap.text;
    textarea.setSelectionRange(0, 0);
    textarea.scrollTop = 0;
    app.setCount(snap.count);
    app.setNames(snap.names);
    app.setVoices(snap.voices);
    queueSave();
    renderPreview();
    aiStatus.textContent = 'Your script is back to what it was.';
  });

  draftButton.addEventListener('click', () => {
    const draft = draftScript(app.project().pages);
    const current = textarea.value.trim();
    if (current && current !== draft.trim()) {
      const ok = window.confirm('Replace your script with a new draft made from your slides? Ctrl+Z or Cmd+Z undoes it.');
      if (!ok) return;
    }
    replaceText(draft, { fromDraft: true });
  });

  // Ctrl+V or Cmd+V over the whole script (or into an empty one) is a whole new text, like Paste here.
  // A paste into part of the script is an ordinary edit.
  textarea.addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    if (!pasted.trim()) return;
    const { value, selectionStart, selectionEnd } = textarea;
    if ((value.slice(0, selectionStart) + value.slice(selectionEnd)).trim()) return;
    e.preventDefault();
    pasteStatus.textContent = '';
    replaceText(pasted);
  });

  // Text file upload
  const textInput = $('#textInput');
  $('#uploadText').addEventListener('click', () => textInput.click());
  textInput.addEventListener('change', async () => {
    const file = textInput.files?.[0];
    textInput.value = '';
    if (!file) return;
    if (file.size > MAX_TEXT_FILE) {
      app.toast('That file is too large for a script. Use a text file under 2 MB.');
      return;
    }
    try {
      replaceText(await file.text());
    } catch {
      app.toast('That file could not be read. Save it as plain text and try again.');
    }
  });

  /** Save the text now, but only into the project it was loaded for. */
  function saveNow() {
    clearTimeout(saveTimer);
    if (!isStale()) app.setScript(textarea.value);
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  function onInput() {
    // An edit of your own is what Undo would otherwise throw away.
    forgetWrite();
    queueSave();
    schedulePreview();
  }
  textarea.addEventListener('input', onInput);

  function schedulePreview() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(renderPreview, 180);
  }

  /** One line in the AI helper: the prompt uses the presenters from the section above. */
  function renderAiFor() {
    const { roster } = current || fresh();
    const named = roster.rows.filter((r, i) => r !== placeholderName(i, roster.count));
    const who = roster.count === 1
      ? `1 presenter${named.length ? `, ${named[0]}` : ''}`
      : `${roster.count} presenters: ${roster.rows.join(', ')}`;
    $('#aiFor').textContent = `The prompt asks for ${who}. Change that in Presenters above.`;
  }

  function renderPreview() {
    clearTimeout(parseTimer);
    if (isStale()) return;
    const project = app.project();
    const derived = app.derive(textarea.value);
    current = derived;
    // Keep the saved rows in step with the script (a pasted answer brings its own names).
    // Rows hidden by a smaller count keep their names, so they come back with them.
    const names = keepHidden(derived.roster.rows, project.names || []);
    if (!sameList(names, project.names)) app.setNames(names);
    presenterRows.render(derived);
    if (!aiPanel.hidden) renderAiFor();
    const { parsed, sentences, presenters, colorIndex } = derived;
    const empty = sentences.length === 0;
    const hint = $('#emptyHint');
    hint.hidden = !empty;
    hint.textContent = project.noText ? NO_TEXT_HINT : EMPTY_HINT;
    startButton.disabled = empty;

    // Empty: the hint speaks. A fresh draft from the slides: say so. Anything else: just editing.
    const sub = $('#editorSub');
    const text = textarea.value.trim();
    sub.hidden = !text;
    sub.textContent = !project.isSample && text === slideDraft(project) ? DRAFT_SUB : EDIT_SUB;

    const summary = $('#previewSummary');
    if (empty) summary.textContent = 'Nothing to play yet';
    else {
      const who = presenters.length === 1 ? '1 presenter' : `${presenters.length} presenters: ${presenters.join(', ')}`;
      summary.textContent = `${who}. ${sentences.length} ${sentences.length === 1 ? 'sentence' : 'sentences'}.`;
    }

    const warnHost = clear($('#previewWarnings'));
    for (const w of parsed.warnings.filter((x) => x.kind !== 'empty-slide')) {
      warnHost.append(h('li', {}, h('span', { class: 'warn-mark', 'aria-hidden': 'true' }, '!'), w.text));
    }

    const list = clear($('#previewList'));
    parsed.slides.forEach((slide, i) => {
      const body = h('div', { class: 'pv-body' }, h('p', { class: 'pv-num' }, `Slide ${i + 1}`));
      if (!slide.paragraphs.length) {
        body.append(h('p', { class: 'pv-warn' }, h('span', { class: 'warn-mark', 'aria-hidden': 'true' }, '!'), 'No script yet'));
      }
      for (const para of slide.paragraphs) {
        const chip = h('span', { class: `chip pc-${colorIndex[para.speaker] ?? 0}` }, h('span', { class: 'dot' }), para.speaker);
        body.append(h('p', { class: 'pv-para' }, presenters.length > 1 ? chip : null, para.text));
      }
      const thumb = app.thumbUrl(i);
      list.append(
        h('li', { class: 'pv-slide' }, thumb ? h('img', { class: 'pv-thumb', src: thumb, alt: `Slide ${i + 1}` }) : h('span', {}), body),
      );
    });
  }

  startButton.addEventListener('click', () => {
    saveNow();
    app.startPracticing();
  });

  return {
    show() {
      const project = app.project();
      clearTimeout(saveTimer);
      loadedFor = project;
      undo = [];
      // Symbol-font glyphs from an older draft show as empty boxes: clean them once.
      const clean = stripPua(project.script);
      if (clean !== project.script) app.setScript(clean);
      textarea.value = clean;
      draftButton.hidden = Boolean(project.noText);
      pasteStatus.textContent = '';
      aiStatus.textContent = '';
      forgetWrite();
      setWriting(false);
      keyInput.value = loadKey();
      removeKeyButton.hidden = !keyInput.value;
      quality.render(app.quality());
      renderPreview();
    },
    /** Save the text now. Does nothing once another project is open. */
    flush() {
      saveNow();
    },
  };
}
