# Presentice: PRD v1.1

A free, open-source web app for rehearsing a slide presentation out loud. Drop in your slides (PDF), optionally your script, and practice with a natural voice reading your lines sentence by sentence, with every word highlighted.

## 1. Why

People presenting in a second language, or presenting something that matters (a pitch, a thesis defense, a grant committee), rehearse by reading and re-reading. Hearing the script spoken naturally, sentence by sentence, and repeating it (shadowing) builds fluency much faster than silent reading. Existing tools need an account, cost money, send your content to a server, or use robotic voices.

## 2. Product principles

1. **Zero install, zero account, zero cost.** Open a link. Works in the browser.
2. **Private by construction.** The PDF, the script and the generated audio never leave the device. The only network traffic is the app code, the pinned libraries and the open voice model.
3. **No responsibility for the maintainer.** No server, no API keys, no data storage, no analytics. MIT license, "as is".
4. **Simple.** One path, fewest clicks. Every feature earns its place in a rehearsal. When in doubt, leave it out.
5. **Keyboard first** in the practice screen; mouse works everywhere.

## 3. Users and the main job

Primary user: one person (or a team of up to 3) preparing a talk with slides, on a laptop, English script.
Main job: "Let me hear my part, sentence by sentence, repeat it, and get back to the start of a sentence instantly."

## 4. User flow

```
Landing: [ drop or pick a PDF ]   [ Try the sample deck ]
   │ PDF picked (model starts loading)     │ sample (1 click)
   ▼                                       │
Script: textarea pre-filled with a draft   │
   + read-only slide preview               │
   │ Start practicing                      │
   ▼                                       ▼
Practice  <── "Presenters and voices" panel (optional, from Script or Practice)
```

A PDF-only run is: pick file, Start practicing.

### 4.0 Landing (first visit only; later visits resume the last project, paused)
- One line of value, the **PDF drop zone** itself (click to pick), and **Try the sample deck** next to it.
- Three short bullets: stays on your device; free; "Voices download once: about 120 MB, up to 350 MB on fast GPUs."
- Limits: max 60 pages, max 50 MB, clear error otherwise.
- On pick: pdf.js extracts each page's text and renders thumbnails, the voice model starts loading in its worker (section 5), and the app moves to the Script step with no extra click.

### 4.1 Script step (one editor for every path)
- **Left: one textarea**, opened already filled with a draft made from the slides (each slide's title and bullets turned into plain sentences, one presenter). The script is optional: the draft is always playable.
- Above the textarea:
  - **Upload .txt / .md** replaces the text.
  - **Write it with an AI chat (free)** reveals: "How many presenters? 1 2 3" (default 1) with optional name fields, **Copy prompt**, links to ChatGPT, Claude and Gemini, and "Paste the answer here" (focuses the textarea). The prompt contains every slide's text, the presenter count and names, and the exact format, and asks for the script inside one code block.
- **Right: read-only preview**, re-parsed live (debounced): one row per slide with thumbnail, paragraphs, a speaker chip per paragraph, and warnings ("Slide 7 has no script", "No slide markers found, paragraphs were spread evenly"). To change anything, edit the text. The script text is the only source of truth.
- Primary button **Start practicing** (uses detected presenters and distinct default voices). Secondary: **Presenters and voices**.
- PDF with no text layer: the textarea is empty with the hint "No selectable text found. Paste or write a script." Start practicing is disabled until the script has at least one sentence.

**Script format** (documented, and what the AI prompt asks for):
```
Slide 1
Alex: Good morning. Thank you for having us.
Sam: I will start with the problem.

Slide 2
...
```

**Parser rules** (built for real AI answers, not only well-formed ones):
- If a fenced code block contains Slide markers, use only its contents. Otherwise ignore everything before the first Slide marker, and drop a trailing block after the last slide that is set off by `---`, a code fence, or a blank line and has no speaker prefix while the rest of the script uses them.
- Strip markdown emphasis and heading marks (`**Slide 1**`, `## Slide 1`, `**Alex:**`, `> `).
- Slide markers: `Slide N`, `Slide N:`, `Slide N - Title`, and `---` separators.
- A line prefix `Word:` or `Two Words:` (capitalized) counts as a **speaker** only if it matches a name given in the AI panel or appears as a prefix at least twice in the script. `Note:`, `Revenue:`, `Step 1:` used once stay plain text.
- Lines without a speaker continue the previous speaker; the default is presenter 1.
- No slide markers: paragraphs are spread evenly over the slides in order, with a warning.

### 4.2 Presenters and voices (optional panel)
- Opened from the Script step or the Practice screen. Never a required step.
- Lists presenters detected from the script. Names come from the script (edit the script to rename). Colors are assigned automatically; each presenter gets a different default voice.
- Voice dropdown (8 curated English voices) with an instant preview from a pre-rendered clip.
- A voice change regenerates only that presenter's sentences (cache key includes the voice).

### 4.3 Practice screen
Layout (desktop): slide image on the left (large), transcript on the right, transport bar at the bottom.

- **Transcript**: current slide's sentences; the playing sentence is emphasized and its words highlight as they are spoken; each sentence carries the presenter color. Click a sentence to play from it.
- **Transport**: play/pause, previous/next sentence, replay sentence, previous/next slide, speed (0.8x, 0.9x, 1x, 1.1x).
- **Only my lines**: "Everyone / Alex / Sam". Plays only that presenter's sentences, across slides; skipped text stays visible, dimmed. Hidden when there is 1 presenter. Presenters with no lines are disabled; a slide with none of theirs shows "No lines for Sam on this slide".
- **Loop sentence**: repeats the current sentence until turned off.
- **Shadow mode**: after each playable sentence, a pause of (duration / speed) x 1.2 so the user can repeat it aloud, then continues.
- Slide strip with jump. **Edit script** returns to the Script step. **Presenters and voices** opens the panel.
- **Voice status** (aria-live): download bytes while loading, then "Preparing voices: 34/120 sentences" with a thin bar. If a sentence is not ready, a small spinner, and playback starts when it is. On the WASM backend, honest copy: "This device generates voices slower than real time. Short pauses between sentences are expected. Chrome or Edge with a recent GPU is faster."
- A resumed project opens paused; audio only starts from a click or key.

Keyboard: Space play/pause, Left/Right previous/next sentence, Up/Down previous/next slide, R replay, L loop, S shadow, F cycle "only my lines", `[` `]` speed, ? shortcuts and tour.

### 4.4 Guided tour
- Shown once on the first practice session, 5 short steps (slide, transcript, transport, only my lines, shadow and loop). Runs while the model loads. Skip at any step; reopen from **?**.

### 4.5 Persistence
- One project at a time in IndexedDB database `presentice` (all keys prefixed): original PDF bytes, page texts, thumbnails (JPEG blobs), script text, voice per presenter, audio cache, last position.
- **New presentation** (confirm dialog) contains the drop zone and **Try the sample deck**, so returning users can still reach the sample.
- Calls `navigator.storage.persist()`. README notes that Safari may clear site data after 7 days without a visit.

## 5. Voice engine

- **Kokoro-82M** via `kokoro-js@1.2.1`, run in a **dedicated same-origin module Web Worker** (`new Worker(new URL('./tts-worker.js', import.meta.url), {type: 'module'})`) that imports `kokoro.web.js` from jsDelivr. The main thread never runs inference.
- **Backend**: WebGPU fp32 (about 326 MB) when `navigator.gpu.requestAdapter()` returns an adapter and the model loads; otherwise WASM q8 (about 92 MB model plus 21.6 MB ORT wasm plus about 2 MB JS, about 120 MB). Fallback wrapped in try/catch. GitHub Pages cannot send COOP/COEP headers, so WASM runs single-threaded (measured about 2.2x slower than real time); WebGPU is about 1x.
- **Early start**: model download begins when a PDF is picked or the sample is opened; progress bytes from `progress_callback` feed the status bar. Browser caches keep the model (`transformers-cache`) and voices (`kokoro-voices`).
- **Queue**: one serial job queue in the worker (ORT cannot run two generations at once, and a started generation cannot be aborted). Order: current sentence, next 3+ playable sentences, rest of current slide, forward, then wrap. Rebuilt on every navigation; in-flight jobs finish. Jobs are deduplicated by cache key. Each Float32Array is transferred back to the page.
- **Audio format**: trimmed of leading and trailing silence (RMS threshold, about 80 ms padding kept), converted to 16-bit PCM WAV (48 KB/s), stored as ArrayBuffer plus duration. Cache key: SHA-256 of (normalized text, voice, dtype, model id), so edits and voice changes regenerate only what changed, and a backend switch does not serve mismatched audio.
- **Playback**: HTMLAudioElement with a blob URL. Speed is `playbackRate` with `preservesPitch` (default). Generation always happens at 1x; kokoro's speed option and AudioBufferSourceNode are not used.
- **Word timing**: kokoro-js returns audio only. Words are split with `Intl.Segmenter` (word granularity) and weighted by spoken length (digit groups expanded, pause weight after `, ; :`), spread over the trimmed duration. The sentence boundary is exact.
- **Sentence splitting**: `Intl.Segmenter('en', {granularity: 'sentence'})`, then re-merged around abbreviations (Dr., Mr., Ms., e.g., i.e., U.S., etc.), decimals and ellipses. Sentences over about 300 characters are hard-split at commas or semicolons (kokoro truncates past 510 tokens silently).
- Voice set: am_michael, af_heart, bm_george, bf_emma, am_adam, af_bella, bm_lewis, af_sarah (US and UK English).
- **Pre-rendered assets** (rendered once with Kokoro, Apache-2.0, and committed): the sample deck's full audio (MP3, about 1 to 2 MB) and one 3 s preview clip per voice. The sample plays instantly; edited sample sentences go through the model like any other.
- **Failure**: unsupported browser or model load failure shows what happened and what to try: reload, check the connection, or use Chrome or Edge on a laptop.

## 6. Player

One pure reducer (`player-state.js`, unit-tested) plus a thin effects layer.
- State: `cursor` (sentence index), `focus` ('all' or presenter id), `loop`, `shadow`, `rate`, `status` (idle, waiting, playing, gap, paused), `seq`.
- `playable(i)` = focus is 'all' or speaker(i) is focus. Next/previous step through playable sentences across slide boundaries. Up/Down jump to the first playable sentence at or after the start of the target slide.
- Every transition increments `seq` and clears the gap timer. After every await (cache read, generation), the result is dropped if `seq` changed.
- On audio end: shadow on, wait (duration / rate) x 1.2 then continue; loop on, replay the same cursor; otherwise go to the next playable sentence. Loop and shadow combine (repeat, pause, repeat).
- Replay seeks to 0 and plays the current cursor, including during a gap.
- `audio.play()` is always caught; AbortError is ignored. `play()` is only called from click or key paths.

## 7. Scope

In v1: everything in sections 4 to 6.

Out of v1: cue levels (hiding words), stumble markers, run mode with stopwatch and report, loop whole slide, Q&A section, editing script paragraphs inside the preview.

Later: script and UI in other languages, recording the user and comparing, `.docx` import, multiple saved projects, mobile layout beyond "does not break".

## 8. Technical design

- **Static site**, no build step. `index.html`, `css/app.css`, `js/*.js` as ES modules, `.nojekyll`. Hosted on **GitHub Pages** under `/presentice/`: only relative URLs, `new URL(..., import.meta.url)` for the worker, sample and assets.
- Pinned CDN libraries (jsDelivr): `kokoro-js@1.2.1`, `pdfjs-dist@5.4.624` (modern build). README notes that kokoro-js fetches the model from the Hugging Face main branch.
- Modules: `pdf.js` (load, render, extract), `script-parser.js`, `sentences.js`, `tts-worker.js`, `tts.js` (worker client, queue, cache), `store.js` (IndexedDB), `player-state.js` (reducer), `player.js` (effects), `ui/*` (landing, script, presenters panel, practice, tour).
- **pdf.js**: `getDocument({data: buf.slice(0), isEvalSupported: false, wasmUrl, cMapUrl, cMapPacked: true, standardFontDataUrl, iccUrl})`, each URL pointing at the pinned package folders (`wasm/`, `cmaps/`, `standard_fonts/`, `iccs/`). The original buffer is stored (pdf.js empties the one it receives). `GlobalWorkerOptions.workerSrc` = matching `build/pdf.worker.mjs`. Thumbnails render with `intent: 'print'` (avoids requestAnimationFrame stalls in hidden tabs); the large slide renders on demand at devicePixelRatio.
- **CSP** meta tag, before any script tag (tested with zero violations):
  ```
  default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.hf.co; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; font-src 'self' data: https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; form-action 'none'
  ```
  `*.hf.co` is required because Hugging Face redirects model files to `us.aws.cdn.hf.co`.
- **Security**: all user text via `textContent`, never `innerHTML`. Copy prompt uses `navigator.clipboard.writeText` inside the click handler, falling back to a selected read-only textarea.
- **Tests**: `node --test` on the pure modules, no dependencies: parser against saved fixtures, sentence splitter, player reducer against AC4 and AC5.
- **Accessibility**: visible focus, every control labeled, aria-live voice status, `prefers-reduced-motion` respected, AA contrast.
- **Sample deck**: fictional 5-slide PDF ("Brightside, a shared-bike app for small towns") with a 2-presenter script and pre-rendered audio in `sample/`. No real company, person or data.
- **Isolation**: separate repository; nothing from any private project is copied in.

## 9. Distribution (free)

- Public GitHub repo `presentice`, MIT license, GitHub Pages at `https://<user>.github.io/presentice/`.
- README (US English, no em or en dashes): one-line pitch, screenshot, **Open the app** link, 3-step quick start, privacy statement, download size, browser support, keyboard shortcuts, script format, run locally (download ZIP, `python3 -m http.server`), license and disclaimer.
- Repo polish: description, topics, social preview image, `.github/ISSUE_TEMPLATE/bug_report.md`.

## 10. Acceptance criteria

A **click** is one pointer activation. Picking a file through the file dialog counts as 1; pasting and typing count as 0.

1. First-time user: practice screen with the sample in 1 click and first audio within 2 s of pressing Play; own PDF without script in 2 clicks; own PDF plus pasted script in 3 clicks; AI chat path in 6 clicks inside the app.
2. A PDF with a text layer and no script is playable without editing: every slide with text gets at least one sentence.
3. Five saved fixtures (raw ChatGPT-, Claude- and Gemini-style answers, fictional, with markdown, code fences, preamble and closing chatter) parse to the expected slides and speakers. Lines like `Note:`, `Revenue:`, `Step 1:` used once create no presenter.
4. With 2 presenters and "only my lines = presenter 1", presenter 2's sentences never play, including across slides; replay returns to the start of presenter 1's current sentence.
5. Loop and shadow work together and with "only my lines"; next/previous while looping moves and keeps playing. Twenty rapid navigation key presses never play two sentences at once or a stale sentence.
6. Reload resumes the same project and position, paused; cached audio is not regenerated. Editing one sentence regenerates only that sentence; changing speed regenerates nothing.
7. A script containing `<img src=x onerror=alert(1)>` shows as text.
8. On GitHub Pages with the CSP on and site data cleared, the model loads and the full flow in Chrome shows no console errors or CSP violations.
9. Chrome with WebGPU: after the model loads, the first sentence plays within 5 s, and keyboard controls respond while voices generate (no main-thread task over 200 ms from TTS). Safari 18+ on macOS (WASM q8): full flow works, first sentence plays within 15 s after the model loads.
10. Failure paths: a PDF with no text layer shows "No selectable text found. Paste or write a script."; a failed model load shows retry advice; a PDF over 60 pages or 50 MB shows a clear error; "Only my lines" is hidden with 1 presenter.
11. All UI copy, the tour and the README are US English, with no em or en dashes and no curly quotes.

## 11. Decisions log

- **CSP**: took the second reviewer's tested policy. It covers the first reviewer's items (`*.hf.co`, `wasm-unsafe-eval`, worker rule) and adds `font-src` for pdf.js fonts. `worker-src` needs only `'self' blob:` because the TTS worker is same-origin and the pdf.js CDN worker is blob-wrapped. Scope: the meta tag governs the page only. A dedicated worker takes its policy from its own response headers, and GitHub Pages sends none, so the TTS worker's model downloads (Hugging Face) and runtime files (jsDelivr) are not filtered by `connect-src`. The README privacy section lists those destinations.
- **Backend**: kept WebGPU fp32 with WASM q8 fallback instead of q8 everywhere. q8 everywhere would simplify the size copy, but WASM is about 2.2x slower than real time; fp32 on WebGPU is the difference between waiting and not. The copy states both sizes honestly.
- **Steps**: merged Script and Review into one screen (textarea plus read-only preview) and turned Presenters into an optional panel. Presenter count is asked only inside the AI chat option, where the prompt needs it; everywhere else presenters come from `Name:` prefixes.
- **Editing**: no inline editing, speaker chip cycling, or split/merge/move controls. The script text is the only source of truth; the hash-keyed audio cache makes edits cheap.
- **Presenter count**: the data model accepts any number of presenters, with colors and voices assigned automatically in order; the UI and the AI prompt are designed and tested for 1 to 3. No forced fallback to 1 presenter.
- **Pre-rendered audio**: sample audio and voice previews ship as MP3 rather than Opus, because MP3 plays in every target browser including older Safari. About 1 to 2 MB is acceptable.
- **Safari**: support Safari 18+ with the modern pdf.js build only. No legacy build, to keep one code path.
- **Speed**: `playbackRate` with pitch preserved, never regeneration.
- **Spelling**: US English throughout ("practice", "license").
