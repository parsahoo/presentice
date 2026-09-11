// Player reducer. Pure: (state, action, ctx) -> state. No timers, no audio.
// ctx = { sentences: [{ slide, speaker }], slideCount }

export const RATES = [0.8, 0.9, 1, 1.1];
export const SHADOW_FACTOR = 1.2;

export function initialState(overrides = {}) {
  return {
    cursor: 0,
    slide: 0,
    focus: 'all',
    loop: false,
    shadow: false,
    rate: 1,
    status: 'idle',
    seq: 0,
    gapMs: 0,
    ...overrides,
  };
}

export function isPlayable(state, ctx, i) {
  const s = ctx.sentences[i];
  if (!s) return false;
  return state.focus === 'all' || s.speaker === state.focus;
}

export function nextPlayable(state, ctx, from) {
  for (let i = from + 1; i < ctx.sentences.length; i += 1) if (isPlayable(state, ctx, i)) return i;
  return -1;
}

export function prevPlayable(state, ctx, from) {
  for (let i = from - 1; i >= 0; i -= 1) if (isPlayable(state, ctx, i)) return i;
  return -1;
}

/** First playable sentence at or after the start of `slide`, or -1. */
export function firstPlayableFrom(state, ctx, slide) {
  const i = ctx.sentences.findIndex((s, idx) => s.slide >= slide && isPlayable(state, ctx, idx));
  return i;
}

function slideOf(ctx, i, fallback) {
  return ctx.sentences[i]?.slide ?? fallback;
}

const ACTIVE = new Set(['waiting', 'playing', 'gap']);

function transition(state, patch) {
  return { ...state, ...patch, seq: state.seq + 1, gapMs: patch.gapMs ?? 0 };
}

/** Move to sentence i, keeping play/pause. */
function moveTo(state, ctx, i) {
  // Nothing further in that direction: keep playing what is playing.
  if (i < 0) return state;
  const active = ACTIVE.has(state.status);
  return transition(state, { cursor: i, slide: slideOf(ctx, i, state.slide), status: active ? 'waiting' : 'paused' });
}

function ensurePlayableCursor(state, ctx) {
  if (isPlayable(state, ctx, state.cursor)) return state;
  const after = nextPlayable(state, ctx, state.cursor);
  const target = after >= 0 ? after : prevPlayable(state, ctx, state.cursor);
  if (target < 0) return state;
  return { ...state, cursor: target };
}

export function reduce(state, action, ctx) {
  const total = ctx.sentences.length;
  switch (action.type) {
    case 'PLAY': {
      if (!total) return state;
      const fixed = ensurePlayableCursor(state, ctx);
      return transition(fixed, { status: 'waiting', slide: slideOf(ctx, fixed.cursor, fixed.slide) });
    }
    case 'PAUSE':
      if (!ACTIVE.has(state.status)) return state;
      return transition(state, { status: 'paused' });
    case 'TOGGLE_PLAY':
      return reduce(state, { type: ACTIVE.has(state.status) ? 'PAUSE' : 'PLAY' }, ctx);
    case 'AUDIO_STARTED':
      if (action.seq !== state.seq || state.status !== 'waiting') return state;
      return { ...state, status: 'playing', slide: slideOf(ctx, state.cursor, state.slide) };
    case 'AUDIO_ENDED': {
      if (action.seq !== state.seq || state.status !== 'playing') return state;
      if (state.shadow) {
        const ms = Math.round(((action.duration || 0) / state.rate) * SHADOW_FACTOR * 1000);
        return transition(state, { status: 'gap', gapMs: ms });
      }
      return advanceAfterSentence(state, ctx);
    }
    case 'GAP_DONE':
      if (action.seq !== state.seq || state.status !== 'gap') return state;
      return advanceAfterSentence(state, ctx);
    case 'NEXT':
      return moveTo(state, ctx, nextPlayable(state, ctx, state.cursor));
    case 'PREV':
      return moveTo(state, ctx, prevPlayable(state, ctx, state.cursor));
    case 'GOTO': {
      const i = action.index;
      if (i < 0 || i >= total) return state;
      // Clicked outside "only my lines": play just that sentence and keep the filter,
      // so playback then goes on with the next sentence of mine.
      return transition(state, { cursor: i, slide: slideOf(ctx, i, state.slide), status: 'waiting' });
    }
    case 'GOTO_SLIDE':
    case 'NEXT_SLIDE':
    case 'PREV_SLIDE': {
      const slideCount = ctx.slideCount || 1;
      let target = state.slide;
      if (action.type === 'NEXT_SLIDE') target = state.slide + 1;
      if (action.type === 'PREV_SLIDE') target = state.slide - 1;
      if (action.type === 'GOTO_SLIDE') target = action.slide;
      target = Math.max(0, Math.min(slideCount - 1, target));
      const i = firstPlayableFrom(state, ctx, target);
      const active = ACTIVE.has(state.status);
      if (i < 0) return transition(state, { slide: target, status: active ? 'paused' : state.status });
      const onTarget = ctx.sentences[i].slide === target;
      // Playing: follow the audio. Paused: show the chosen slide even if it has no lines.
      return transition(state, {
        cursor: i,
        slide: active || onTarget ? slideOf(ctx, i, target) : target,
        status: active ? 'waiting' : state.status === 'idle' ? 'idle' : 'paused',
      });
    }
    case 'REPLAY':
      if (!total) return state;
      return transition(ensurePlayableCursor(state, ctx), { status: 'waiting' });
    case 'SET_FOCUS': {
      const next = ensurePlayableCursor({ ...state, focus: action.focus }, ctx);
      const active = ACTIVE.has(state.status);
      return transition(next, { slide: active ? slideOf(ctx, next.cursor, state.slide) : state.slide, status: active ? 'waiting' : state.status });
    }
    case 'TOGGLE_LOOP':
      return { ...state, loop: !state.loop };
    case 'TOGGLE_SHADOW':
      return { ...state, shadow: !state.shadow };
    case 'SET_RATE':
      return RATES.includes(action.rate) ? { ...state, rate: action.rate } : state;
    case 'RATE_STEP': {
      const idx = RATES.indexOf(state.rate);
      const next = RATES[Math.max(0, Math.min(RATES.length - 1, (idx < 0 ? 2 : idx) + action.step))];
      return { ...state, rate: next };
    }
    default:
      return state;
  }
}

function advanceAfterSentence(state, ctx) {
  if (state.loop) return transition(state, { status: 'waiting' });
  const i = nextPlayable(state, ctx, state.cursor);
  if (i < 0) return transition(state, { status: 'paused' });
  return transition(state, { cursor: i, slide: slideOf(ctx, i, state.slide), status: 'waiting' });
}

/**
 * Sentences whose audio should be ready in memory, in priority order: the current
 * one, the next few playable ones, the previous one, then the rest of the current
 * and the next slide. Everything else is read back from storage when needed.
 */
export function audioWindow(state, ctx, ahead = 4) {
  const n = ctx.sentences.length;
  if (!n) return [];
  const out = new Set();
  const add = (i) => {
    if (i >= 0 && i < n) out.add(i);
  };
  add(state.cursor);
  let i = state.cursor;
  for (let k = 0; k < ahead; k += 1) {
    i = nextPlayable(state, ctx, i);
    if (i < 0) break;
    add(i);
  }
  add(prevPlayable(state, ctx, state.cursor));
  const slide = ctx.sentences[state.cursor]?.slide ?? state.slide;
  for (let j = 0; j < n; j += 1) {
    const s = ctx.sentences[j].slide;
    if ((s === slide || s === slide + 1) && isPlayable(state, ctx, j)) add(j);
  }
  return [...out];
}

/** Generation order: current, next playable, rest of slide, forward, wrap, then others. */
export function generationOrder(state, ctx) {
  const n = ctx.sentences.length;
  if (!n) return [];
  const seen = new Set();
  const out = [];
  const push = (i) => {
    if (i >= 0 && i < n && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  };
  push(state.cursor);
  let i = state.cursor;
  for (let k = 0; k < 4; k += 1) {
    i = nextPlayable(state, ctx, i);
    if (i < 0) break;
    push(i);
  }
  const slide = ctx.sentences[state.cursor]?.slide;
  for (let j = 0; j < n; j += 1) if (ctx.sentences[j].slide === slide && isPlayable(state, ctx, j)) push(j);
  for (let j = state.cursor; j < n; j += 1) if (isPlayable(state, ctx, j)) push(j);
  for (let j = 0; j < state.cursor; j += 1) if (isPlayable(state, ctx, j)) push(j);
  for (let j = state.cursor; j < n; j += 1) push(j);
  for (let j = 0; j < n; j += 1) push(j);
  return out;
}
