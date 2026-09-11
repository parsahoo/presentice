// Pre-renders the sample deck audio and the voice preview clips with Kokoro.
// Maintainers only. The app never runs this.
//
//   mkdir /tmp/kokoro && cd /tmp/kokoro && npm install kokoro-js@1.2.1
//   KOKORO_JS=/tmp/kokoro/node_modules/kokoro-js/dist/kokoro.js node scripts/render-audio.mjs
//
// Needs ffmpeg on the PATH for MP3 encoding.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript, flattenSentences } from '../js/script-parser.js';
import { trimSilence, encodeWav } from '../js/wav.js';
import { sampleKey, MODEL_ID } from '../js/keys.js';
import { VOICES, defaultVoices } from '../js/voices.js';

const root = new URL('..', import.meta.url).pathname;
const { KokoroTTS } = await import(process.env.KOKORO_JS || 'kokoro-js');
const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'cpu' });
const work = join(tmpdir(), `presentice-render-${process.pid}`);
mkdirSync(work, { recursive: true });

async function renderMp3(text, voice, outPath) {
  const audio = await tts.generate(text, { voice });
  const trimmed = trimSilence(audio.audio, audio.sampling_rate);
  const wavPath = join(work, 'clip.wav');
  writeFileSync(wavPath, Buffer.from(encodeWav(trimmed, audio.sampling_rate)));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame', '-b:a', '48k', outPath]);
  return Math.round((trimmed.length / audio.sampling_rate) * 1000) / 1000;
}

// Sample deck
const script = readFileSync(join(root, 'sample/brightside-script.txt'), 'utf8');
const parsed = parseScript(script, { slideCount: 5 });
const voices = defaultVoices(parsed.presenters);
const sentences = flattenSentences(parsed);
const audioDir = join(root, 'sample/audio');
rmSync(audioDir, { recursive: true, force: true });
mkdirSync(audioDir, { recursive: true });
const items = {};
for (const s of sentences) {
  const voice = voices[s.speaker];
  const key = await sampleKey(s.text, voice);
  const file = `${key.slice(0, 16)}.mp3`;
  const duration = await renderMp3(s.text, voice, join(audioDir, file));
  items[key] = { file: `audio/${file}`, duration };
  console.log(`${s.speaker} (${voice}) ${duration}s ${s.text}`);
}
writeFileSync(join(root, 'sample/manifest.json'), `${JSON.stringify({ model: MODEL_ID, voices, items }, null, 2)}\n`);

// Voice previews
const previewDir = join(root, 'assets/voices');
mkdirSync(previewDir, { recursive: true });
for (const v of VOICES) {
  const duration = await renderMp3(`Hi, I'm ${v.name}. Let's rehearse your talk together.`, v.id, join(previewDir, `${v.id}.mp3`));
  console.log(`preview ${v.id} ${duration}s`);
}
rmSync(work, { recursive: true, force: true });
