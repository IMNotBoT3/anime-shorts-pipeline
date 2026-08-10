/**
 * Long-form render engine (16:9, 1920x1080).
 *
 * Extracted from longform.js so both the quote compilation and the trending
 * longform can share the same proven filter graph:
 *   - Blurred backdrop + contained foreground (handles any source aspect ratio)
 *   - Animated crop-pan on the backdrop for motion
 *   - Bottom-anchored HotDrop-style captions with rank numbers
 *   - Crossfade between segments
 *   - Looped BGM with normalized gain, seam-trimmed, fade-out timed to real duration
 *
 * ponytail: this is a lift from the rendering section of longform.js. The two
 * copies will drift unless one calls the other — but exporting a 200-line
 * function from a module that also runs main() at import time is worse than
 * one controlled duplication. Ceiling: the copies diverge. Upgrade path:
 * extract both into a shared module once the longform.js main() is refactored
 * to not run at import time.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const BGM_PATH = join(__dirname, '..', 'assets', 'bgm.mp3');

const W = 1920, H = 1080, FPS = 30, XFADE = 0.6;
const CW = Math.round(W * 1.12 / 2) * 2;
const CH = Math.round(H * 1.12 / 2) * 2;

// Caption constants (HotDrop 16:9 spec)
const CAP_SIZE = 40;
const CAP_LINE_H = Math.round(CAP_SIZE * 1.34);
const CAP_CHARS = 52;
const CAP_MAX_LINES = 2;
const PILL_SIZE = 30;
const PILL_PAD_X = 20;
const PILL_PAD_Y = 9;
const TITLE_SIZE = 42;
const TEXT_LEFT = 96;
const ROW_BOTTOM = 210;
const BAND_BOTTOM = 40;

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
];
const FONT = FONT_CANDIDATES.find(f => existsSync(f)) || null;

function escapeFilterPath(p) {
  return resolve(p).replace(/\\/g, '/').replace(/:/g, '\\\\:');
}

function wrapText(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/);
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

function captionBlocks(text) {
  const lines = wrapText(text, CAP_CHARS);
  const blocks = [];
  for (let i = 0; i < lines.length; i += CAP_MAX_LINES) {
    blocks.push(lines.slice(i, i + CAP_MAX_LINES));
  }
  return blocks;
}

function drawCaptionBlock({ lines, dir, tag, enable }) {
  const bandBottom = H - BAND_BOTTOM;
  return lines.map((text, n) => {
    const file = join(dir, `${tag}-${n}.txt`);
    writeFileSync(file, text, 'utf-8');
    const y = bandBottom - (lines.length - n) * CAP_LINE_H;
    let f = `drawtext=textfile=${escapeFilterPath(file)}`
      + `:fontsize=${CAP_SIZE}:fontcolor=white`
      + `:shadowx=0:shadowy=2:shadowcolor=black@0.55`
      + `:box=1:boxcolor=0x07090c@0.78:boxborderw=3|18`
      + `:x=(w-text_w)/2:y=${y}`;
    if (FONT) f += `:fontfile=${escapeFilterPath(FONT)}`;
    if (enable) f += `:enable='${enable}'`;
    return f;
  });
}

function drawRankPill({ number, title, dir, tag }) {
  const parts = [];
  const rowY = H - ROW_BOTTOM;

  let pill = `drawtext=text=${number}.`
    + `:fontsize=${PILL_SIZE}:fontcolor=white`
    + `:box=1:boxcolor=0xff6600@1:boxborderw=${PILL_PAD_Y}|${PILL_PAD_X}`
    + `:x=${TEXT_LEFT}:y=${rowY}`;
  if (FONT) pill += `:fontfile=${escapeFilterPath(FONT)}`;
  parts.push(pill);

  if (title) {
    const file = join(dir, `${tag}-title.txt`);
    writeFileSync(file, String(title).slice(0, 46), 'utf-8');
    let t = `drawtext=textfile=${escapeFilterPath(file)}`
      + `:fontsize=${TITLE_SIZE}:fontcolor=white`
      + `:shadowx=0:shadowy=2:shadowcolor=black@0.7`
      + `:x=${TEXT_LEFT + PILL_SIZE + PILL_PAD_X * 2 + 20}:y=${rowY - Math.round((TITLE_SIZE - PILL_SIZE) / 2)}`;
    if (FONT) t += `:fontfile=${escapeFilterPath(FONT)}`;
    parts.push(t);
  }
  return parts;
}

/**
 * Render a long-form trending video.
 *
 * @param {Array} segments - [{audioPath, imagePath, duration, type, caption, quoteNumber, character, anime}]
 * @param {string} outputPath
 * @param {object} topic - {title, anime, type}
 */
export async function renderLongformTrending(segments, outputPath, topic) {
  const workDir = dirname(resolve(outputPath));
  const inputs = [];
  const filterParts = [];
  const audioParts = [];
  let idx = 0;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const dur = s.duration || 8;
    const hold = dur + XFADE;

    inputs.push('-loop', '1', '-t', hold.toFixed(2), '-i', resolve(s.imagePath));
    inputs.push('-i', resolve(s.audioPath));

    // Blurred backdrop + contained foreground + pan
    const slackX = CW - W;
    const slackY = CH - H;
    const prog = `min(t/${hold.toFixed(2)},1)`;
    const dir = i % 3;
    const panX = dir === 0 ? `${slackX}*${prog}`
      : dir === 1 ? `${slackX}*(1-${prog})` : `${slackX}/2`;
    const panY = dir === 0 ? `${slackY}*(1-${prog})`
      : dir === 1 ? `${slackY}*${prog}` : `${slackY}*${prog}`;

    filterParts.push(`[${idx}:v]format=yuv420p,fps=${FPS},split=2[bgsrc${i}][fgsrc${i}]`);
    filterParts.push(
      `[bgsrc${i}]scale=${CW}:${CH}:force_original_aspect_ratio=increase:flags=bilinear,`
      + `crop=${CW}:${CH},crop=${W}:${H}:x='${panX}':y='${panY}',`
      + `boxblur=26:2,eq=brightness=-0.12:saturation=0.85[bg${i}]`
    );
    filterParts.push(
      `[fgsrc${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg${i}]`
    );

    // Compose + scrim + captions
    const draws = [];

    // Rank pill (only for numbered entries)
    if (s.quoteNumber) {
      const title = [s.anime, s.character].filter(Boolean).join(' — ') || topic.anime || '';
      draws.push(...drawRankPill({ number: s.quoteNumber, title, dir: workDir, tag: `rank-${i}` }));
    }

    // Caption text
    const caption = (s.caption || '').trim();
    if (caption) {
      const blocks = captionBlocks(caption);
      const share = hold / blocks.length;
      blocks.forEach((lines, b) => {
        const enable = blocks.length === 1 ? null
          : `between(t,${(b * share).toFixed(2)},${((b + 1) * share).toFixed(2)})`;
        draws.push(...drawCaptionBlock({ lines, dir: workDir, tag: `cap-${i}-${b}`, enable }));
      });
    }

    const drawChain = draws.length ? ',' + draws.join(',') : '';
    filterParts.push(
      `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2:format=auto,`
      + `eq=contrast=1.05:saturation=1.02,`
      + `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.34:t=fill,`
      + `setsar=1,setpts=PTS-STARTPTS${drawChain}[v${i}]`
    );

    audioParts.push(`[${idx + 1}:a]`);
    idx += 2;
  }

  // Crossfade
  if (segments.length === 1) {
    filterParts.push(`[v0]null[vout]`);
  } else {
    let prev = 'v0';
    let offset = (segments[0].duration || 8) - XFADE;
    for (let i = 1; i < segments.length; i++) {
      const out = i === segments.length - 1 ? 'vout' : `xf${i - 1}`;
      filterParts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(2)}[${out}]`);
      prev = out;
      offset += (segments[i].duration || 8) - XFADE;
    }
  }

  // BGM — looped, seam-trimmed, gain-normalized
  const hasBGM = existsSync(BGM_PATH);
  if (hasBGM) inputs.push('-i', BGM_PATH);

  filterParts.push(`${audioParts.join('')}concat=n=${segments.length}:v=0:a=1[voice]`);

  if (hasBGM) {
    const realDuration = segments.reduce((n, s) => n + (s.duration || 8), 0)
      - XFADE * Math.max(0, segments.length - 1);
    const BGM_LOOP_IN = 3.0;
    const BGM_LOOP_OUT = 26.0;
    const BGM_GAIN_DB = 8;
    const loopBody = BGM_LOOP_OUT - BGM_LOOP_IN;
    const loopCount = Math.ceil(realDuration / loopBody);
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

  console.log(`   Rendering ${segments.length} segments (16:9, trending longform)...`);
  await execFileAsync('ffmpeg', args, { timeout: 900000, maxBuffer: 20 * 1024 * 1024 });

  if (!existsSync(resolve(outputPath))) throw new Error(`No output at ${outputPath}`);
  return outputPath;
}
