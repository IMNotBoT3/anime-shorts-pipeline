/**
 * Render an anime Short with:
 *   1. Scaled images with crossfade transitions between scenes
 *   2. Word-by-word captions burned into the video (bottom third)
 *   3. BGM mixed under the voiceover at low volume
 *
 * Uses ffmpeg filter_complex. Output: 1080x1920 vertical mp4.
 *
 * ponytail: replaced zoompan (16min on CI for 22s) with scale+xfade (< 1min).
 * Upgrade path: re-enable zoompan when self-hosted GPU runners are available.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const BGM_PATH = join(__dirname, '..', 'assets', 'bgm.mp3');
const WIDTH = 1080;
const HEIGHT = 1920;

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_FALLBACK = 'DejaVu Sans Bold';

/**
 * Escape text for ffmpeg drawtext filter.
 */
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "\u2019")
    .replace(/:/g, '\\:')
    .replace(/;/g, '\\;')
    .replace(/%/g, '%%');
}

/**
 * @param {Array} scenes - [{imagePath, audioPath, duration, narration}]
 * @param {string} outputPath - mp4 destination
 */
export async function renderVideo(scenes, outputPath) {
  const inputs = [];
  const filterParts = [];
  const audioParts = [];
  let idx = 0;

  const fontFile = existsSync(FONT) ? FONT : '';
  const fontSpec = fontFile
    ? `fontfile=${fontFile}`
    : `font='${FONT_FALLBACK}'`;

  const XFADE_DUR = 0.5; // crossfade duration between scenes

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const dur = s.duration || 8;

    // Image input looped for scene duration (+ xfade overlap)
    inputs.push('-loop', '1', '-t', String((dur + XFADE_DUR).toFixed(2)), '-i', resolve(s.imagePath));
    // Audio input
    inputs.push('-i', resolve(s.audioPath));

    // Scale image to output size (fast, no zoompan)
    filterParts.push(
      `[${idx}:v]format=yuv420p,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,`
      + `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,`
      + `trim=duration=${(dur + XFADE_DUR).toFixed(2)},setpts=PTS-STARTPTS[img${i}]`
    );

    // Caption overlay
    const caption = escapeDrawtext(s.narration || '');
    if (caption) {
      const isHookScene = (i === 0);
      const hookWords = isHookScene
        ? escapeDrawtext((s.narration || '').split(/[.!?—]/)[0] || '')
        : '';

      let drawFilters = '';
      if (isHookScene && hookWords) {
        drawFilters += `drawtext=`
          + `${fontSpec}:`
          + `text='${hookWords}':`
          + `fontsize=56:`
          + `fontcolor=white:`
          + `borderw=4:`
          + `bordercolor=black:`
          + `box=1:`
          + `boxcolor=black@0.7:`
          + `boxborderw=25:`
          + `x=(w-text_w)/2:`
          + `y=h/4-text_h/2:`
          + `line_spacing=12:`
          + `enable='between(t,0,4)',`;
      }
      drawFilters += `drawtext=`
        + `${fontSpec}:`
        + `text='${caption}':`
        + `fontsize=38:`
        + `fontcolor=white:`
        + `borderw=3:`
        + `bordercolor=black:`
        + `box=1:`
        + `boxcolor=black@0.5:`
        + `boxborderw=18:`
        + `x=(w-text_w)/2:`
        + `y=h-h/5-text_h/2:`
        + `line_spacing=8`;

      filterParts.push(`[img${i}]${drawFilters}[v${i}]`);
    } else {
      filterParts.push(`[img${i}]null[v${i}]`);
    }

    audioParts.push(`[${idx + 1}:a]`);
    idx += 2;
  }

  // Crossfade video segments together
  if (scenes.length === 1) {
    filterParts.push(`[v0]null[vout]`);
  } else {
    // Chain xfade: v0 x v1 -> xf0, xf0 x v2 -> xf1, etc.
    let prevLabel = 'v0';
    let offset = (scenes[0].duration || 8) - XFADE_DUR;
    for (let i = 1; i < scenes.length; i++) {
      const outLabel = i === scenes.length - 1 ? 'vout' : `xf${i - 1}`;
      filterParts.push(
        `[${prevLabel}][v${i}]xfade=transition=fade:duration=${XFADE_DUR}:offset=${offset.toFixed(2)}[${outLabel}]`
      );
      prevLabel = outLabel;
      offset += (scenes[i].duration || 8) - XFADE_DUR;
    }
  }

  // BGM input
  const hasBGM = existsSync(BGM_PATH);
  if (hasBGM) {
    inputs.push('-i', BGM_PATH);
  }

  // Concat all audio segments
  const aLabels = audioParts.join('');
  filterParts.push(`${aLabels}concat=n=${scenes.length}:v=0:a=1[voice]`);

  // BGM mix
  if (hasBGM) {
    const scene1Dur = scenes[0]?.duration || 10;
    const scene2Start = scene1Dur;
    const scene2End = scene1Dur + (scenes[1]?.duration || 10);

    filterParts.push(
      `[${idx}:a]volume='if(between(t,${scene2Start},${scene2End}),0.22,0.10)'`
      + `:eval=frame,`
      + `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, scene2End + 5)}:d=5[bgm]`
    );
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

  console.log(`   Rendering ${scenes.length} scenes with crossfade + captions + BGM...`);

  try {
    await execFileAsync('ffmpeg', args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const stderr = err.stderr || '';
    const msg = stderr.slice(-1000) || err.message?.slice(-500) || 'unknown error';
    throw new Error(`ffmpeg render failed: ${msg}`);
  }

  if (!existsSync(outputPath)) {
    throw new Error(`No output at ${outputPath}`);
  }

  return outputPath;
}
