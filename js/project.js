// The current presentation: import, derive, save and load.
import * as store from './store.js';
import { checkFile, openPdf, extractPages, renderThumbs } from './pdf.js';
import { parseScript, flattenSentences, draftScript } from './script-parser.js';
import { defaultVoices } from './voices.js';
import { resolveRoster, applyRoster, migrateNames } from './roster.js';

export const SAMPLE = {
  pdf: new URL('../sample/brightside.pdf', import.meta.url).href,
  script: new URL('../sample/brightside-script.txt', import.meta.url).href,
  manifest: new URL('../sample/manifest.json', import.meta.url).href,
  name: 'Brightside (sample)',
};

const FIELDS = ['meta', 'pdf', 'pages', 'thumbs', 'script', 'names', 'voices', 'position'];

async function build(bytes, name, onProgress) {
  const doc = await openPdf(bytes);
  const total = doc.numPages;
  let pages;
  let thumbs;
  let aspect;
  try {
    pages = await extractPages(doc, (n) => onProgress?.('text', n, total));
    ({ thumbs, aspect } = await renderThumbs(doc, (n) => onProgress?.('thumbs', n, total)));
  } catch (err) {
    // Free the pdf.js worker and the parsed document before giving up.
    doc.destroy().catch(() => {});
    throw err;
  }
  return {
    doc,
    project: {
      name,
      isSample: false,
      pageCount: total,
      aspect,
      pages,
      thumbs,
      script: draftScript(pages),
      noText: !pages.some((p) => p.title || p.lines.length),
      names: [],
      count: null,
      voices: {},
      position: {},
      stage: 'script',
    },
  };
}

export { checkFile };

/** Read a PDF the user picked. Throws PdfError with copy for the UI. */
export async function importFile(file, onProgress) {
  checkFile(file);
  const bytes = await file.arrayBuffer();
  const name = file.name.replace(/\.pdf$/i, '') || 'Presentation';
  const { project, doc } = await build(bytes, name, onProgress);
  return { project, bytes, doc };
}

export async function importSample(onProgress) {
  const [pdfRes, scriptRes] = await Promise.all([fetch(SAMPLE.pdf), fetch(SAMPLE.script)]);
  if (!pdfRes.ok || !scriptRes.ok) throw new Error('The sample deck could not be loaded. Check your connection and try again.');
  const bytes = await pdfRes.arrayBuffer();
  const { project, doc } = await build(bytes, SAMPLE.name, onProgress);
  return {
    bytes,
    doc,
    project: { ...project, isSample: true, script: await scriptRes.text(), stage: 'practice' },
  };
}

export function metaOf(project) {
  const { name, isSample, pageCount, aspect, noText, stage, count = null } = project;
  return { name, isSample, pageCount, aspect, noText, stage, count };
}

/** Replace whatever is stored with this project, in one transaction. */
export function saveAll(project, bytes) {
  return store.replaceProject({
    'project:meta': metaOf(project),
    'project:pdf': bytes,
    'project:pages': project.pages,
    'project:thumbs': project.thumbs,
    'project:script': project.script,
    'project:names': project.names,
    'project:voices': project.voices,
    'project:position': project.position,
  });
}

/** Save one field. Rejects when the device cannot store it; the caller tells the user. */
export function saveField(field, value) {
  return store.set(`project:${field}`, value);
}

export async function load() {
  const values = await Promise.all(FIELDS.map((f) => store.get(`project:${f}`)));
  const [meta, pdf, pages, thumbs, script, names, voices, position] = values;
  if (!meta || !pdf || !pages) return null;
  const savedNames = migrateNames(meta, script ?? '', names || []);
  if (savedNames !== (names || [])) saveField('names', savedNames).catch(() => {});
  return {
    bytes: pdf,
    project: {
      ...meta,
      pages,
      thumbs: thumbs || [],
      script: script ?? '',
      names: savedNames,
      voices: voices || {},
      position: position || {},
    },
  };
}

/** Everything the screens need from the script text. */
export function derive(project, script = project.script) {
  const names = project.names || [];
  const raw = parseScript(script, { slideCount: project.pageCount, names });
  const roster = resolveRoster({ speakers: raw.speakers, names, count: project.count ?? null });
  const parsed = applyRoster(raw, roster);
  const sentences = flattenSentences(parsed);
  const lineCounts = new Map();
  for (const s of sentences) lineCounts.set(s.speaker, (lineCounts.get(s.speaker) || 0) + 1);
  // Rows first, so each row keeps its color and gets its own default voice.
  const everyone = [...new Set([...roster.rows, ...parsed.presenters])];
  const presenters = everyone.filter((p) => lineCounts.has(p));
  if (!presenters.length) presenters.push(roster.rows[0]);
  const voices = defaultVoices(everyone, project.voices);
  const colorIndex = Object.fromEntries(everyone.map((p, i) => [p, i % 6]));
  return { parsed, sentences, presenters, voices, colorIndex, roster, lineCounts };
}
