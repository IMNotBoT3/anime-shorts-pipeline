/**
 * Render an anime Short with:
 *   1. Ken Burns zoom on each scene image
 *   2. Word-by-word captions burned into the video (bottom third)
 *   3. BGM mixed under the voiceover at low volume
 *
 * Uses ffmpeg filter_complex. Output: 1080x1920 vertical mp4.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const BGM_PATH = join(__dirname, '..', 'assets', 'bgm.mp3');
const WIDTH = 1080;
const HEIGHT = 1920;

// Font for captions — use a common font available on Ubuntu CI runners
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_FALLBACK = 'DejaVu Sans Bold';

/**
 * Escape text for ffmpeg drawtext filter.
 * Must escape: single quotes, colons, backslashes, semicolons.
 */
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "\u2019")  // replace apostrophe with unicode right single quote
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

  // Determine if we have a usable font file
  const fontFile = existsSync(FONT) ? FONT : '';
  const fontSpec = fontFile
    ? `fontfile=${fontFile}` 
    : `font='${FONT_FALLBACK}'`;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const dur = s.duration || 8;
    const frames = Math.ceil(dur * 30);

    // Image input looped for scene duration
    inputs.push('-loop', '1', '-t', String(dur.toFixed(2)), '-i', s.imagePath);
    // Audio input
    inputs.push('-i', s.audioPath);

    // 1) Ken Burns with ALTERNATING directions to prevent visual monotony
    const zoomX = i === 0 ? 'iw/2-(iw/zoom/2)'
      : i === 1 ? 'iw/4-(iw/zoom/4)'
        : '3*iw/4-(3*iw/zoom/4)';
    const zoomY = i === 0 ? 'ih/2-(ih/zoom/2)'
      : i === 1 ? 'ih/4-(ih/zoom/4)'
        : '3*ih/4-(3*ih/zoom/4)';

    filterParts.push(
      `[${idx}:v]format=yuv420p,scale=1440:2560,`
      + `zoompan=z='min(zoom+0.0004,1.08)'`
      + `:x='${zoomX}':y='${zoomY}'`
      + `:d=${frames}:s=720x1280:fps=30,`
      + `scale=${WIDTH}:${HEIGHT}:flags=lanczos,setsar=1`
      + `[zoom${i}]`
    );

    // 2) Caption overlay — narration text with bold hook text for scene 1
    const caption = escapeDrawtext(s.narration || '');
    if (caption) {
      // Scene 1 gets the hook as LARGE text in the first 2 seconds, then fades to normal caption
      const isHookScene = (i === 0);
      const hookWords = isHookScene
        ? escapeDrawtext((s.narration || '').split(/[.!?—]/)[0] || '') // first sentence
        : '';

      let drawFilters = '';
      if (isHookScene && hookWords) {
        // Big bold hook text (top third) — visible in first 2 seconds
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
      // Normal caption (bottom third) — full narration
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

      filterParts.push(`[zoom${i}]${drawFilters}[v${i}]`);
    } else {
      filterParts.push(`[zoom${i}]null[v${i}]`);
    }

    audioParts.push(`[${idx + 1}:a]`);
    idx += 2;
  }

  // 3) BGM input — copy to output dir to avoid path issues
  const hasBGM = existsSync(BGM_PATH);
  if (hasBGM) {
    inputs.push('-i', BGM_PATH);
  }

  // Concat all video segments
  const vLabels = scenes.map((_, i) => `[v${i}]`).join('');
  filterParts.push(`${vLabels}concat=n=${scenes.length}:v=1:a=0[vout]`);

  // Concat all audio segments
  const aLabels = audioParts.join('');
  filterParts.push(`${aLabels}concat=n=${scenes.length}:v=0:a=1[voice]`);

  // 3) BGM with emotional swell — louder at the quote scene, quieter elsewhere
  //    This creates an unconscious "pay attention" cue at the emotional peak.
  if (hasBGM) {
    // Calculate when scene 2 (the quote) starts — that's where the swell peaks
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

  console.log(`   Rendering ${scenes.length} scenes with zoom + captions + BGM...`);

  try {
    await execFileAsync('ffmpeg', args, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
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
