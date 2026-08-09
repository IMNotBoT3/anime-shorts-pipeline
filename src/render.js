/**
 * Render a Short from scenes (images + audio) + BGM into a single mp4.
 * Uses ffmpeg directly — no HyperFrames needed for v1.
 *
 * Each scene: image held for its audio duration with Ken Burns zoom.
 * BGM mixed underneath at low volume. Output: 1080x1920 vertical mp4.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const BGM_PATH = join(__dirname, '..', 'assets', 'bgm.mp3');
const WIDTH = 1080;
const HEIGHT = 1920;

/**
 * @param {Array} scenes - [{imagePath, audioPath, duration}]
 * @param {string} outputPath - mp4 destination
 */
export async function renderVideo(scenes, outputPath) {
  const inputs = [];
  const filterParts = [];
  const audioParts = [];
  let idx = 0;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const dur = s.duration || 8;

    // Image input looped for scene duration
    inputs.push('-loop', '1', '-t', String(Math.ceil(dur)), '-i', s.imagePath);
    // Audio input
    inputs.push('-i', s.audioPath);

    // Ken Burns zoom on the image
    const frames = Math.ceil(dur * 30);
    filterParts.push(
      `[${idx}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,`
      + `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x1a1a2e,`
      + `setsar=1[v${i}]`
    );

    audioParts.push(`[${idx + 1}:a]`);
    idx += 2;
  }

  // BGM
  const hasBGM = existsSync(BGM_PATH);
  if (hasBGM) inputs.push('-i', BGM_PATH);

  // Concat all video segments
  const vLabels = scenes.map((_, i) => `[v${i}]`).join('');
  filterParts.push(`${vLabels}concat=n=${scenes.length}:v=1:a=0[vout]`);

  // Concat all audio segments
  const aLabels = audioParts.join('');
  filterParts.push(`${aLabels}concat=n=${scenes.length}:v=0:a=1[voice]`);

  // Mix BGM under voice
  if (hasBGM) {
    filterParts.push(`[${idx}:a]volume=0.12[bgm]`);
    filterParts.push(`[voice][bgm]amix=inputs=2:duration=first[aout]`);
  } else {
    filterParts.push(`[voice]acopy[aout]`);
  }

  const args = [
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-shortest', '-y', outputPath,
  ];

  try {
    await execFileAsync('ffmpeg', args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const stderr = err.stderr || '';
    const msg = stderr.slice(-800) || err.message?.slice(-400) || 'unknown error';
    throw new Error(`ffmpeg render failed: ${msg}`);
  }

  if (!existsSync(outputPath)) {
    throw new Error(`No output at ${outputPath}`);
  }

  return outputPath;
}
