// Voice quality: which build of the model runs, and on what. Pure.
//
// Measured on an 8 GB laptop with one 13 second line (am_michael):
//   q8 on wasm    load 6.9 s, generated in 33 s, about 121 MB in the tab, no GPU memory.
//   fp32 on webgpu load 21 s, generated in 8 s, about 2 GB in the tab plus 1.2 GB on the GPU.
// fp16 on webgpu and q8 on webgpu are both broken on that machine (quiet output,
// and 157 s for the same line), so neither is offered.

export const DEFAULT_QUALITY = 'standard';

export const QUALITIES = [
  {
    id: 'standard',
    label: 'Standard',
    dtype: 'q8',
    device: 'wasm',
    note: 'Compressed model, lightest. Makes voices about 2.5 times slower than real time.',
  },
  {
    id: 'high',
    label: 'High',
    dtype: 'fp32',
    device: 'webgpu',
    note: 'Full model, uses the graphics card. Needs about 2 GB of free memory.',
  },
];

export const QUALITY_IDS = QUALITIES.map((q) => q.id);

/** The one quality that needs WebGPU, disabled when the browser has none. */
export const NEEDS_WEBGPU = 'high';
export const NO_WEBGPU_NOTE = 'High needs WebGPU, which this browser does not have.';

/** A stored or user-supplied value, reduced to a quality id we know. */
export function normalizeQuality(value) {
  return QUALITY_IDS.includes(value) ? value : DEFAULT_QUALITY;
}

/** The full entry for a quality id; unknown ids fall back to the default. */
export function qualityOf(value) {
  const id = normalizeQuality(value);
  return QUALITIES.find((q) => q.id === id);
}

/** What the worker needs to load: { dtype, device }. */
export function engineFor(value) {
  const { dtype, device } = qualityOf(value);
  return { dtype, device };
}

/** The quality that made a clip with this engine, or null for a combination we never use. */
export function qualityForEngine(dtype, device) {
  return QUALITIES.find((q) => q.dtype === dtype && q.device === device)?.id ?? null;
}
