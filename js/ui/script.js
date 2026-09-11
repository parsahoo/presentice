// Script step: one textarea, the AI chat helper and a live read-only preview.
import { $, h, clear } from './dom.js';
import { buildPrompt, draftScript, DEFAULT_PRESENTER } from '../script-parser.js';

const MAX_TEXT_FILE = 2 * 1024 * 1024;
const NO_TEXT_HINT = 'No selectable text found. Paste or write a script.';
const EMPTY_HINT = 'Your script is empty. Paste one, or use Draft from my slides.';
const DRAFT_SUB = 'A draft made from your slides. It is ready to play, or edit it and the preview updates as you type.';
const EDIT_SUB = 'Edit anything. The preview updates as you type.';

export function initScript({ app }) {
  const textarea = $('#scriptText');
  const startButton = $('#startPracticing');
  const draftButton = $('#draftScript');
  const aiPanel = $('#aiPanel');
  const aiToggle = $('#aiToggle');
  const countGroup = $('#aiCount');
  const namesHost = $('#aiNames');
  const pasteStatus = $('#pasteStatus');
  let count = 1;
  let names = [];
  let parseTimer = 0;
  let saveTimer = 0;
  let draftPages = null;
  let draftText = '';

  /** The draft made from this project's slides, computed once per project. */
  function slideDraft(project) {
    if (draftPages !== project.pages) {
      draftPages = project.pages;
      draftText = draftScript(project.pages).trim();
    }
    return draftText;
  }

  // Presenter count buttons
  const countButtons = [1, 2, 3].map((n) =>
    h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', onclick: () => setCount(n) }, String(n)),
  );
  countGroup.append(...countButtons);

  function renderNames() {
    clear(namesHost);
    for (let i = 0; i < count; i += 1) {
      const input = h('input', {
        class: 'input',
        type: 'text',
        maxlength: '30',
        autocomplete: 'off',
        placeholder: 'Name (optional)',
        value: names[i] || '',
      });
      input.addEventListener('input', () => {
        names[i] = input.value.trim();
        commitNames();
      });
      namesHost.append(h('label', {}, `Presenter ${i + 1}`, input));
    }
  }

  function commitNames() {
    const used = names.slice(0, count).map((n) => (n || '').trim());
    app.setNames(used.filter(Boolean).length ? used : []);
    schedulePreview();
  }

  function setCount(n) {
    count = n;
    countButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === n)));
    renderNames();
    commitNames();
  }

  /** Replace the whole text in a way the browser can undo (Ctrl+Z or Cmd+Z). */
  function replaceText(value) {
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

  aiToggle.addEventListener('click', () => {
    const open = aiPanel.hidden;
    aiPanel.hidden = !open;
    aiToggle.setAttribute('aria-expanded', String(open));
    if (open) countButtons[count - 1].focus();
  });

  $('#copyPrompt').addEventListener('click', () => {
    const project = app.project();
    const prompt = buildPrompt({ pages: project.pages, count, names: names.slice(0, count) });
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

  draftButton.addEventListener('click', () => {
    const draft = draftScript(app.project().pages);
    const current = textarea.value.trim();
    if (current && current !== draft.trim()) {
      const ok = window.confirm('Replace your script with a new draft made from your slides? Ctrl+Z or Cmd+Z undoes it.');
      if (!ok) return;
    }
    replaceText(draft);
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

  function onInput() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => app.setScript(textarea.value), 300);
    schedulePreview();
  }
  textarea.addEventListener('input', onInput);

  function schedulePreview() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(renderPreview, 180);
  }

  function renderPreview() {
    const project = app.project();
    const derived = app.derive(textarea.value);
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
    clearTimeout(saveTimer);
    app.setScript(textarea.value);
    app.startPracticing();
  });

  return {
    show() {
      const project = app.project();
      textarea.value = project.script;
      draftButton.hidden = Boolean(project.noText);
      pasteStatus.textContent = '';
      names = [...(project.names || [])];
      if (!names.some(Boolean)) {
        // Start the AI helper from the presenters the script already has.
        const detected = app.derive(project.script).presenters.filter((p) => p !== DEFAULT_PRESENTER);
        names = detected.slice(0, 3);
      }
      count = Math.max(1, Math.min(3, names.length || 1));
      countButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === count)));
      renderNames();
      renderPreview();
    },
    flush() {
      clearTimeout(saveTimer);
      app.setScript(textarea.value);
    },
  };
}
