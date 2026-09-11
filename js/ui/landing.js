// Landing screen and the reusable PDF drop zone.
import { $, h } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function dropArt() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 48');
  svg.setAttribute('width', '64');
  svg.setAttribute('height', '48');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'drop-art');
  const shapes = [
    ['rect', { x: 10, y: 4, width: 44, height: 30, rx: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }],
    ['rect', { x: 4, y: 10, width: 44, height: 30, rx: 4, fill: 'var(--surface)', stroke: 'currentColor', 'stroke-width': 2 }],
    ['path', { d: 'M26 34V20m-6 6 6-6 6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
  ];
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

/**
 * A drop zone that is also the file picker button.
 * Returns { el, setBusy(text, fraction), reset() }.
 */
export function createDropzone({ onFile }) {
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const title = h('span', { class: 'drop-title' }, 'Drop your slides here');
  const sub = h('span', { class: 'drop-sub' }, 'PDF, up to 60 pages and 50 MB. Or click to choose a file.');
  const fill = h('span', { class: 'track-fill' });
  const progressText = h('span', {});
  const progress = h('span', { class: 'drop-progress', hidden: true }, progressText, h('span', { class: 'track' }, fill));
  const button = h('button', { type: 'button', class: 'drop-button' }, dropArt(), title, sub, progress);
  const el = h('div', { class: 'dropzone' }, button, input);

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) onFile(file);
  });
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth += 1;
    el.classList.add('is-over');
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove('is-over');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (file && !button.disabled) onFile(file);
  });

  return {
    el,
    setBusy(text, fraction) {
      button.disabled = true;
      title.hidden = true;
      sub.hidden = true;
      progress.hidden = false;
      progressText.textContent = text;
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction || 0))})`;
    },
    reset() {
      button.disabled = false;
      title.hidden = false;
      sub.hidden = false;
      progress.hidden = true;
      fill.style.transform = 'scaleX(0)';
    },
  };
}

export function initLanding({ onFile, onSample }) {
  const zone = createDropzone({ onFile: (file) => onFile(file, zone, $('#landingError')) });
  $('#landingDrop').append(zone.el);
  $('#landingSample').addEventListener('click', () => onSample(zone, $('#landingError')));
  return { zone };
}

/** Progress copy shared by both drop zones. */
export function progressLabel(phase, n, total) {
  if (phase === 'text') return { text: `Reading your slides: ${n} of ${total}`, fraction: (n / total) * 0.4 };
  return { text: `Making previews: ${n} of ${total}`, fraction: 0.4 + (n / total) * 0.6 };
}
