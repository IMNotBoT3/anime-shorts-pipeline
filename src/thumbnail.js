/**
 * Render a YouTube thumbnail for the long-form compilations via HyperFrames.
 *
 * Why HyperFrames here and not ffmpeg: a thumbnail is one frame of pure
 * typography, and ffmpeg's drawtext has no wrapping, no web fonts, no
 * gradients, and no layout — the caption work in render.js had to hand-roll all
 * of it. Chromium gives real text layout for a single screenshot, so the cost
 * that rules HyperFrames out for a 3-minute video (per-frame browser capture)
 * does not apply to one still.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAllImages } from './fetch-images.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const PROJECT_DIR = join(__dirname, '..', 'thumbnail');
// The template lives outside the HyperFrames project on purpose: any root-level
// HTML carrying data-composition-id is discovered as a second entry point and
// fails `hyperframes check` with multiple_root_compositions.
const TEMPLATE = join(__dirname, 'thumbnail-template.html');
const WIDTH = 1280;
const HEIGHT = 720;

// YouTube rejects thumbnails over 2MB.
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Break a theme into 1-3 uppercase lines and pick a size that fits the plate.
 * The plate is 700px wide minus the 37px rule and padding, and the face is
 * heavy, so roughly 0.62em per character is the usable budget.
 */
function layoutTitle(theme) {
  const words = String(theme).trim().toUpperCase().split(/\s+/).filter(Boolean);
  const maxLines = words.length >= 4 ? 3 : 2;

  // Greedy balance: aim for lines of similar length.
  const targetPerLine = Math.ceil(words.join(' ').length / maxLines);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= targetPerLine || lines.length === maxLines - 1) {
      line += ' ' + w;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);

  const longest = Math.max(...lines.map((l) => l.length), 1);
  // Plate is 760px wide, less the 7px rule and 30px padding, so ~723px is
  // usable. Montserrat Black uppercase runs about 0.75em per character — a
  // lower estimate lets a line exceed the plate, and with nowrap it would
  // spill over the artwork instead of wrapping.
  const size = Math.max(46, Math.min(96, Math.floor(723 / (longest * 0.75))));

  return { lines, size };
}

/**
 * Minimal HTML escape. Theme text is model-generated, so it reaches the DOM as
 * untrusted input and must not be able to inject markup.
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build the thumbnail and return the path to an upload-ready JPEG.
 *
 * @param {object} opts
 * @param {string} opts.theme      - compilation theme, becomes the title
 * @param {number} opts.quoteCount - drives the badge
 * @param {string} opts.anime      - used to source on-topic art
 * @param {string} opts.outDir     - where to leave the finished jpg
 */
export async function buildThumbnail({ theme, quoteCount, anime, outDir }) {
  if (!existsSync(TEMPLATE)) throw new Error(`Thumbnail template missing: ${TEMPLATE}`);
  mkdirSync(outDir, { recursive: true });

  // 1. Background art. Reuses the Wallhaven-first fetcher so the thumbnail is
  //    on-topic instead of stock photography.
  const assetsDir = join(PROJECT_DIR, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const [art] = await fetchAllImages(
    [{ anime, imageQuery: `${anime || 'anime'} cinematic dramatic` }],
    assetsDir
  );
  if (!art) throw new Error('No background art for thumbnail');

  // fetchAllImages names files scene-0.jpg; the composition refers to it by a
  // stable relative path so the render is reproducible.
  const bgRel = 'assets/scene-0.jpg';

  // 2. Fill the template.
  const { lines, size } = layoutTitle(theme || 'Anime Quotes');
  const html = readFileSync(TEMPLATE, 'utf-8')
    .replace('{{BG}}', bgRel)
    .replace('{{TITLE_SIZE}}', String(size))
    .replace('{{TITLE_LINES}}', lines.map((l) => `<div class="line">${esc(l)}</div>`).join(''))
    .replace('{{EYEBROW}}', esc('Anime Resonance'))
    .replace('{{BADGE}}', esc(`${quoteCount || 5} Quotes`));

  writeFileSync(join(PROJECT_DIR, 'index.html'), html, 'utf-8');

  // 3. Screenshot frame 0.
  const snapDir = join(PROJECT_DIR, 'snapshots');
  rmSync(snapDir, { recursive: true, force: true });

  // Run the CLI's JS entry with the current node binary. Node 24 refuses to
  // spawn the npx .cmd shim without a shell, and enabling a shell would pass
  // these args through unescaped — this avoids both, and pins the version.
  const cli = join(__dirname, '..', 'node_modules', 'hyperframes', 'dist', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error(`hyperframes CLI not found at ${cli} — run: npm install`);
  }

  await execFileAsync(process.execPath, [
    cli, 'snapshot', PROJECT_DIR,
    '--at', '0', '--no-end', '--output', snapDir,
  ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });

  const png = readdirSync(snapDir).filter((f) => f.endsWith('.png')).map((f) => join(snapDir, f))[0];
  if (!png) throw new Error('hyperframes snapshot produced no PNG');

  // 4. PNG of detailed anime art can exceed YouTube's 2MB ceiling, so hand over
  //    a JPEG at a size that is always accepted.
  const jpg = join(outDir, 'thumbnail.jpg');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', resolve(png),
    '-vf', `scale=${WIDTH}:${HEIGHT}`,
    '-q:v', '3', '-y', resolve(jpg),
  ], { timeout: 60000 });

  if (!existsSync(jpg)) throw new Error('thumbnail jpeg not produced');
  const bytes = statSync(jpg).size;
  if (bytes > MAX_BYTES) {
    // Re-encode harder rather than letting the upload fail.
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-i', resolve(png), '-vf', `scale=${WIDTH}:${HEIGHT}`,
      '-q:v', '7', '-y', resolve(jpg)], { timeout: 60000 });
  }

  console.log(`   Thumbnail: ${lines.join(' / ')} (${size}px, ${(statSync(jpg).size / 1024).toFixed(0)} KB)`);
  return jpg;
}
