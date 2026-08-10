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
import { existsSync, mkdirSync, rmSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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


// ─── On-screen text (16:9 long-form treatment) ───────────────────────────────
//
// Deliberately NOT word-by-word karaoke: that is a vertical-feed idiom and
// looks amateur at 1920x1080. Landscape gets a bottom-anchored plate that hugs
// the text, plus an orange rank pill so the video reads as a ranked list at a
// glance.

const ACCENT = '0xff6600';   // pill orange
const PLATE = '0x07090c';    // near-black plate

const CAP_SIZE = 40;
const CAP_LINE_H = Math.round(CAP_SIZE * 1.34);  // 54px — lines stack flush
const CAP_CHARS = 52;                            // per the HotDrop spec
const CAP_MAX_LINES = 2;
const CAP_BAND_BOTTOM = 40;                      // band sits 40px off the floor

const PILL_SIZE = 30;
const PILL_PAD_X = 20;
const PILL_PAD_Y = 9;
const TITLE_SIZE = 42;
const TEXT_LEFT = 96;
const ROW_BOTTOM = 210;                          // clear of the caption band

/**
 * First bold font that actually exists here. With no fontfile ffmpeg silently
 * falls back to a monospace terminal face, which looks broken.
 */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',            // Linux CI
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',                                    // local dev
  'C:/Windows/Fonts/arialbd.ttf',
];
const FONT = FONT_CANDIDATES.find((f) => existsSync(f)) || null;

/**
 * Escape a path for the filter graph. A Windows drive colon needs a DOUBLED
 * backslash to survive both the option tokenizer and the filter parser.
 */
function escapeFilterPath(p) {
  return resolve(p).replace(/\\/g, '/').replace(/:/g, '\\\\:');
}

/** Greedy word wrap — drawtext cannot wrap. */
function wrapText(text, maxChars) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}


/** Wrapped lines grouped into blocks of at most 2, shown in succession. */
function captionBlocks(text) {
  const lines = wrapText(text, CAP_CHARS);
  const blocks = [];
  for (let i = 0; i < lines.length; i += CAP_MAX_LINES) {
    blocks.push(lines.slice(i, i + CAP_MAX_LINES));
  }
  return blocks;
}

/**
 * One drawtext per line, never a newline inside a textfile — a newline renders
 * as a tofu glyph in ffmpeg 8.x. textfile= also means no apostrophe, colon or
 * percent in the quote text can break the graph.
 *
 * ponytail: text is burned per-segment with drawtext rather than an ASS track.
 * Ceiling: no italics or per-word timing. Upgrade path: switch to libass if the
 * caption design ever needs either.
 */
function drawCaptionBlock({ lines, dir, tag, enable, frameH }) {
  const bandBottom = frameH - CAP_BAND_BOTTOM;
  return lines.map((text, n) => {
    const file = join(dir, `${tag}-${n}.txt`);
    writeFileSync(file, text, 'utf-8');
    // Text grows upward from the bottom of the band; blocks stack flush so two
    // lines read as one continuous plate.
    const y = bandBottom - (lines.length - n) * CAP_LINE_H;
    let f = `drawtext=textfile=${escapeFilterPath(file)}`
      + `:fontsize=${CAP_SIZE}:fontcolor=white`
      + `:shadowx=0:shadowy=2:shadowcolor=black@0.55`
      + `:box=1:boxcolor=${PLATE}@0.78:boxborderw=3|18`
      + `:x=(w-text_w)/2:y=${y}`;
    if (FONT) f += `:fontfile=${escapeFilterPath(FONT)}`;
    if (enable) f += `:enable='${enable}'`;
    return f;
  });
}


/**
 * Orange rank pill + anime/character title, above the caption band. This is
 * the ranked-list signal: quote 3 reads "3." for every one of its segments.
 */
function drawRankRow({ number, title, dir, tag, frameH }) {
  const parts = [];
  const rowBottom = frameH - ROW_BOTTOM;
  const pillY = rowBottom - PILL_SIZE - PILL_PAD_Y;

  let pill = `drawtext=text=${number}.`
    + `:fontsize=${PILL_SIZE}:fontcolor=white`
    + `:box=1:boxcolor=${ACCENT}@1:boxborderw=${PILL_PAD_Y}|${PILL_PAD_X}`
    + `:x=${TEXT_LEFT}:y=${pillY}`;
  if (FONT) pill += `:fontfile=${escapeFilterPath(FONT)}`;
  parts.push(pill);

  if (title) {
    // Pill width is not knowable inside the graph, so the title starts at a
    // fixed offset wide enough for a two-digit rank plus its padding.
    const file = join(dir, `${tag}-title.txt`);
    writeFileSync(file, String(title).slice(0, 46), 'utf-8');
    const titleY = rowBottom - PILL_SIZE - PILL_PAD_Y - Math.round((TITLE_SIZE - PILL_SIZE) / 2);
    let t = `drawtext=textfile=${escapeFilterPath(file)}`
      + `:fontsize=${TITLE_SIZE}:fontcolor=white`
      + `:shadowx=0:shadowy=2:shadowcolor=black@0.6`
      + `:x=${TEXT_LEFT + 116}:y=${titleY}`;
    if (FONT) t += `:fontfile=${escapeFilterPath(FONT)}`;
    parts.push(t);
  }
  return parts;
}

/**
 * Every drawtext for one segment. `hold` is segment-local: the chain runs after
 * setpts=PTS-STARTPTS, so enable windows are 0..hold, not global time.
 */
function segmentTextFilters(s, i, dir, hold, frameH) {
  const parts = [];

  if (s.quoteNumber) {
    const title = [s.anime, s.character].filter(Boolean).join(' — ');
    parts.push(...drawRankRow({ number: s.quoteNumber, title, dir, tag: `rank-${i}`, frameH }));
  }

  const text = (s.caption || '').trim();
  if (text) {
    const blocks = captionBlocks(text);
    const share = hold / blocks.length;
    blocks.forEach((lines, b) => {
      // A single block holds for the whole segment; several split it evenly.
      const enable = blocks.length === 1
        ? null
        : `between(t,${(b * share).toFixed(2)},${((b + 1) * share).toFixed(2)})`;
      parts.push(...drawCaptionBlock({ lines, dir, tag: `cap-${i}-${b}`, enable, frameH }));
    });
  }
  return parts;
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
  const workDir = dirname(resolve(outputPath)); // caption textfiles live here

  const W = 1920, H = 1080; // 16:9 horizontal
  const FPS = 30;
  const XFADE = 0.6;

  // Oversize canvas the pan window travels across, matching render.js.
  const CW = Math.round(W * 1.12 / 2) * 2;
  const CH = Math.round(H * 1.12 / 2) * 2;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const dur = s.duration || 8;
    const hold = dur + XFADE;

    inputs.push('-loop', '1', '-t', hold.toFixed(2), '-i', resolve(s.imagePath));
    inputs.push('-i', resolve(s.audioPath));

    // Composite: blurred cover as the backdrop, whole image contained on top.
    //
    // A plain cover-crop butchered portrait art in a 16:9 frame — a vertical
    // Danbooru image was scaled up until it filled 1920x1080, leaving a torso
    // with the head cropped off. Containing the art preserves the subject
    // whatever its shape, and the blurred backdrop fills the sides so nothing
    // is letterboxed. Landscape art covers the frame and hides the backdrop
    // entirely, so it costs nothing in the common case.
    //
    // Only the backdrop pans; panning the contained layer would drift the
    // subject off-centre. setsar=1 still matters — mixed source aspect ratios
    // make xfade fail with "parameters do not match".
    const slackX = CW - W;
    const slackY = CH - H;
    const prog = `min(t/${hold.toFixed(2)},1)`;
    const dir = i % 3;
    const panX = dir === 0 ? `${slackX}*${prog}`
      : dir === 1 ? `${slackX}*(1-${prog})`
        : `${slackX}/2`;
    const panY = dir === 0 ? `${slackY}*(1-${prog})`
      : dir === 1 ? `${slackY}*${prog}`
        : `${slackY}*${prog}`;

    filterParts.push(
      `[${idx}:v]format=yuv420p,fps=${FPS},split=2[bgsrc${i}][fgsrc${i}]`
    );
    filterParts.push(
      `[bgsrc${i}]scale=${CW}:${CH}:force_original_aspect_ratio=increase:flags=bilinear,`
      + `crop=${CW}:${CH},`
      + `crop=${W}:${H}:x='${panX}':y='${panY}',`
      + `boxblur=26:2,eq=brightness=-0.12:saturation=0.85[bg${i}]`
    );
    filterParts.push(
      `[fgsrc${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg${i}]`
    );
    const textFilters = segmentTextFilters(s, i, workDir, hold, H);
    filterParts.push(
      `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2:format=auto,`
      + `eq=contrast=1.05:saturation=1.02,`
      + `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.34:t=fill,`
      + `setsar=1,setpts=PTS-STARTPTS`
      + (textFilters.length ? `,${textFilters.join(',')}` : '')
      + `[v${i}]`
    );

    audioParts.push(`[${idx + 1}:a]`);
    idx += 2;
  }


  // BGM
  const hasBGM = bgmPath && existsSync(bgmPath);
  if (hasBGM) inputs.push('-i', bgmPath);

  // Crossfade the segments together rather than hard-cutting.
  if (segments.length === 1) {
    filterParts.push(`[v0]null[vout]`);
  } else {
    let prev = 'v0';
    let offset = (segments[0].duration || 8) - XFADE;
    for (let i = 1; i < segments.length; i++) {
      const out = i === segments.length - 1 ? 'vout' : `xf${i - 1}`;
      filterParts.push(
        `[${prev}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(2)}[${out}]`
      );
      prev = out;
      offset += (segments[i].duration || 8) - XFADE;
    }
  }

  const aLabels = audioParts.join('');
  filterParts.push(`${aLabels}concat=n=${segments.length}:v=0:a=1[voice]`);

  if (hasBGM) {
    // Real file duration accounts for N-1 crossfade overlaps that each consume
    // XFADE seconds. Without this correction the fade-out started past the end
    // of the actual file and was never heard (BUG 2).
    const realDuration = segments.reduce((n, s) => n + (s.duration || 8), 0)
      - XFADE * Math.max(0, segments.length - 1);

    // assets/bgm.mp3 is exactly 30.00s with baked-in fades: a 3s fade-in at the
    // head and a fade-out starting at ~26s. Trim to the flat interior [3.0,26.0]
    // before looping so the splice is level-matched (BUG 1).
    //
    // ponytail: static gain replaces loudnorm. The asset is a flat -45.9 dBFS
    // bed; loudnorm's sliding window introduced dips at loop seams because its
    // internal state could not distinguish a splice from a dynamic change.
    // A static boost is invisible to the loop. Ceiling: if the asset changes,
    // re-measure and update the gain. Upgrade path: pre-render a seamless bed.
    const BGM_LOOP_IN = 3.0;   // measured: steady-state (-45.9 dBFS) begins here
    const BGM_LOOP_OUT = 26.0; // measured: fade-out begins at 26.1s
    const BGM_GAIN_DB = 8;     // -45.9 + 8 = -37.9 dBFS final (under narration)
    const loopBody = BGM_LOOP_OUT - BGM_LOOP_IN; // 23s
    const loopCount = Math.ceil(realDuration / loopBody); // finite; atrim caps
    filterParts.push(
      `[${idx}:a]atrim=start=${BGM_LOOP_IN}:end=${BGM_LOOP_OUT},asetpts=N/SR,`
      + `aloop=loop=${loopCount}:size=2147483647,asetpts=N/SR,`
      + `atrim=start=0:end=${realDuration.toFixed(2)},volume=${BGM_GAIN_DB}dB,`
      + `afade=t=in:st=0:d=3,`
      + `afade=t=out:st=${Math.max(0, realDuration - 8).toFixed(2)}:d=8[bgm]`
    );
    filterParts.push(`[voice][bgm]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[aout]`);
  } else {
    filterParts.push(`[voice]anull[aout]`);
  }

  const args = [
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-r', String(FPS), '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-shortest', '-y', resolve(outputPath),
  ];

  console.log(`   Rendering ${segments.length} segments (16:9, fill-frame + pan)...`);
  await execFileAsync('ffmpeg', args, { timeout: 900000, maxBuffer: 20 * 1024 * 1024 });

  if (!existsSync(resolve(outputPath))) throw new Error(`No output at ${outputPath}`);
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
    segments.push({ audioPath: introPath, duration: introDur, type: 'intro', caption: script.videoIntro });


    // Each quote: setup narration → the quote → bridge narration.
    // The rank number is attached HERE, where `i` is the real quote index.
    // Deriving it from the segment index (floor(i/3)) drifts by one for every
    // later segment whenever the model omits an intro or a bridge, and puts a
    // bridge on the NEXT quote's number even in the fully populated case.
    for (let i = 0; i < quotes.length; i++) {
      const q = quotes[i];
      const qs = script.quotes?.[i] || {};
      const tag = { quoteIndex: i, quoteNumber: i + 1, character: q.character, anime: q.anime, quoteText: q.quote };

      // Setup narration
      if (qs.intro) {
        const setupPath = join(compDir, `setup-${i}.mp3`);
        await generateVoiceover(qs.intro, setupPath, narrationVoice);
        segments.push({ audioPath: setupPath, duration: await getAudioDuration(setupPath), type: 'setup', caption: qs.intro, ...tag });
      }

      // The quote itself — in the character's voice
      const quotePath = join(compDir, `quote-${i}.mp3`);
      const quoteVoice = selectVoice(q.gender, q.mood);
      await generateVoiceover(q.quote, quotePath, quoteVoice);
      segments.push({ audioPath: quotePath, duration: await getAudioDuration(quotePath), type: 'quote', caption: `"${q.quote}"`, ...tag });

      // Bridge to next (not on last quote)
      if (qs.bridge && i < quotes.length - 1) {
        const bridgePath = join(compDir, `bridge-${i}.mp3`);
        await generateVoiceover(qs.bridge, bridgePath, narrationVoice);
        segments.push({ audioPath: bridgePath, duration: await getAudioDuration(bridgePath), type: 'bridge', caption: qs.bridge, ...tag });
      }
    }

    // Video outro
    const outroPath = join(compDir, 'outro.mp3');
    await generateVoiceover(script.videoOutro, outroPath, narrationVoice);
    segments.push({ audioPath: outroPath, duration: await getAudioDuration(outroPath), type: 'outro', caption: script.videoOutro });

    const totalDuration = segments.reduce((n, s) => n + s.duration, 0);
    console.log(`\n  Total duration: ${totalDuration.toFixed(1)}s (${(totalDuration / 60).toFixed(1)} min)`);
    console.log(`  Segments: ${segments.length}`);


    // 3. Fetch images for each segment.
    //    Anime and character are passed through so the art search hits anime
    //    sources; with only a prose imageQuery it falls back to stock photos.
    console.log('\n  Fetching images...');
    const imageQueries = segments.map((s, i) => {
      const qi = Math.min(s.quoteIndex ?? Math.floor(i / 3), quotes.length - 1);
      const q = quotes[qi] || {};
      if (s.type === 'intro') {
        return { anime: quotes[0]?.anime, imageQuery: 'dramatic anime landscape dark cinematic' };
      }
      if (s.type === 'outro') {
        return { anime: quotes[quotes.length - 1]?.anime, imageQuery: 'emotional anime sunset stars cinematic' };
      }
      if (s.type === 'quote') {
        return { anime: q.anime, character: q.character, imageQuery: `${q.character} ${q.anime} emotional anime scene` };
      }
      // setup / bridge
      return { anime: q.anime, imageQuery: `${q.anime || 'anime'} dramatic scene dark cinematic` };
    });

    const images = await fetchAllImages(imageQueries, compDir, { orientation: 'landscape' });
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
      const meta = {
        ...(script.youtube || {}),
        categoryId: '24', // Entertainment
        longForm: true,   // Don't append #shorts — this is a regular video
      };
      const videoId = await uploadToYouTube(outputPath, meta);

      // Mark seen only after a confirmed upload, so a rejected video does not
      // consume five quotes with nothing published.
      if (!videoId) {
        throw new Error('upload failed — quotes left unseen for a later retry');
      }

      for (const q of quotes) markSeen(quoteId(q.quote), `${q.character} - ${q.anime}`);
      if (thumbPath) await setThumbnail(videoId, thumbPath);

      const row = [
        new Date().toISOString(), compId,
        `"compilation: ${theme.name}"`, `"${quotes.length} quotes"`,
        videoId, `https://youtube.com/watch?v=${videoId}`,
        totalDuration.toFixed(1),
      ].join(',');
      appendFileSync(LOG_FILE, row + '\n');
      console.log(`\n  ✅ Published: https://youtube.com/watch?v=${videoId}`);
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
