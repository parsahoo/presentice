// Guided tour: a few short, skippable steps anchored to the real controls.
import { $ } from './dom.js';

const GAP = 14;

export function initTour({ steps, onClose }) {
  const card = $('#tour');
  const next = $('#tourNext');
  let list = [];
  let index = 0;
  let target = null;
  let returnFocus = null;

  function place() {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const w = card.offsetWidth;
    const hgt = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top;
    let left;
    if (r.width > vw * 0.45 && r.height > vh * 0.45) {
      // Large regions: sit inside, near the top right.
      top = r.top + GAP;
      left = r.right - w - GAP;
    } else if (r.height > vh * 0.45 && r.width >= w + GAP * 2) {
      // Tall columns (the script): sit inside, at the bottom, clear of the controls below.
      top = r.bottom - hgt - GAP;
      left = r.right - w - GAP;
    } else if (r.top > hgt + GAP * 2) {
      top = r.top - hgt - GAP;
      left = r.left + r.width / 2 - w / 2;
    } else {
      top = r.bottom + GAP;
      left = r.left + r.width / 2 - w / 2;
    }
    card.style.top = `${Math.max(12, Math.min(vh - hgt - 12, top))}px`;
    card.style.left = `${Math.max(12, Math.min(vw - w - 12, left))}px`;
  }

  function show() {
    target?.classList.remove('tour-target', 'tour-target-large');
    const step = list[index];
    target = step.target;
    target.classList.add('tour-target');
    const r = target.getBoundingClientRect();
    // A frame around half the screen reads as a border: draw it inside instead.
    target.classList.toggle('tour-target-large', r.width > window.innerWidth / 2 || r.height > window.innerHeight / 2);
    $('#tourCount').textContent = `${index + 1} of ${list.length}`;
    $('#tourTitle').textContent = step.title;
    $('#tourText').textContent = step.text;
    next.textContent = index === list.length - 1 ? 'Done' : 'Next';
    card.hidden = false;
    place();
    next.focus();
  }

  function close() {
    card.hidden = true;
    target?.classList.remove('tour-target', 'tour-target-large');
    target = null;
    onClose?.();
    returnFocus?.focus?.();
  }

  next.addEventListener('click', () => {
    if (index < list.length - 1) {
      index += 1;
      show();
    } else close();
  });
  $('#tourSkip').addEventListener('click', close);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  window.addEventListener('resize', () => {
    if (!card.hidden) place();
  });

  return {
    start() {
      list = steps().filter((s) => s.target && !s.target.closest('[hidden]'));
      if (!list.length) return;
      returnFocus = document.activeElement;
      index = 0;
      show();
    },
  };
}
