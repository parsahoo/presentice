// Player effects: one audio element, timers and word timing around the pure reducer.
import { reduce, initialState, generationOrder, audioWindow } from './player-state.js';
import { wordTimings, wordAt } from './sentences.js';
import { silentWav } from './wav.js';
import * as tts from './tts.js';

export function createPlayer({ voiceFor, onChange, onWord, onError, onSave }) {
  const audio = new Audio();
  audio.preload = 'auto';
  let state = initialState();
  let ctx = { sentences: [], slideCount: 1 };
  let gapTimer = 0;
  let saveTimer = 0;
  let prioritizeTimer = 0;
  let rafId = 0;
  let request = null; // AbortController for the clip being fetched
  let current = null; // { seq, index, clip, timing }
  let lastWord = -2;
  let unlocked = false;
  let silentUrl = null;

  function notify(prev) {
    onChange?.(state, prev);
  }

  function stopTicker() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /** Drop interest in a clip we no longer need, so its waiter does not linger. */
  function cancelRequest() {
    request?.abort();
    request = null;
  }

  function dispatch(action) {
    const prev = state;
    state = reduce(state, action, ctx);
    if (state === prev) return;
    if (state.seq !== prev.seq) {
      clearTimeout(gapTimer);
      runEffects();
    }
    if (state.status !== 'playing') stopTicker();
    if (state.rate !== prev.rate) audio.playbackRate = state.rate;
    if (state.cursor !== prev.cursor || state.focus !== prev.focus) schedulePrioritize();
    notify(prev);
    scheduleSave();
  }

  function runEffects() {
    const seq = state.seq;
    cancelRequest();
    if (state.status === 'waiting') {
      playCurrent(seq);
    } else if (state.status === 'gap') {
      audio.pause();
      gapTimer = setTimeout(() => dispatch({ type: 'GAP_DONE', seq }), state.gapMs);
    } else {
      audio.pause();
    }
  }

  async function playCurrent(seq) {
    audio.pause();
    const sentence = ctx.sentences[state.cursor];
    if (!sentence) return;
    const controller = new AbortController();
    request = controller;
    let clip;
    try {
      clip = await tts.get(sentence.text, voiceFor(sentence.speaker), { signal: controller.signal });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (seq === state.seq) {
        dispatch({ type: 'PAUSE' });
        onError?.(err);
      }
      return;
    } finally {
      if (request === controller) request = null;
    }
    if (seq !== state.seq) return;
    current = { seq, index: state.cursor, clip, timing: wordTimings(sentence.text, clip.duration) };
    lastWord = -2;
    audio.src = clip.url;
    audio.playbackRate = state.rate;
    try {
      await audio.play();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (seq === state.seq) {
        dispatch({ type: 'PAUSE' });
        onError?.(err);
      }
      return;
    }
    if (seq !== state.seq) return;
    dispatch({ type: 'AUDIO_STARTED', seq });
    stopTicker();
    tickWords();
  }

  function reportWord() {
    if (!current || current.seq !== state.seq) return;
    const idx = state.status === 'playing' ? wordAt(current.timing.words, audio.currentTime) : -1;
    if (idx !== lastWord) {
      lastWord = idx;
      onWord?.(current.index, idx);
    }
  }

  function tickWords() {
    reportWord();
    rafId = state.status === 'playing' ? requestAnimationFrame(tickWords) : 0;
  }

  audio.addEventListener('timeupdate', reportWord);
  audio.addEventListener('ended', () => {
    if (!current || current.seq !== state.seq) return;
    onWord?.(current.index, current.timing.words.length);
    dispatch({ type: 'AUDIO_ENDED', seq: state.seq, duration: current.clip.duration });
  });

  function schedulePrioritize() {
    clearTimeout(prioritizeTimer);
    prioritizeTimer = setTimeout(prioritize, 30);
  }

  function prioritize() {
    const item = (i) => {
      const s = ctx.sentences[i];
      return { text: s.text, voice: voiceFor(s.speaker) };
    };
    // Memory first: the window keeps replay instant and next or previous near-instant.
    tts.setWindow(audioWindow(state, ctx).map(item));
    tts.prioritize(generationOrder(state, ctx).map(item));
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { cursor, slide, focus, loop, shadow, rate } = state;
      onSave?.({ cursor, slide, focus, loop, shadow, rate });
    }, 300);
  }

  /** Call from click and key handlers: lets later play() calls start audio. */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (!silentUrl) silentUrl = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
    audio.src = silentUrl;
    audio.play().catch(() => {});
  }

  /** Load a new sentence list. Opens paused at the saved position. */
  function setContext(nextCtx, position = {}) {
    ctx = nextCtx;
    const n = ctx.sentences.length;
    const valid = (p) => p === 'all' || ctx.sentences.some((s) => s.speaker === p);
    let cursor = Number.isInteger(position.cursor) ? position.cursor : 0;
    const slide = Number.isInteger(position.slide) ? Math.min(position.slide, ctx.slideCount - 1) : 0;
    if (cursor >= n || (n && ctx.sentences[cursor].slide !== slide)) {
      const first = ctx.sentences.findIndex((s) => s.slide >= slide);
      cursor = first >= 0 ? first : Math.max(0, n - 1);
    }
    clearTimeout(gapTimer);
    cancelRequest();
    stopTicker();
    audio.pause();
    current = null;
    state = initialState({
      seq: state.seq + 1,
      cursor,
      slide: n ? Math.max(0, slide) : 0,
      focus: valid(position.focus) ? position.focus : 'all',
      loop: Boolean(position.loop),
      shadow: Boolean(position.shadow),
      rate: [0.8, 0.9, 1, 1.1].includes(position.rate) ? position.rate : 1,
      status: 'paused',
    });
    notify(null);
    prioritize();
  }

  function stop() {
    dispatch({ type: 'PAUSE' });
    cancelRequest();
    audio.pause();
  }

  return {
    dispatch,
    unlock,
    setContext,
    stop,
    reprioritize: prioritize,
    getState: () => state,
  };
}
