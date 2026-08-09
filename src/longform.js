/**
 * Long-form anime quote compilations (2-3 minutes, 16:9 horizontal).
 *
 * These are what build watch hours toward YPP. A 3-min video with 40% retention
 * = 1.2 min per view. The channel's Re:Zero video got 2,389 views at 56s — at
 * 3 minutes that's 47 watch hours from a single video.
 *
 *   node src/longform.js              # generate + upload
 *   node src/longform.js --preview    # generate only
 *   node src/longform.js --theme "never giving up"
 *
 * Themes come from AniList trending genres or are specified manually.
 */
import { existsSync, mkdirSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';

import { loadQuotes, quoteId, fetchTrendingAnime } from './fetch-quotes.js';
import { generateVoiceover, getAudioDuration } from './voiceover.js';
import { selectVoice } from './generate-script.js';
import { fetchAllImages } from './fetch-images.js';
import { uploadToYouTube, setThumbnail } from './youtube-upload.js';
import { buildThumbnail } from './thumbnail.js';
import { markSeen, isSeen } from './seen-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4.1-mini';
const OUTPUT_DIR = config.output?.dir || './output';
const LOG_FILE = join(__dirname, '..', 'published.csv');

const previewMode = process.argv.includes('--preview');
const themeArg = process.argv.find(a => a.startsWith('--theme'));
const manualTheme = themeArg ? process.argv[process.argv.indexOf(themeArg) + 1] : null;

/**
 * Predefined themes that work well for compilations.
 * Each maps to moods/keywords in the quote bank.
 */
const THEMES = [
  { name: 'Never Giving Up', moods: ['power', 'motivational'], keywords: ['give up', 'fight', 'strong', 'risk'] },
  { name: 'Pain Makes You Stronger', moods: ['philosophical'], keywords: ['pain', 'sacrifice', 'lesson', 'loss'] },
  { name: 'Words That Hit Different', moods: ['emotional', 'inspirational'], keywords: ['heart', 'live', 'hope'] },
  { name: 'Villain Speeches That Go Hard', moods: ['power'], keywords: ['kill', 'control', 'alone'] },
  { name: 'Anime Confessions That Broke Us', moods: ['emotional'], keywords: ['love', 'happy', 'want you', 'hero'] },
  { name: 'Lines That Changed Everything', moods: ['philosophical', 'inspirational'], keywords: ['world', 'future', 'faith'] },
];

/**
 * Pick a theme and find 4-5 matching quotes.
 */
function pickThemeAndQuotes() {
  const all = loadQuotes();
  const seen = new Set(); // track what's used in THIS compilation

  // Shuffle themes and find one with enough fresh quotes
  const shuffled = [...THEMES].sort(() => Math.random() - 0.5);

  for (const theme of shuffled) {
    const matching = all.filter(q => {
      if (seen.has(quoteId(q.quote))) return false;
      if (isSeen(quoteId(q.quote))) return false;
      const matchesMood = theme.moods.includes(q.mood);
      const matchesKeyword = theme.keywords.some(k => q.quote.toLowerCase().includes(k));
      return matchesMood || matchesKeyword;
    });

    if (matching.length >= 4) {
      const picked = matching.slice(0, 5);
      return { theme, quotes: picked };
    }
  }

  // Fallback: just pick 4-5 fresh quotes regardless of theme
  const fresh = all.filter(q => !isSeen(quoteId(q.quote)));
  if (fresh.length >= 4) {
    return { theme: { name: 'Anime Quotes That Hit Different' }, quotes: fresh.slice(0, 5) };
  }

  return null;
}

/**
 * Generate intro/transition/outro narration for the compilation.
 */
async function generateCompilationScript(theme, quotes) {
  const apiKey = (config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || '')
    .replace(/^["']|["']$/g, '').trim();
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY');

  const quoteList = quotes.map((q, i) =>
    `${i + 1}. "${q.quote}" — ${q.character} (${q.anime})`
  ).join('\n');

  const prompt = `You're writing a 3-minute YouTube video for "Anime Resonance" — a compilation of powerful anime quotes.

THEME: "${theme.name}"
QUOTES IN ORDER:
${quoteList}

Write narration for this compilation. The narrator sets up each quote with dramatic context, then the quote plays, then a brief reflection before the next.

For each quote, write:
- INTRO (15-25 words): Set the emotional stage for THIS specific quote. What was happening? Why did this moment matter?
- (The quote itself plays here — you don't write it)
- BRIDGE (10-15 words): Brief reflection connecting to the next quote. Only for quotes 1-4, not the last one.

Also write:
- VIDEO_INTRO (20-30 words): Open the video. Hook the viewer. "These aren't just words — they're the moments that reminded us why we watch anime."
- VIDEO_OUTRO (20-30 words): Close it. "If even one of these lines stayed with you... subscribe. We find these moments so you never miss them."

YOUTUBE METADATA:
- title: "${theme.name} | Top ${quotes.length} Anime Speeches That Hit Different" (under 80 chars)
- description: List all quotes with character + anime. Then "Timestamps:" with approximate times. Then subscribe CTA.
- tags: 25-30 tags covering all anime names, character names, theme keywords, and discovery terms. Fill close to 500 chars.

Return ONLY valid JSON:
{
  "videoIntro": "...",
  "videoOutro": "...",
  "quotes": [
    { "intro": "...", "bridge": "..." },
    ...
  ],
  "youtube": { "title": "...", "description": "...", "hashtags": [...], "tags": [...] }
}`;

  const res = await fetch(OPENROUTER_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 6000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty completion');
  return JSON.parse(content);
}

/**
 * Render the long-form video using ffmpeg.
 * Structure: intro → (setup + quote + bridge) × N → outro
 */
async function renderLongform(segments, outputPath, bgmPath) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const inputs = [];
  const filterParts = [];
  const audioParts = [];
  let idx = 0;

  const W = 1920, H = 1080; // 16:9 horizontal

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const dur = s.duration || 8;
    const frames = Math.ceil(dur * 30);

    inputs.push('-loop', '1', '-t', String(dur.toFixed(2)), '-i', s.imagePath);
    inputs.push('-i', s.audioPath);

    // Ken Burns at 720p intermediate, upscale to 1920x1080, force SAR=1
    //    setsar=1 is critical: images from Pexels have varying aspect ratios, and
    //    concat requires every segment to have identical SAR. Without it ffmpeg
    //    reports "parameters do not match" and produces nothing.
    filterParts.push(
      `[${idx}:v]scale=2560:1440,`
      + `zoompan=z='min(zoom+0.0002,1.05)'`
      + `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
      + `:d=${frames}:s=1280x720:fps=30,`
      + `scale=${W}:${H}:flags=lanczos,setsar=1[v${i}]`
    );

    audioParts.push(`[${idx + 1}:a]`);
    idx += 2;
  }

  // BGM
  const hasBGM = bgmPath && existsSync(bgmPath);
  if (hasBGM) inputs.push('-i', bgmPath);

  const vLabels = segments.map((_, i) => `[v${i}]`).join('');
  filterParts.push(`${vLabels}concat=n=${segments.length}:v=1:a=0[vout]`);

  const aLabels = audioParts.join('');
  filterParts.push(`${aLabels}concat=n=${segments.length}:v=0:a=1[voice]`);

  if (hasBGM) {
    filterParts.push(`[${idx}:a]volume=0.08,afade=t=in:st=0:d=3,afade=t=out:st=170:d=10[bgm]`);
    filterParts.push(`[voice][bgm]amix=inputs=2:duration=first:dropout_transition=3[aout]`);
  } else {
    filterParts.push(`[voice]acopy[aout]`);
  }

  const args = [
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-shortest', '-y', outputPath,
  ];

  console.log(`   Rendering ${segments.length} segments (16:9 long-form)...`);
  await execFileAsync('ffmpeg', args, { timeout: 900000, maxBuffer: 10 * 1024 * 1024 });

  if (!existsSync(outputPath)) throw new Error(`No output at ${outputPath}`);
  return outputPath;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Anime Resonance — Long-Form Compilation');
  console.log('  ========================================\n');

  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, 'date,quote_id,character,anime,youtube_id,youtube_url,duration_sec\n');
  }

  const result = manualTheme
    ? { theme: { name: manualTheme }, quotes: loadQuotes().filter(q => !isSeen(quoteId(q.quote))).slice(0, 5) }
    : pickThemeAndQuotes();

  if (!result || result.quotes.length < 4) {
    console.log('  Not enough fresh quotes for a compilation. Add more to quotes.json.');
    return;
  }

  const { theme, quotes } = result;
  console.log(`  Theme: "${theme.name}"`);
  console.log(`  Quotes: ${quotes.length}`);
  for (const q of quotes) console.log(`    • ${q.character} (${q.anime}): "${q.quote.slice(0, 40)}..."`);

  const compId = `longform-${Date.now()}`;
  const compDir = join(OUTPUT_DIR, compId);
  mkdirSync(compDir, { recursive: true });

  try {
    // 1. Generate compilation script
    console.log('\n  Generating script...');
    const script = await generateCompilationScript(theme, quotes);
    console.log(`  Title: ${script.youtube?.title}`);

    // 2. Build all segments: intro → (setup + quote + bridge) × N → outro
    const segments = [];
    const narrationVoice = 'en-US-AndrewMultilingualNeural';

    // Video intro
    const introPath = join(compDir, 'intro.mp3');
    await generateVoiceover(script.videoIntro, introPath, narrationVoice);
    const introDur = await getAudioDuration(introPath);
    segments.push({ audioPath: introPath, duration: introDur, type: 'intro' });

    // Each quote: setup narration → the quote → bridge narration
    for (let i = 0; i < quotes.length; i++) {
      const q = quotes[i];
      const qs = script.quotes?.[i] || {};

      // Setup narration
      if (qs.intro) {
        const setupPath = join(compDir, `setup-${i}.mp3`);
        await generateVoiceover(qs.intro, setupPath, narrationVoice);
        segments.push({ audioPath: setupPath, duration: await getAudioDuration(setupPath), type: 'setup' });
      }

      // The quote itself — in the character's voice
      const quotePath = join(compDir, `quote-${i}.mp3`);
      const quoteVoice = selectVoice(q.gender, q.mood);
      await generateVoiceover(q.quote, quotePath, quoteVoice);
      segments.push({ audioPath: quotePath, duration: await getAudioDuration(quotePath), type: 'quote' });

      // Bridge to next (not on last quote)
      if (qs.bridge && i < quotes.length - 1) {
        const bridgePath = join(compDir, `bridge-${i}.mp3`);
        await generateVoiceover(qs.bridge, bridgePath, narrationVoice);
        segments.push({ audioPath: bridgePath, duration: await getAudioDuration(bridgePath), type: 'bridge' });
      }
    }

    // Video outro
    const outroPath = join(compDir, 'outro.mp3');
    await generateVoiceover(script.videoOutro, outroPath, narrationVoice);
    segments.push({ audioPath: outroPath, duration: await getAudioDuration(outroPath), type: 'outro' });

    const totalDuration = segments.reduce((n, s) => n + s.duration, 0);
    console.log(`\n  Total duration: ${totalDuration.toFixed(1)}s (${(totalDuration / 60).toFixed(1)} min)`);
    console.log(`  Segments: ${segments.length}`);

    // 3. Fetch images for each segment
    console.log('\n  Fetching images...');
    const imageQueries = segments.map((s, i) => {
      if (s.type === 'intro') return { imageQuery: 'dramatic anime landscape dark cinematic' };
      if (s.type === 'outro') return { imageQuery: 'emotional anime sunset stars cinematic' };
      if (s.type === 'setup') {
        const qi = Math.floor(i / 3);
        return { imageQuery: `${quotes[qi]?.anime || 'anime'} dramatic scene dark cinematic` };
      }
      if (s.type === 'quote') {
        const qi = Math.floor(i / 3);
        return { imageQuery: `${quotes[qi]?.character} ${quotes[qi]?.anime} emotional anime scene` };
      }
      return { imageQuery: 'dark moody anime landscape cinematic' };
    });

    const images = await fetchAllImages(imageQueries, compDir);
    for (let i = 0; i < segments.length; i++) {
      segments[i].imagePath = images[i] || join(compDir, `scene-${i}.jpg`);
    }

    // 4. Render
    console.log('\n  Rendering...');
    const outputPath = join(compDir, `${compId}.mp4`);
    const bgmPath = join(__dirname, '..', 'assets', 'bgm.mp3');
    await renderLongform(segments, outputPath, bgmPath);
    console.log(`  Output: ${outputPath}`);

    // 5. Thumbnail. Built before upload so a failure here is visible while the
    //    video is still unpublished, but never blocks publishing.
    let thumbPath = null;
    try {
      console.log('\n  Thumbnail...');
      thumbPath = await buildThumbnail({
        theme: theme.name,
        quoteCount: quotes.length,
        anime: quotes[0]?.anime,
        outDir: compDir,
      });
    } catch (err) {
      console.warn(`  ⚠ Thumbnail build failed, publishing without one: ${err.message}`);
    }

    // 6. Upload
    if (!previewMode) {
      console.log('\n  Uploading...');
      // Mark all quotes as seen
      for (const q of quotes) markSeen(quoteId(q.quote), `${q.character} - ${q.anime}`);

      const meta = {
        ...(script.youtube || {}),
        categoryId: '24', // Entertainment
        longForm: true,   // Don't append #shorts — this is a regular video
      };
      const videoId = await uploadToYouTube(outputPath, meta);

      if (videoId) {
        if (thumbPath) await setThumbnail(videoId, thumbPath);

        const row = [
          new Date().toISOString(), compId,
          `"compilation: ${theme.name}"`, `"${quotes.length} quotes"`,
          videoId, `https://youtube.com/watch?v=${videoId}`,
          totalDuration.toFixed(1),
        ].join(',');
        appendFileSync(LOG_FILE, row + '\n');
        console.log(`\n  ✅ Published: https://youtube.com/watch?v=${videoId}`);
      }
    } else {
      console.log(`\n  Preview: ${totalDuration.toFixed(1)}s — not uploaded`);
      if (thumbPath) console.log(`  Thumbnail: ${thumbPath}`);
    }
  } catch (err) {
    console.error(`\n  ❌ Failed: ${err.message}`);
    try { rmSync(compDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(console.error);
