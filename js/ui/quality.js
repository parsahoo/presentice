// The Voice quality control, shared by the Script step and the Presenters panel.
// It only ever reports what the user picked; nothing here switches quality on its own.
import { h, clear } from './dom.js';
import { QUALITIES, NEEDS_WEBGPU, NO_WEBGPU_NOTE, qualityOf } from '../engine-quality.js';
import { webGpuAvailable } from '../tts.js';

/**
 * @param {{ group: Element, note: Element, onChange: (id: string) => void }} parts
 */
export function initQuality({ group, note, onChange }) {
  let current = QUALITIES[0].id;
  let hasWebGpu = true; // assumed only for the note text; High is never enabled by a guess
  let answered = false;

  const buttons = QUALITIES.map((q) =>
    h(
      'button',
      { type: 'button', class: 'seg', 'aria-pressed': 'false', dataset: { quality: q.id }, onclick: () => onChange(q.id) },
      q.label,
    ),
  );
  clear(group).append(...buttons);

  function paint() {
    const blocked = answered && !hasWebGpu;
    for (const b of buttons) {
      const id = b.dataset.quality;
      b.setAttribute('aria-pressed', String(id === current));
      // Until the probe answers, High stays disabled: enabling it on a guess lets a
      // click tear down the loaded model and land on an engine error.
      b.disabled = id === NEEDS_WEBGPU && (!answered || !hasWebGpu);
    }
    note.textContent = blocked ? NO_WEBGPU_NOTE : qualityOf(current).note;
  }

  webGpuAvailable().then((ok) => {
    answered = true;
    hasWebGpu = ok;
    paint();
  });

  return {
    /** Show `id` as the picked quality. */
    render(id) {
      current = qualityOf(id).id;
      paint();
    },
  };
}
