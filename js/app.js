// App controller: screens, project lifecycle and wiring.
import * as store from './store.js';
import * as tts from './tts.js';
import * as projects from './project.js';
import { openPdf, PdfError } from './pdf.js';
import { createPlayer } from './player.js';
import { $, $$, toast } from './ui/dom.js';
import { initLanding, createDropzone, progressLabel } from './ui/landing.js';
import { initScript } from './ui/script.js';
import { initPractice } from './ui/practice.js';
import { initPresenters } from './ui/presenters.js';
import { initTour } from './ui/tour.js';
import { stopVoice } from './ui/voice-preview.js';

const SCREENS = ['landing', 'script', 'practice'];
const TITLES = { landing: 'Presentice', script: 'Your script: Presentice', practice: 'Practice: Presentice' };

let project = null;
let bytes = null;
let docPromise = null;
let docTimer = 0;
const DOC_IDLE_MS = 15000;
let derived = null;
let version = 0;
let thumbUrls = [];
let screen = null;
let busy = false;
let saving = Promise.resolve(); // the full save of the current project

let fieldSaveWarned = false;

/** Save one field, but only after the project itself saved, and only for that project. */
function saveField(field, value) {
  const target = project;
  saving.then(
    () => {
      if (project !== target) return;
      projects.saveField(field, value).catch((err) => {
        console.warn('Could not save', field, err);
        // Once per session: edits keep working, the user just needs to know they are not kept.
        if (fieldSaveWarned) return;
        fieldSaveWarned = true;
        toast(
          store.isQuotaError(err)
            ? 'This device is out of space, so your changes are not saved. This session still works.'
            : 'Your changes could not be saved on this device. This session still works.',
        );
      });
    },
    () => {},
  );
}

function storageErrorText(err) {
  return store.isQuotaError(err)
    ? 'This presentation is too large to save on this device. This session still works.'
    : 'Could not save on this device. This session still works.';
}

/** Save a new project in the background: opening it never waits for, or fails on, storage. */
function persist(next, nextBytes) {
  saving = projects.saveAll(next, nextBytes);
  saving.catch((err) => {
    console.warn('Could not save the presentation', err);
    toast(storageErrorText(err));
  });
}

/** The open pdf.js document, opened again on demand after it was released. */
function openDoc() {
  clearTimeout(docTimer);
  if (!docPromise) {
    const opening = openPdf(bytes);
    docPromise = opening;
    // A failed open must not stay failed: the next render tries again.
    opening.catch(() => {
      if (docPromise === opening) docPromise = null;
    });
  }
  return docPromise;
}

/**
 * pdf.js keeps the parsed document and its own worker in memory. Close them once
 * the slide has not changed for a while; the next slide opens the document again.
 */
function releaseDocSoon() {
  clearTimeout(docTimer);
  docTimer = setTimeout(() => {
    const current = docPromise;
    docPromise = null;
    current?.then((d) => d.destroy()).catch(() => {});
  }, DOC_IDLE_MS);
}

// Shared API for the screen modules
const app = {
  project: () => project,
  info: () => derived,
  version: () => version,
  /** Derive a script text. `over`: project fields to try (names, count) without saving them. */
  derive: (text, over = {}) => projects.derive({ ...project, ...over }, text),
  thumbUrl: (i) => thumbUrls[i],
  doc: openDoc,
  docDone: releaseDocSoon,
  toast,
  setScript(text) {
    if (!project || project.script === text) return;
    project.script = text;
    saveField('script', text);
  },
  setNames(names) {
    project.names = names;
    saveField('names', names);
  },
  /** The presenter count picked on the Script step, or null to follow the script. */
  setCount(count) {
    project.count = count;
    saveField('meta', projects.metaOf(project));
  },
  /** Every presenter's voice at once, from the Script step. Playback picks them up on Start practicing. */
  setVoices(voices) {
    project.voices = voices;
    saveField('voices', voices);
  },
  /** The Voice quality, from the Script step or the Presenters panel. */
  quality: () => tts.getQuality(),
  setQuality(id) {
    if (!project || id === tts.getQuality()) return;
    project.quality = id;
    saveField('meta', projects.metaOf(project));
    // Clips made under the other quality stay saved; only what is needed now is made again.
    tts.setQuality(id);
    const state = player.getState();
    if (state.status === 'waiting' || state.status === 'playing') player.dispatch({ type: 'REPLAY' });
  },
  setVoice(presenter, voice) {
    project.voices = { ...derived.voices, [presenter]: voice };
    saveField('voices', project.voices);
    derived = { ...derived, voices: projects.derive(project).voices };
    player.reprioritize();
    // A sentence of this presenter in progress: ask again with the new voice.
    const state = player.getState();
    const now = derived.sentences[state.cursor];
    if (now?.speaker === presenter && (state.status === 'waiting' || state.status === 'playing')) {
      player.dispatch({ type: 'REPLAY' });
    }
  },
  startPracticing() {
    show('practice');
  },
  openHelp() {
    $('#helpDialog').showModal();
  },
  retryVoices() {
    tts.retry();
  },
};

const player = createPlayer({
  voiceFor: (speaker) => derived?.voices[speaker],
  onChange: (state, prev) => {
    if (screen === 'practice') practice.update(state, prev);
  },
  onWord: (index, word) => practice.onWord(index, word),
  onError: (err) => {
    console.warn(err);
    toast(tts.getStatus().phase === 'error' ? 'Voices could not load. Use Try again below the transcript.' : 'That sentence could not play. Try again.');
  },
  onSave: (position) => {
    if (!project) return;
    project.position = position;
    saveField('position', position);
  },
});

const landing = initLanding({ onFile: openFile, onSample: openSample });
const script = initScript({ app });
const practice = initPractice({ app, player });
const presenters = initPresenters({ app });
const tour = initTour({
  steps: () => [
    { target: $('#stage'), title: 'Your slide', text: 'The slide you are on. Press the Up and Down arrow keys, or pick one in the strip below, to move between slides.' },
    { target: $('#transcript'), title: 'Your script', text: 'The sentence being spoken is highlighted word by word. Click any sentence to play from it.' },
    { target: $('#navGroup'), title: 'Controls', text: 'Space plays and pauses. The Left and Right arrow keys step one sentence. R replays the sentence from its start.' },
    { target: $('#focusWrap'), title: 'Only my lines', text: 'Pick your name to hear only your sentences. Everything else stays visible, dimmed.' },
    { target: $('#modesGroup'), title: 'Shadow and loop', text: 'Shadow leaves a pause after each sentence so you can say it back. Loop repeats one sentence until you turn it off.' },
  ],
  onClose: () => store.set('app:tourSeen', true).catch(() => {}),
});

tts.onStatus((status) => {
  if (screen === 'practice') practice.renderStatus(status);
});
tts.onStorageError((err) => {
  toast(store.isQuotaError(err) ? 'This device is out of space for voices. They still play, and will be made again next time.' : 'Voices could not be saved on this device. They still play.');
});

function setThumbs(thumbs) {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = (thumbs || []).map((b) => URL.createObjectURL(b));
}

function refreshDerived() {
  derived = projects.derive(project);
  version += 1;
}

function show(name) {
  if (!SCREENS.includes(name)) return;
  // The app booted, so the static fallback message has done its job.
  $('#bootFallback')?.remove();
  if (screen === 'script' && name !== 'script') script.flush();
  if (name !== screen) {
    stopVoice();
    // The tour points at Practice controls: it ends when Practice is left.
    tour.stop();
  }
  if (name !== 'practice') player.stop();
  screen = name;
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== name;
  document.title = TITLES[name];
  for (const el of $$('[data-deck-name]')) el.textContent = project?.name || '';
  if (project && name !== 'landing' && project.stage !== name) {
    project.stage = name;
    saveField('meta', projects.metaOf(project));
  }
  if (name === 'script') {
    script.show();
    $('#scriptTitle').focus({ preventScroll: true });
  }
  if (name === 'practice') enterPractice();
  if (name === 'landing') $('#landingTitle').focus({ preventScroll: true });
}

async function enterPractice() {
  refreshDerived();
  practice.show();
  // One presenter: there is no "only my lines" to keep.
  const position = derived.presenters.length < 2 ? { ...project.position, focus: 'all' } : project.position;
  player.setContext({ sentences: derived.sentences, slideCount: project.pageCount }, position);
  practice.renderStatus(tts.getStatus());
  $('#practiceTitle').focus({ preventScroll: true });
  const seen = await store.get('app:tourSeen').catch(() => true);
  if (!seen && screen === 'practice') setTimeout(() => tour.start(), 250);
}

/**
 * Make `next` the current project. `fresh`: a new import, so no saved clips belong to it.
 * On a reload (fresh = false) the clips in IndexedDB are this project's and are reused.
 */
async function adopt(next, nextBytes, doc, { fresh = true } = {}) {
  player.stop();
  project = next;
  bytes = nextBytes;
  const oldDoc = docPromise;
  docPromise = doc ? Promise.resolve(doc) : null;
  // Each pdf.js document owns a worker: free the previous one.
  oldDoc?.then((d) => d.destroy()).catch(() => {});
  // The document that made the thumbnails is closed too if no slide needs it soon.
  if (docPromise) releaseDocSoon();
  else clearTimeout(docTimer);
  setThumbs(project.thumbs);
  // The quality this presentation was saved with, before any key is hashed for it.
  tts.setQuality(project.quality);
  tts.reset({ keepStored: !fresh });
  await tts.useManifest(project.isSample ? projects.SAMPLE.manifest : null).catch((err) => console.warn(err));
  refreshDerived();
}

function errorText(err) {
  if (err instanceof PdfError) return err.message;
  console.error(err);
  return err?.message?.startsWith('The sample') ? err.message : 'Something went wrong while reading that file. Try exporting the PDF again.';
}

async function openFile(file, zone, errorEl) {
  if (busy) return;
  errorEl.hidden = true;
  try {
    projects.checkFile(file);
  } catch (err) {
    errorEl.textContent = errorText(err);
    errorEl.hidden = false;
    return;
  }
  busy = true;
  zone.setBusy('Opening your slides', 0.02);
  try {
    const { project: next, bytes: nextBytes, doc } = await projects.importFile(file, (phase, n, total) => {
      const p = progressLabel(phase, n, total);
      zone.setBusy(p.text, p.fraction);
    });
    persist(next, nextBytes);
    await adopt(next, nextBytes, doc);
    // A new deck has no audio yet: on a first visit, the model downloads while the script is edited.
    tts.prepare();
    $('#newDialog').close();
    show('script');
  } catch (err) {
    errorEl.textContent = errorText(err);
    errorEl.hidden = false;
  } finally {
    busy = false;
    zone.reset();
  }
}

async function openSample(zone, errorEl) {
  if (busy) return;
  busy = true;
  if (errorEl) errorEl.hidden = true;
  // No engine here: the sample plays its pre-rendered clips. It loads only if a voice or line changes.
  zone?.setBusy('Opening the sample deck', 0.05);
  try {
    const { project: next, bytes: nextBytes, doc } = await projects.importSample((phase, n, total) => {
      const p = progressLabel(phase, n, total);
      zone?.setBusy(p.text, p.fraction);
    });
    persist(next, nextBytes);
    await adopt(next, nextBytes, doc);
    $('#newDialog').close();
    show('practice');
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = errorText(err);
      errorEl.hidden = false;
    } else toast(errorText(err));
  } finally {
    busy = false;
    zone?.reset();
  }
}

// New presentation dialog: the drop zone and the sample live here for returning users.
const newZone = createDropzone({ onFile: (file) => openFile(file, newZone, $('#newError')) });
$('#newDrop').append(newZone.el);
$('#newSample').addEventListener('click', () => openSample(newZone, $('#newError')));

function openNewDialog() {
  player.stop();
  // Save the Script step now: once another deck opens, its text must not land in that deck.
  if (screen === 'script') script.flush();
  $('#newError').hidden = true;
  if (!$('#newDialog').open) $('#newDialog').showModal();
}
for (const btn of $$('[data-action="new"]')) btn.addEventListener('click', openNewDialog);

/** True when opening the sample would silently replace the user's own saved presentation. */
function wouldReplaceOwnWork(current) {
  return Boolean(current && !current.isSample);
}
for (const btn of $$('[data-action="voices"]')) {
  btn.addEventListener('click', () => {
    // Voice previews play in the panel: pause the rehearsal so they do not overlap.
    player.stop();
    presenters.open();
  });
}
for (const dialog of $$('dialog')) {
  for (const btn of $$('[data-close]', dialog)) btn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}
$('#presentersDialog').addEventListener('close', () => {
  // The dialog can close after the project changed or the screen left Practice: nothing to refresh then.
  if (screen !== 'practice' || !project || !derived) return;
  practice.update(player.getState(), null);
});
$('#editScript').addEventListener('click', () => show('script'));
$('#helpButton').addEventListener('click', () => app.openHelp());
$('#startTour').addEventListener('click', () => {
  $('#helpDialog').close();
  tour.start();
});

document.addEventListener('keydown', (e) => {
  if (screen === 'practice') practice.handleKey(e);
});

// A #sample link never drops the user's own presentation: it asks first, in the
// New presentation dialog, which has the sample button and the replace warning.
window.addEventListener('hashchange', () => {
  if (location.hash !== '#sample') return;
  history.replaceState(null, '', location.pathname + location.search);
  if (wouldReplaceOwnWork(project)) openNewDialog();
  else openSample(null, null);
});

async function boot() {
  store.requestPersistence();
  await tts.init().catch((err) => console.warn('Audio cache unavailable', err));
  const wantsSample = location.hash === '#sample';
  if (wantsSample) history.replaceState(null, '', location.pathname + location.search);
  let saved = null;
  try {
    saved = await projects.load();
  } catch (err) {
    console.warn('Could not read the saved presentation', err);
  }
  if (wantsSample && !wouldReplaceOwnWork(saved?.project)) {
    show('landing');
    await openSample(landing.zone, $('#landingError'));
    return;
  }
  if (!saved) {
    show('landing');
    return;
  }
  // The engine starts later, and only if a sentence has no saved audio.
  await adopt(saved.project, saved.bytes, null, { fresh: false });
  show(saved.project.stage === 'script' ? 'script' : 'practice');
  if (wantsSample) openNewDialog();
}

boot();
