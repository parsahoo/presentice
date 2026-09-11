// Practice screen: slide, transcript with word highlight, transport and voice status.
import { $, $$, h, clear, icon } from './dom.js';
import { wordTimings } from '../sentences.js';
import { renderSlide, isCancelled } from '../pdf.js';
import { RATES } from '../player-state.js';

const ICONS = {
  PREV_SLIDE: ['M18 17l-5-5 5-5', 'M11 17l-5-5 5-5'],
  PREV: ['M15 18l-6-6 6-6'],
  NEXT: ['M9 18l6-6-6-6'],
  NEXT_SLIDE: ['M6 17l5-5-5-5', 'M13 17l5-5-5-5'],
  REPLAY: ['M4 12a8 8 0 1 0 2.5-5.8', 'M4 4v4.5h4.5'],
  LOOP: ['M17 2l3 3-3 3', 'M4 11V9a4 4 0 0 1 4-4h12', 'M7 22l-3-3 3-3', 'M20 13v2a4 4 0 0 1-4 4H4'],
  SHADOW: ['M4 10v4', 'M8 7v10', 'M12 10v4', 'M16 12h4', 'M18 10v4'],
};
const PLAY = ['M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z'];
const PAUSE = ['M8 5h3v14H8z', 'M13 5h3v14h-3z'];
const ACTIVE = new Set(['waiting', 'playing', 'gap']);
const MB = 1024 * 1024;
// Below this the stage is still being laid out: wait for the real size.
const MIN_STAGE_W = 160;
const MIN_STAGE_H = 90;

export function initPractice({ app, player }) {
  const body = $('#transcriptBody');
  const canvas = $('#slideCanvas');
  const fallback = $('#stageFallback');
  const stage = $('#stage');
  const strip = $('#strip');
  const playButton = $('#playButton');
  const focusGroup = $('#focusGroup');
  const speedGroup = $('#speedGroup');
  let sentenceEls = new Map(); // index -> { el, words: [span] }
  let renderedKey = '';
  let slideToken = 0;
  let renderedSlide = -1;
  let pendingSlide = -1;
  let renderJob = null;
  let lastStatus = null;

  // Transport buttons
  for (const btn of $$('#navGroup .tbtn')) {
    const cmd = btn.dataset.cmd;
    if (cmd !== 'TOGGLE_PLAY') btn.append(icon(ICONS[cmd]));
  }
  $('#loopButton').prepend(icon(ICONS.LOOP, { size: 16 }));
  $('#shadowButton').prepend(icon(ICONS.SHADOW, { size: 16 }));
  for (const btn of $$('#transport [data-cmd]')) {
    btn.addEventListener('click', () => {
      player.unlock();
      player.dispatch({ type: btn.dataset.cmd });
    });
  }
  const speedButtons = RATES.map((rate) =>
    h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', dataset: { rate }, onclick: () => player.dispatch({ type: 'SET_RATE', rate }) }, `${rate}x`),
  );
  speedGroup.append(...speedButtons);

  function setPlayIcon(active) {
    clear(playButton).append(icon(active ? PAUSE : PLAY, { filled: true, size: 22 }));
    playButton.setAttribute('aria-label', active ? 'Pause' : 'Play');
  }

  // Focus ("only my lines") group
  function renderFocus() {
    const { presenters, sentences, colorIndex } = app.info();
    clear(focusGroup);
    $('#focusWrap').hidden = presenters.length < 2;
    const options = [['all', 'Everyone'], ...presenters.map((p) => [p, p])];
    for (const [value, label] of options) {
      const has = value === 'all' || sentences.some((s) => s.speaker === value);
      const btn = h(
        'button',
        { type: 'button', class: `seg${value === 'all' ? '' : ` pc-${colorIndex[value] ?? 0}`}`, 'aria-pressed': 'false', dataset: { focus: value }, disabled: !has },
        value === 'all' ? null : h('span', { class: 'dot' }),
        label,
      );
      btn.addEventListener('click', () => {
        player.unlock();
        player.dispatch({ type: 'SET_FOCUS', focus: value });
      });
      focusGroup.append(btn);
    }
  }

  function renderStrip() {
    const project = app.project();
    clear(strip);
    strip.style.setProperty('--aspect', String(project.aspect || 16 / 9));
    for (let i = 0; i < project.pageCount; i += 1) {
      const btn = h(
        'button',
        { type: 'button', class: 'thumb', 'aria-label': `Slide ${i + 1}`, dataset: { slide: i } },
        h('img', { src: app.thumbUrl(i) || '', alt: '' }),
        h('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)),
      );
      btn.addEventListener('click', () => player.dispatch({ type: 'GOTO_SLIDE', slide: i }));
      strip.append(btn);
    }
  }

  // Stage
  /** The slide size that fits the stage, or null while the stage has no real size yet. */
  function fitSize() {
    const aspect = app.project().aspect || 16 / 9;
    // Measure without the previous render's size pushing on the layout.
    for (const el of [canvas, fallback]) {
      el.style.width = '0px';
      el.style.height = '0px';
    }
    const cs = getComputedStyle(stage);
    const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const hgt = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (w < MIN_STAGE_W || hgt < MIN_STAGE_H) return null;
    const width = Math.min(w, hgt * aspect);
    return { width: Math.floor(width), height: Math.floor(width / aspect) };
  }

  async function renderStage(slide, force = false) {
    if (slide === renderedSlide && !force) return;
    renderJob?.cancel();
    renderJob = null;
    const token = ++slideToken;
    const size = fitSize();
    if (!size) {
      // The ResizeObserver renders it once the stage has its size.
      renderedSlide = -1;
      pendingSlide = slide;
      return;
    }
    renderedSlide = slide;
    pendingSlide = -1;
    const { width, height } = size;
    for (const el of [canvas, fallback]) {
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    }
    const total = app.project().pageCount;
    canvas.setAttribute('aria-label', `Slide ${slide + 1} of ${total}`);
    fallback.src = app.thumbUrl(slide) || '';
    fallback.hidden = false;
    canvas.classList.remove('is-ready');
    try {
      const doc = await app.doc();
      if (token !== slideToken) return;
      // One offscreen canvas, so the visible slide never blanks while the next one draws.
      const off = document.createElement('canvas');
      const job = renderSlide(doc, slide + 1, off, width);
      renderJob = job;
      await job.promise;
      if (renderJob === job) renderJob = null;
      if (token !== slideToken) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext('2d').drawImage(off, 0, 0);
      canvas.classList.add('is-ready');
      fallback.hidden = true;
    } catch (err) {
      if (isCancelled(err) || token !== slideToken) return;
      console.warn('Slide render failed, showing the preview image', err);
    }
  }

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if ($('#screen-practice').hidden) return;
      const slide = pendingSlide >= 0 ? pendingSlide : renderedSlide;
      if (slide >= 0) renderStage(slide, true);
    }, 120);
  }).observe(stage);

  // Transcript
  function renderTranscript(state) {
    const { sentences, presenters, colorIndex } = app.info();
    const slide = state.slide;
    clear(body);
    sentenceEls = new Map();
    const total = app.project().pageCount;
    $('#transcriptTitle').textContent = `Slide ${slide + 1} of ${total}`;
    const onSlide = sentences.filter((s) => s.slide === slide);
    if (!onSlide.length) {
      body.append(h('p', { class: 'empty-note' }, 'This slide has no script. Use Edit script to add lines, or move on.'));
      return;
    }
    const focused = state.focus !== 'all';
    $('#transcript').classList.toggle('is-focused', focused);
    if (focused && !onSlide.some((s) => s.speaker === state.focus)) {
      body.append(h('p', { class: 'empty-note' }, `No lines for ${state.focus} on this slide`));
    }
    let para = null;
    let paraKey = '';
    for (const s of onSlide) {
      const key = `${s.para}`;
      if (key !== paraKey) {
        paraKey = key;
        const text = h('p', { class: 'para-text' });
        para = h(
          'div',
          { class: `para pc-${colorIndex[s.speaker] ?? 0}` },
          presenters.length > 1 ? h('p', { class: 'speaker' }, h('span', { class: 'dot' }), s.speaker) : null,
          text,
        );
        para.textEl = text;
        body.append(para);
      } else {
        para.textEl.append(' ');
      }
      const el = h('span', { class: 'sentence', role: 'button', tabindex: '0', dataset: { i: s.index } });
      const words = [];
      for (const token of wordTimings(s.text, 1).tokens) {
        if (token.isWord) {
          const w = h('span', { class: 'w' }, token.text);
          words.push(w);
          el.append(w);
        } else el.append(token.text);
      }
      el.setAttribute('aria-label', `${s.speaker}: ${s.text}`);
      para.textEl.append(el);
      sentenceEls.set(s.index, { el, words });
    }
  }

  body.addEventListener('click', (e) => {
    const el = e.target.closest('.sentence');
    if (!el) return;
    player.unlock();
    player.dispatch({ type: 'GOTO', index: Number(el.dataset.i) });
  });
  body.addEventListener('keydown', (e) => {
    const el = e.target.closest('.sentence');
    if (el && e.key === 'Enter') {
      e.preventDefault();
      player.unlock();
      player.dispatch({ type: 'GOTO', index: Number(el.dataset.i) });
    }
  });

  function applySentenceState(state, prev) {
    const { sentences } = app.info();
    for (const [i, { el, words }] of sentenceEls) {
      const s = sentences[i];
      const current = i === state.cursor;
      // A sentence you clicked outside "only my lines" plays at full strength.
      const skipped = !current && state.focus !== 'all' && s.speaker !== state.focus;
      el.classList.toggle('is-current', current);
      el.classList.toggle('is-skipped', skipped);
      el.classList.toggle('is-waiting', current && state.status === 'waiting');
      el.classList.toggle('is-reading', current && (state.status === 'playing' || state.status === 'gap'));
      const wasGap = el.classList.contains('is-gap');
      const gap = current && state.status === 'gap';
      if (!current || state.seq !== prev?.seq) {
        if (!(current && state.status === 'playing' && prev?.status === 'waiting' && prev.cursor === i)) {
          if (!gap) for (const w of words) w.classList.remove('is-spoken', 'is-now');
        }
      }
      if (gap && (!wasGap || state.seq !== prev?.seq)) {
        el.classList.remove('is-draining');
        el.classList.add('is-gap');
        el.style.setProperty('--gap-ms', `${state.gapMs}ms`);
        for (const w of words) {
          w.classList.add('is-spoken');
          w.classList.remove('is-now');
        }
        void el.offsetWidth;
        el.classList.add('is-draining');
      } else if (!gap && wasGap) {
        el.classList.remove('is-gap', 'is-draining');
      }
    }
  }

  function scrollToCurrent(state) {
    const entry = sentenceEls.get(state.cursor);
    if (!entry) return;
    const r = entry.el.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    if (r.top < b.top + 24 || r.bottom > b.bottom - 24) {
      body.scrollTo({ top: body.scrollTop + (r.top - b.top) - b.height / 3, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  function update(state, prev) {
    const { sentences } = app.info();
    const key = `${state.slide}|${state.focus}|${app.version()}`;
    if (key !== renderedKey) {
      renderedKey = key;
      renderTranscript(state);
      renderStage(state.slide);
      for (const t of $$('.thumb', strip)) {
        const i = Number(t.dataset.slide);
        t.setAttribute('aria-current', String(i === state.slide));
        const quiet = state.focus !== 'all' && !sentences.some((s) => s.slide === i && s.speaker === state.focus);
        t.classList.toggle('is-quiet', quiet);
      }
      const cur = strip.querySelector('[aria-current="true"]');
      if (cur) strip.scrollTo({ left: cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2, behavior: 'auto' });
    }
    applySentenceState(state, prev);
    if (!prev || prev.cursor !== state.cursor || prev.slide !== state.slide) scrollToCurrent(state);

    const active = ACTIVE.has(state.status);
    if (!prev || ACTIVE.has(prev.status) !== active) setPlayIcon(active);
    $('#loopButton').setAttribute('aria-pressed', String(state.loop));
    $('#shadowButton').setAttribute('aria-pressed', String(state.shadow));
    for (const b of speedButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === state.rate));
    for (const b of $$('.seg', focusGroup)) b.setAttribute('aria-pressed', String(b.dataset.focus === state.focus));
    const turn = state.status === 'gap' ? 'Your turn' : '';
    const turnLive = $('#turnLive');
    if (turnLive.textContent !== turn) turnLive.textContent = turn;
    if (lastStatus) renderStatus(lastStatus, state);
  }

  function onWord(index, wordIndex) {
    const entry = sentenceEls.get(index);
    if (!entry) return;
    entry.words.forEach((w, k) => {
      w.classList.toggle('is-spoken', k < wordIndex);
      w.classList.toggle('is-now', k === wordIndex);
    });
  }

  // Voice status
  let lastLive = '';
  function renderStatus(status, state = player.getState()) {
    lastStatus = status;
    const box = $('#voiceStatus');
    const text = $('#vsText');
    const fill = $('#vsFill');
    let label = '';
    let fraction = 0;
    let live = '';
    box.classList.remove('is-done', 'is-error');
    $('#vsRetry').hidden = true;
    if (status.phase === 'error') {
      label = 'Voices could not load. Check your connection and try again.';
      live = label;
      box.classList.add('is-error', 'is-done');
      $('#vsRetry').hidden = false;
    } else if (status.phase === 'loading' || status.phase === 'idle') {
      const pending = status.totalCount - status.readyCount;
      if (status.totalCount && pending === 0) {
        label = 'Voices ready';
        box.classList.add('is-done');
      } else if (status.total > 0) {
        label = `Downloading voices: ${Math.round(status.loaded / MB)} of ${Math.round(status.total / MB)} MB`;
        fraction = status.loaded / status.total;
        live = `Downloading voices, ${Math.floor(fraction * 4) * 25} percent`;
      } else {
        label = status.phase === 'idle' ? '' : 'Starting the voice engine';
        live = label;
      }
    } else if (status.phase === 'ready') {
      if (status.totalCount && status.readyCount < status.totalCount) {
        label = `Preparing voices: ${status.readyCount}/${status.totalCount} sentences`;
        fraction = status.readyCount / status.totalCount;
        live = 'Preparing voices';
      } else {
        label = 'Voices ready';
        live = label;
        box.classList.add('is-done');
      }
    }
    if (state?.status === 'waiting' && status.phase !== 'error' && status.readyCount < status.totalCount) {
      label = status.phase === 'ready' ? 'Preparing this sentence' : label;
    }
    text.textContent = label;
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
    if (live !== lastLive) {
      lastLive = live;
      $('#vsLive').textContent = live;
    }
    const slow = status.device === 'wasm' && status.totalCount > status.readyCount;
    $('#slowNote').hidden = !slow;
    $('#vsAdvice').hidden = status.phase !== 'error';
  }
  $('#vsRetry').addEventListener('click', () => app.retryVoices());

  // Keyboard
  function handleKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const map = {
      ' ': 'TOGGLE_PLAY',
      ArrowLeft: 'PREV',
      ArrowRight: 'NEXT',
      ArrowUp: 'PREV_SLIDE',
      ArrowDown: 'NEXT_SLIDE',
      r: 'REPLAY',
      l: 'TOGGLE_LOOP',
      s: 'TOGGLE_SHADOW',
    };
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.key === '?') {
      e.preventDefault();
      app.openHelp();
      return;
    }
    if (key === 'f') {
      e.preventDefault();
      const { presenters } = app.info();
      if (presenters.length < 2) return;
      const options = ['all', ...presenters];
      const i = options.indexOf(player.getState().focus);
      player.dispatch({ type: 'SET_FOCUS', focus: options[(i + 1) % options.length] });
      return;
    }
    if (key === '[' || key === ']') {
      e.preventDefault();
      player.dispatch({ type: 'RATE_STEP', step: key === ']' ? 1 : -1 });
      return;
    }
    const type = map[key];
    if (!type) return;
    e.preventDefault();
    if (e.repeat && type === 'TOGGLE_PLAY') return;
    player.unlock();
    player.dispatch({ type });
  }

  return {
    show() {
      renderedKey = '';
      renderedSlide = -1;
      pendingSlide = -1;
      renderFocus();
      renderStrip();
      setPlayIcon(false);
    },
    update,
    onWord,
    renderStatus,
    handleKey,
  };
}
