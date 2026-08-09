/**
 * Anime Shorts pipeline entry point.
 *
 *   node src/index.js --once      # one run, exit (CI)
 *   node src/index.js --preview   # render but don't upload
 *   node src/index.js             # poll mode (local)
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, appendFileSync } from 'node:fs';

import { pickQuotes } from './fetch-quotes.js';
import { generateScript } from './generate-script.js';
import { fetchAllImages } from './fetch-images.js';
import { generateVoiceover, getAudioDuration } from './voiceover.js';
import { renderVideo } from './render.js';
import { uploadToYouTube } from './youtube-upload.js';
import { markSeen } from './seen-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));


const LOG_FILE = join(__dirname, '..', 'published.csv');
const OUTPUT_DIR = config.output?.dir || './output';

const previewMode = process.argv.includes('--preview');
const runOnce = process.argv.includes('--once');

if (previewMode) console.log('  PREVIEW MODE — no uploads\n');

console.log('\n  Anime Resonance Shorts Pipeline');
console.log('  ================================\n');

async function main() {
  // Ensure CSV header
  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, 'date,quote_id,character,anime,youtube_id,youtube_url,duration_sec\n');
  }

  console.log('  Picking quotes...');
  const quotes = await pickQuotes(config.poll?.maxShortsPerRun || 2);

  if (!quotes.length) {
    console.log('  No fresh quotes available. Add more to quotes.json.');
    return;
  }

  console.log(`  ${quotes.length} quote(s) selected\n`);

  for (const quote of quotes) {
    await processQuote(quote);
  }
}

async function processQuote(quote) {
  console.log(`\n  "${quote.quote.slice(0, 50)}..." — ${quote.character}`);
  console.log(`  [${quote.anime}] mood:${quote.mood} gender:${quote.gender}\n`);

  const storyDir = join(OUTPUT_DIR, `short-${quote.id}`);
  if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true });

  try {
    // 1. Generate script via LLM
    console.log('  Script...');
    const script = await generateScript(quote);

    // 2. Fetch images
    console.log('  Images...');
    await fetchAllImages(script.scenes, storyDir);

    // 3. Generate voiceover per scene
    console.log('  Voiceover...');
    let totalDuration = 0;
    for (let i = 0; i < script.scenes.length; i++) {
      const outPath = join(storyDir, `scene-${i}.mp3`);
      await generateVoiceover(script.scenes[i].narration, outPath, script.voice);
      const dur = await getAudioDuration(outPath);
      totalDuration += dur;
      script.scenes[i].duration = dur;
    }
    console.log(`  Duration: ${totalDuration.toFixed(1)}s`);

    // 4. Render video (ffmpeg: Ken Burns zoom + BGM)
    const outputFile = join(storyDir, `anime-short-${quote.id}.mp4`);
    console.log('  Render...');
    const renderScenes = script.scenes.map((s, i) => ({
      imagePath: join(storyDir, `scene-${i}.jpg`),
      audioPath: join(storyDir, `scene-${i}.mp3`),
      duration: s.duration,
    })).filter((s) => existsSync(s.imagePath) && existsSync(s.audioPath));

    if (renderScenes.length < script.scenes.length) {
      console.log(`  ⚠ Only ${renderScenes.length}/${script.scenes.length} scenes have both image+audio`);
    }
    if (!renderScenes.length) throw new Error('No complete scenes to render');

    await renderVideo(renderScenes, outputFile);
    console.log(`  Video: ${outputFile}`);

    // 5. Upload
    if (!previewMode) {
      markSeen(quote.id, `${quote.character} - ${quote.anime}`);
      const videoId = await uploadToYouTube(outputFile, script.youtube);
      if (videoId) {
        const row = [
          new Date().toISOString(),
          quote.id,
          `"${quote.character}"`,
          `"${quote.anime}"`,
          videoId,
          `https://youtube.com/shorts/${videoId}`,
          totalDuration.toFixed(1),
        ].join(',');
        appendFileSync(LOG_FILE, row + '\n');
      }
    } else {
      console.log(`  Preview: ${totalDuration.toFixed(1)}s — not uploaded`);
    }

    console.log(`  Done: ${quote.character} — ${quote.anime}`);
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    try { rmSync(storyDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(console.error);

if (!runOnce) {
  const ms = (config.poll?.intervalMinutes || 360) * 60 * 1000;
  console.log(`\n  Polling every ${config.poll?.intervalMinutes || 360}min...`);
  setInterval(() => main().catch(console.error), ms);
}
