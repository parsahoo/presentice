// Presenters and voices panel. Optional; never a required step.
import { $, h, clear } from './dom.js';
import { VOICES, voiceLabel } from '../voices.js';
import { playVoice, stopVoice } from './voice-preview.js';
import { initQuality } from './quality.js';

export function initPresenters({ app }) {
  const dialog = $('#presentersDialog');
  const list = $('#presenterList');
  const quality = initQuality({
    group: $('#dialogQualityGroup'),
    note: $('#dialogQualityNote'),
    onChange: (id) => {
      app.setQuality(id);
      quality.render(app.quality());
    },
  });

  dialog.addEventListener('close', stopVoice);

  function playPreview(voiceId) {
    playVoice(voiceId, 'dialog', () => app.toast('The voice preview could not play.'));
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
      quality.render(app.quality());
      dialog.showModal();
      list.querySelector('select')?.focus();
    },
  };
}
