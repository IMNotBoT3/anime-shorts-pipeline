/**
 * Anime Shorts pipeline entry point.
 *
 * Produces 5 Shorts per run from the highest-opportunity anime topics — not
 * limited to quotes. Rankings, news, debates, and reactions all compete on
 * measured demand/supply ratio.
 *
 *   node src/index.js --once        # one run, 5 shorts, uploads (CI default)
 *   node src/index.js --preview     # render but don't upload
 *   node src/index.js --once --skip-saturation  # skip API checks (testing)
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, appendFileSync } from 'node:fs';

import { pickTopics } from './pick-topics.js';
import { generateScript, generateTopicScript } from './generate-script.js';
import { fetchAllImages } from './fetch-images.js';
import { generateVoiceover, getAudioDuration } from './voiceover.js';
import { buildAnimeComposition } from './compose-anime.js';
import { uploadToYouTube } from './youtube-upload.js';
import { markSeen } from './seen-store.js';
import { getSubGoal } from './sub-count.js';
import { transcribeAllScenes } from './transcribe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const LOG_FILE = join(__dirname, '..', 'published.csv');
const OUTPUT_DIR = config.output?.dir || './output';

const previewMode = process.argv.includes('--preview');
const runOnce = process.argv.includes('--once');
const skipSaturation = process.argv.includes('--skip-saturation');
const MAX_SHORTS = config.poll?.maxShortsPerRun || 5;

if (previewMode) console.log('  PREVIEW MODE — no uploads\n');

console.log('\n  Anime Resonance Shorts Pipeline');
console.log('  ================================\n');

async function main() {
  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, 'date,quote_id,character,anime,youtube_id,youtube_url,duration_sec\n');
  }

  console.log('  Picking topics (quotes + news + rankings + debates)...\n');
  const topics = await pickTopics(MAX_SHORTS, { skipSaturation });

  // Fetch subscriber count once per run for the goal overlay
  const subGoal = await getSubGoal(100).catch(() => null);
  if (subGoal) console.log(`  📊 Subscribers: ${subGoal.count}/${subGoal.goal} (${subGoal.percentage}%)\n`);

  if (!topics.length) {
    console.log('  No viable topics found.');
    return;
  }

  console.log(`\n  ${topics.length} topic(s) to produce:\n`);
  for (const t of topics) {
    const sat = t.saturation;
    console.log(`    [${t.type}] ${t.title.slice(0, 60)}`);
    if (sat) console.log(`         ${sat.verdict} — ${sat.reason}`);
  }
  console.log('');

  let published = 0;
  for (const topic of topics) {
    try {
      await processTopic(topic, subGoal);
      published++;
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}\n`);
    }
  }

  console.log(`\n  ══════════════════════════════════`);
  console.log(`  Done: ${published}/${topics.length} Shorts ${previewMode ? 'rendered' : 'published'}`);
}

async function processTopic(topic, subGoal) {
  console.log(`\n  ──────────────────────────────────`);
  console.log(`  [${topic.type.toUpperCase()}] ${topic.title.slice(0, 60)}`);
  if (topic.anime) console.log(`  Anime: ${topic.anime}`);
  console.log('');

  const storyDir = join(OUTPUT_DIR, `short-${topic.id}`);
  if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true });

  try {
    // 1. Generate script — different prompts for different content types
    console.log('  Script...');
    let script;
    if (topic.type === 'quote' && topic.quote) {
      // Use the existing quote script generator for quote topics
      script = await generateScript(topic.quote);
    } else {
      // For news/rankings/debates, use a topic-driven script generator
      script = await generateTopicScript(topic);
    }

    // 2. Fetch images
    console.log('  Images...');
    const imageScenes = script.scenes.map((s, i) => ({
      imageQuery: s.imageQuery,
      anime: topic.anime || script.anime,
      character: s.character || undefined,
    }));
    await fetchAllImages(imageScenes, storyDir);

    // 3. Generate voiceover per scene (with word timestamps for karaoke)
    console.log('  Voiceover...');
    let totalDuration = 0;
    const audioPaths = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const outPath = join(storyDir, `scene-${i}.mp3`);
      const voice = script.scenes[i].voice || script.voice || 'en-US-AndrewMultilingualNeural';
      await generateVoiceover(script.scenes[i].narration, outPath, voice);

      let dur = await getAudioDuration(outPath);
      if (i === 0) dur += 0.8; // dramatic pause after intro
      totalDuration += dur;
      script.scenes[i].duration = dur;
      audioPaths.push(outPath);
    }
    console.log(`  Duration: ${totalDuration.toFixed(1)}s`);

    // 4. Get word-level timestamps for karaoke captions
    console.log('  Word sync...');
    const wordTimestamps = transcribeAllScenes(audioPaths);

    // 5. Build HyperFrames composition (HTML + GSAP animation)
    console.log('  Composing...');
    const compDir = join(storyDir, 'composition');
    const compositionScenes = script.scenes.map((s, i) => ({
      narration: s.narration,
      duration: s.duration,
      imagePath: join(storyDir, `scene-${i}.jpg`),
      audioPath: audioPaths[i],
      words: (wordTimestamps[i] || []).length
        ? wordTimestamps[i].map(w => ({ text: w.text || w.word || '', start: w.start, end: w.end }))
        : s.narration.split(/\s+/).filter(Boolean).map(w => ({ text: w, start: null, end: null })),
    }));

    buildAnimeComposition({
      scenes: compositionScenes,
      topic,
      subGoal,
      outputDir: compDir,
    });

    // 6. Render with HyperFrames CLI
    const outputFile = join(storyDir, `anime-short-${topic.id}.mp4`);
    console.log('  Render (HyperFrames)...');

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Use the local hyperframes CLI (installed as devDependency)
    const hfCli = join(__dirname, '..', 'node_modules', 'hyperframes', 'dist', 'cli.js');
    if (!existsSync(hfCli)) {
      throw new Error('hyperframes CLI not found — run: npm install');
    }

    await execFileAsync(process.execPath, [
      hfCli, 'render', compDir, '-o', outputFile,
    ], { timeout: 600000, maxBuffer: 20 * 1024 * 1024 });

    if (!existsSync(outputFile)) throw new Error('HyperFrames render produced no output');
    console.log(`  Video: ${outputFile}`);

    // 5. Upload
    if (!previewMode) {
      const videoId = await uploadToYouTube(outputFile, script.youtube);
      if (!videoId) throw new Error('upload failed — topic left unseen for retry');

      markSeen(topic.id, topic.title);
      const row = [
        new Date().toISOString(),
        topic.id,
        `"${(topic.quote?.character || topic.type).replace(/"/g, "'")}"`,
        `"${(topic.anime || topic.title.slice(0, 30)).replace(/"/g, "'")}"`,
        videoId,
        `https://youtube.com/shorts/${videoId}`,
        totalDuration.toFixed(1),
      ].join(',');
      appendFileSync(LOG_FILE, row + '\n');
      console.log(`  ✅ Published: https://youtube.com/shorts/${videoId}`);
    } else {
      console.log(`  Preview: ${totalDuration.toFixed(1)}s — not uploaded`);
    }
  } catch (err) {
    try { rmSync(storyDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

main().catch(console.error);

if (!runOnce) {
  const ms = (config.poll?.intervalMinutes || 360) * 60 * 1000;
  console.log(`\n  Polling every ${config.poll?.intervalMinutes || 360}min...`);
  setInterval(() => main().catch(console.error), ms);
}
