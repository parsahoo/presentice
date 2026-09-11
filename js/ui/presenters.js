// Presenters and voices panel. Optional; never a required step.
import { $, h, clear } from './dom.js';
import { VOICES, voiceLabel } from '../voices.js';

export function initPresenters({ app }) {
  const dialog = $('#presentersDialog');
  const list = $('#presenterList');
  const preview = new Audio();
  preview.preload = 'none';

  dialog.addEventListener('close', () => preview.pause());

  function playPreview(voiceId) {
    preview.pause();
    preview.src = new URL(`../../assets/voices/${voiceId}.mp3`, import.meta.url).href;
    preview.play().catch((err) => {
      if (err?.name !== 'AbortError') app.toast('The voice preview could not play.');
    });
  }

  function render() {
    const { presenters, voices, colorIndex, sentences } = app.info();
    clear(list);
    for (const name of presenters) {
      const lines = sentences.filter((s) => s.speaker === name).length;
      const id = `voice-${presenters.indexOf(name)}`;
      const select = h('select', { id }, ...VOICES.map((v) => h('option', { value: v.id, selected: voices[name] === v.id }, voiceLabel(v))));
      select.addEventListener('change', () => {
        app.setVoice(name, select.value);
        playPreview(select.value);
      });
      const previewButton = h('button', { type: 'button', class: 'btn small', onclick: () => playPreview(select.value) }, 'Preview');
      previewButton.setAttribute('aria-label', `Preview voice for ${name}`);
      list.append(
        h(
          'li',
          { class: `presenter pc-${colorIndex[name] ?? 0}` },
          h(
            'div',
            { class: 'presenter-top' },
            h('p', { class: 'presenter-name' }, h('span', { class: 'dot' }), name),
            h('span', { class: 'presenter-count' }, `${lines} ${lines === 1 ? 'sentence' : 'sentences'}`),
          ),
          h('div', { class: 'voice-row' }, h('label', { for: id, class: 'visually-hidden' }, `Voice for ${name}`), select, previewButton),
        ),
      );
    }
  }

  return {
    open() {
      render();
      dialog.showModal();
      list.querySelector('select')?.focus();
    },
  };
}
