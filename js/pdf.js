// PDF loading, text extraction and rendering with pdf.js (loaded on first use).

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624/';
export const MAX_PAGES = 60;
export const MAX_BYTES = 50 * 1024 * 1024;
const THUMB_WIDTH = 480;

let libPromise = null;

function lib() {
  if (!libPromise) {
    libPromise = import(`${PDFJS}build/pdf.mjs`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}build/pdf.worker.mjs`;
      return pdfjs;
    }).catch((err) => {
      libPromise = null; // a failed download (offline) must not poison every later attempt
      throw err;
    });
  }
  return libPromise;
}

export class PdfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfError';
  }
}

/** Check size before reading. Throws PdfError with copy fit for the UI. */
export function checkFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) throw new PdfError('That file is not a PDF. Export your slides as PDF and try again.');
  if (file.size > MAX_BYTES) throw new PdfError('That PDF is larger than 50 MB. Export it again with compressed images, or split the deck.');
}

/** Open a PDF from bytes. The caller keeps `bytes`; pdf.js gets a copy. */
export async function openPdf(bytes) {
  const pdfjs = await lib();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes.slice(0)),
      isEvalSupported: false,
      wasmUrl: `${PDFJS}wasm/`,
      cMapUrl: `${PDFJS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS}standard_fonts/`,
      iccUrl: `${PDFJS}iccs/`,
    }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new PdfError('This PDF is password protected. Export it again without a password.');
    throw new PdfError('This PDF could not be opened. It may be damaged. Try exporting it again.');
  }
  if (doc.numPages > MAX_PAGES) {
    doc.destroy();
    throw new PdfError(`This PDF has ${doc.numPages} pages. The limit is ${MAX_PAGES}.`);
  }
  return doc;
}

function itemSize(item) {
  const [a, b, c, d] = item.transform;
  return Math.hypot(c, d) || Math.hypot(a, b) || item.height || 0;
}

function groupLines(items) {
  const lines = [];
  let line = null;
  let prev = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const size = itemSize(item);
    const x = item.transform[4];
    const y = item.transform[5];
    if (item.str.trim() === '') {
      if (line && item.str) line.text += ' ';
      if (item.hasEOL) prev = null;
      continue;
    }
    const scale = Math.max(size, prev?.size || 0);
    const breaks =
      !prev ||
      Math.abs(y - prev.y) > scale * 0.5 ||
      x - prev.end > scale * 1.5 ||
      x < prev.x - scale;
    if (breaks) {
      line = { text: item.str, size };
      lines.push(line);
    } else {
      const gap = x - prev.end;
      const needsSpace = gap > scale * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.str);
      line.text += (needsSpace ? ' ' : '') + item.str;
      if (/[\p{L}\p{N}]/u.test(item.str)) line.size = Math.max(line.size, size);
    }
    prev = { x, y, size, end: x + (item.width || 0) };
    if (item.hasEOL) prev = null;
  }
  return lines
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').replace(/^[•●▪■◦‣·*\-\u2013\u2014]\s*/, '').trim(), size: l.size }))
    .filter((l) => l.text);
}

function structure(lines) {
  if (!lines.length) return { title: '', lines: [] };
  const max = Math.max(...lines.map((l) => l.size));
  const titleIndex = lines.findIndex((l) => l.size >= max * 0.92);
  const title = lines[titleIndex].text;
  const rest = [];
  lines.forEach((l, i) => {
    if (i === titleIndex) return;
    const last = rest[rest.length - 1];
    const similar = last && l.size / last.size > 0.85 && l.size / last.size < 1.18;
    // A big number over its label ("40" then "bikes") reads as one phrase.
    const numberLabel = last && /^[\d.,%$+]+$/.test(last.text) && /^[a-z]/.test(l.text);
    if (last && (numberLabel || (similar && /^[a-z]/.test(l.text)))) last.text = `${last.text} ${l.text}`;
    else rest.push({ ...l });
  });
  return { title, lines: rest.map((l) => l.text) };
}

/** Extract { title, lines } for every page. */
export async function extractPages(doc, onProgress) {
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(structure(groupLines(content.items)));
    page.cleanup();
    onProgress?.(n, doc.numPages);
  }
  return pages;
}

async function renderPage(doc, n, canvas, width, control = {}) {
  const page = await doc.getPage(n);
  if (control.cancelled) throw cancelled();
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 'print' intent renders without requestAnimationFrame, so hidden tabs do not stall.
  const task = page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' });
  control.task = task;
  try {
    await task.promise;
  } finally {
    control.task = null;
    page.cleanup();
  }
  return { width: base.width, height: base.height };
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Thumbnail failed'))), 'image/jpeg', 0.82);
  });
}

/** Render a small JPEG for every page. Returns { thumbs: Blob[], aspect }. */
export async function renderThumbs(doc, onProgress) {
  const thumbs = [];
  let aspect = 16 / 9;
  for (let n = 1; n <= doc.numPages; n += 1) {
    const canvas = document.createElement('canvas');
    const size = await renderPage(doc, n, canvas, THUMB_WIDTH);
    if (n === 1) aspect = size.width / size.height;
    thumbs.push(await toBlob(canvas));
    onProgress?.(n, doc.numPages);
  }
  return { thumbs, aspect };
}

function cancelled() {
  const err = new Error('Rendering cancelled');
  err.name = 'RenderingCancelledException';
  return err;
}

/** True for the error a cancelled render rejects with. */
export function isCancelled(err) {
  return err?.name === 'RenderingCancelledException';
}

/**
 * Render page n at a CSS width into `canvas`, sharp on high-density screens.
 * Returns { promise, cancel }: cancel() stops the pdf.js work in progress.
 */
export function renderSlide(doc, n, canvas, cssWidth) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const control = { cancelled: false, task: null };
  const promise = renderPage(doc, n, canvas, Math.max(320, Math.round(cssWidth * dpr)), control);
  return {
    promise,
    cancel() {
      control.cancelled = true;
      control.task?.cancel();
    },
  };
}
