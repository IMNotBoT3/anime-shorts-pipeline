/**
 * Render an anime Short:
 *   1. Images scaled to FILL the 1080x1920 frame (crop overflow, never letterbox)
 *   2. Slow pan across the image for motion (cheap alternative to zoompan)
 *   3. Wrapped captions burned in via drawtext textfile=
 *   4. BGM mixed under the voiceover
 *
 * ponytail: motion is a crop-window pan, not zoompan. zoompan rescales every
 * frame at high res and took 16min on CI runners for a 22s video; an animated
 * crop is a windowed copy and costs almost nothing. Ceiling: pan only, no true
 * zoom. Upgrade path: swap the crop chain for zoompan if GPU runners land.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const BGM_PATH = join(__dirname, '..', 'assets', 'bgm.mp3');
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

// Oversize canvas the pan window travels across. 1.12x gives ~130px of
// horizontal and ~230px of vertical slack — enough drift to read as motion
// without the crop window ever leaving the image.
const OVER = 1.12;
const CANVAS_W = Math.round(WIDTH * OVER / 2) * 2;   // even numbers for yuv420p
const CANVAS_H = Math.round(HEIGHT * OVER / 2) * 2;

const XFADE_DUR = 0.5;

/**
 * First bold font that actually exists on this machine. Without a real fontfile
 * ffmpeg silently falls back to a monospace terminal face, which is what made
 * the captions look like a debug overlay.
 */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',            // Ubuntu CI
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',                                    // local dev
  'C:/Windows/Fonts/arialbd.ttf',
];
const FONT = FONT_CANDIDATES.find((f) => existsSync(f)) || null;

const USABLE_W = WIDTH - 120; // 60px margin each side

/**
 * Greedy word wrap. drawtext has no auto-wrap, so unwrapped narration ran off
 * both edges of the frame.
 */
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

/** Chars that fit on one line at a given size, for a bold sans face. */
function charsPerLine(fontSize) {
  return Math.max(12, Math.floor(USABLE_W / (fontSize * 0.55)));
}

/**
 * Escape a filesystem path for use inside an ffmpeg filter graph.
 * A Windows drive colon needs a doubled backslash to survive both the filter
 * parser and the option tokenizer; single-escaping fails. Linux paths contain
 * no colon, so the same rule is a no-op there.
 */
function escapeFilterPath(p) {
  return resolve(p).replace(/\\/g, '/').replace(/:/g, '\\\\:');
}

/**
 * Build one drawtext per wrapped line.
 *
 * ponytail: one filter per line instead of a single newline-separated textfile.
 * A newline inside the textfile renders as a tofu glyph in ffmpeg 8.x, and
 * per-line filters additionally let each line be centred on its own width.
 * Ceiling: ~6 filters per scene. Upgrade path: switch to ASS subtitles if the
 * caption design ever needs italics, karaoke timing, or per-word highlighting.
 */
function drawLines({ lines, dir, tag, fontSize, centerY, boxAlpha, enable }) {
  const lineH = Math.round(fontSize * 1.34);
  const blockH = lineH * lines.length;
  const parts = [];

  lines.forEach((text, n) => {
    const file = join(dir, `${tag}-${n}.txt`);
    writeFileSync(file, text, 'utf-8');

    // Stack lines around the requested centre.
    const y = `${centerY}-${Math.round(blockH / 2)}+${n * lineH}`;

    let f = `drawtext=textfile=${escapeFilterPath(file)}`
      + `:fontsize=${fontSize}`
      + `:fontcolor=white`
      + `:borderw=4:bordercolor=black@0.95`
      + `:shadowx=0:shadowy=3:shadowcolor=black@0.6`
      + `:box=1:boxcolor=black@${boxAlpha}:boxborderw=16`
      + `:x=(w-text_w)/2`
      + `:y=${y}`;
    if (FONT) f += `:fontfile=${escapeFilterPath(FONT)}`;
    if (enable) f += `:enable='${enable}'`;
    parts.push(f);
  });

  return parts;
}

/**
 * @param {Array} scenes - [{imagePath, audioPath, duration, narration}]
 * @param {string} outputPath - mp4 destination
 */
export async function renderVideo(scenes, outputPath) {
  const workDir = dirname(resolve(outputPath));
  const inputs = [];
  const filterParts = [];
  const audioParts = [];
  let idx = 0;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const dur = s.duration || 8;
    // Each clip is held slightly longer so the crossfade has material to chew.
    const hold = dur + XFADE_DUR;

    inputs.push('-loop', '1', '-t', hold.toFixed(2), '-i', resolve(s.imagePath));
    inputs.push('-i', resolve(s.audioPath));

    // Fill the frame: upscale so the image covers the oversize canvas, then
    // crop the overflow. `increase` + crop never letterboxes and never
    // distorts; the previous `decrease` + pad is what produced black bars.
    const slackX = CANVAS_W - WIDTH;
    const slackY = CANVAS_H - HEIGHT;

    // Alternate pan direction per scene so a 3-scene Short doesn't feel like
    // the same move three times.
    const dir = i % 3;
    const prog = `min(t/${hold.toFixed(2)},1)`; // 0..1 across the clip
    const panX = dir === 0 ? `${slackX}*${prog}`
      : dir === 1 ? `${slackX}*(1-${prog})`
        : `${slackX}/2`;
    const panY = dir === 0 ? `${slackY}*(1-${prog})`
      : dir === 1 ? `${slackY}*${prog}`
        : `${slackY}*${prog}`;

    filterParts.push(
      `[${idx}:v]format=yuv420p,fps=${FPS},`
      + `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase:flags=lanczos,`
      + `crop=${CANVAS_W}:${CANVAS_H},`
      + `crop=${WIDTH}:${HEIGHT}:x='${panX}':y='${panY}',`
      // Wallpapers range from near-black to bright poster art. A fixed scrim
      // plus a mild grade keeps white captions legible on all of them and stops
      // the mood flipping between scenes.
      + `eq=contrast=1.06:saturation=1.03,`
      + `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.42:t=fill,`
      + `setsar=1,setpts=PTS-STARTPTS[img${i}]`
    );

    // Captions written to files: no quote/colon/percent escaping to get wrong.
    const narration = (s.narration || '').trim();
    if (narration) {
      const draws = [];
      const isQuoteScene = (i === 1);

      if (isQuoteScene) {
        // The quote is the emotional core — give it the whole middle of the
        // frame at a larger size instead of burying it in the lower third.
        const size = narration.length > 150 ? 44 : 52;
        draws.push(...drawLines({
          lines: wrapText(narration, charsPerLine(size)),
          dir: workDir, tag: `cap-${i}`, fontSize: size,
          centerY: 'h*0.50', boxAlpha: '0.55',
        }));
      } else {
        // Scene 0 opens with its first sentence as a large hook. The rest of
        // the narration becomes the lower-third caption — the hook sentence is
        // removed from it so the same words never appear twice at once.
        let body = narration;
        let hasHook = false;

        if (i === 0) {
          const hook = narration.split(/(?<=[.!?])\s+/)[0]?.trim();
          if (hook && hook.length < narration.length) {
            body = narration.slice(hook.length).trim();
            hasHook = true;
            draws.push(...drawLines({
              lines: wrapText(hook, charsPerLine(58)),
              dir: workDir, tag: `hook-${i}`, fontSize: 58,
              centerY: 'h*0.30', boxAlpha: '0.70',
              enable: 'between(t,0.3,4)',
            }));
          }
        }

        if (body) {
          draws.push(...drawLines({
            lines: wrapText(body, charsPerLine(40)),
            dir: workDir, tag: `cap-${i}`, fontSize: 40,
            centerY: 'h*0.72', boxAlpha: '0.55',
            // Hold the lower caption back until the hook has cleared.
            enable: hasHook ? 'gte(t,4)' : undefined,
          }));
        }
      }

      filterParts.push(`[img${i}]${draws.join(',')}[v${i}]`);
    } else {
      filterParts.push(`[img${i}]null[v${i}]`);
    }

    audioParts.push(`[${idx + 1}:a]`);
    idx += 2;
  }

  // Crossfade the clips into one track.
  if (scenes.length === 1) {
    filterParts.push(`[v0]null[vout]`);
  } else {
    let prev = 'v0';
    let offset = (scenes[0].duration || 8) - XFADE_DUR;
    for (let i = 1; i < scenes.length; i++) {
      const out = i === scenes.length - 1 ? 'vout' : `xf${i - 1}`;
      filterParts.push(
        `[${prev}][v${i}]xfade=transition=fade:duration=${XFADE_DUR}:offset=${offset.toFixed(2)}[${out}]`
      );
      prev = out;
      offset += (scenes[i].duration || 8) - XFADE_DUR;
    }
  }

  const hasBGM = existsSync(BGM_PATH);
  if (hasBGM) inputs.push('-i', BGM_PATH);

  filterParts.push(`${audioParts.join('')}concat=n=${scenes.length}:v=0:a=1[voice]`);

  if (hasBGM) {
    const s2Start = scenes[0]?.duration || 10;
    const s2End = s2Start + (scenes[1]?.duration || 10);
    const bgmEnd = s2End + 5;

    // Three things here are load-bearing; do not drop them:
    //
    // 1. `aloop` — assets/bgm.mp3 is only 30s. A 3-scene Short already exceeds
    //    that, so without looping the bed simply stops partway through. atrim
    //    caps the infinite loop so the graph still terminates.
    // 2. `loudnorm` — bgm.mp3 ships mastered ~30dB too quiet (RMS -46.6 dBFS).
    //    Normalising first makes the dB offsets below source-independent, so
    //    they keep working if the asset is ever replaced with a proper master.
    //    A bare multiplier would silently blow up or vanish on a new file.
    // 3. `normalize=0` on amix — amix DIVIDES every input by the input count
    //    unless told otherwise. With two inputs that is -6.02dB off BOTH the
    //    bed and the narration, i.e. the old code made the whole video 6dB
    //    quieter while adding nothing audible. Removing normalize=0 puts the
    //    bed back under the AAC noise floor and re-quiets the voice.
    //
    // -22dB base / -16dB under the quote scene keeps the 6dB emotional swell
    // the old 0.10 -> 0.22 pair encoded, landing the bed ~14dB under narration.
    //
    // ponytail: BGM loop-seam fix. bgm.mp3 is 30.00s with a baked-in fade-out
    // starting ~26s. Without trimming, aloop splices that decay onto the start,
    // causing -68.8 dBFS dips at every 30s loop point. The naive fix (atrim
    // before aloop) still fails because loudnorm's adaptive gain rider reacts
    // to the sample-level discontinuity at the aloop splice with a ~20dB dip.
    // The working fix: run loudnorm on the full 26s flat segment, then discard
    // the first/last 2s (where loudnorm has start/end boundary transients),
    // yielding a clean 22s normalized segment. aloop then loops that seamlessly
    // — loudnorm never sees the splice, and the splice has no discontinuity.
    // Ceiling: 22s loop length. Upgrade path: replace bgm.mp3 with a properly
    // mastered seamless loop file; remove the atrim/loudnorm/interior-trim.
    const BGM_TRIM_END = 26.0;     // where the baked-in fade starts
    const BGM_INTERIOR_START = 2;  // discard loudnorm's start-of-stream ramp
    const BGM_INTERIOR_END = 24;   // discard loudnorm's end-of-stream ramp
    filterParts.push(
      `[${idx}:a]atrim=0:${BGM_TRIM_END.toFixed(2)},asetpts=N/SR/TB,`
      + `loudnorm=I=-16:TP=-1.5:LRA=11,`
      + `atrim=${BGM_INTERIOR_START}:${BGM_INTERIOR_END},asetpts=N/SR/TB,`
      + `aloop=loop=-1:size=2147483647,atrim=0:${(bgmEnd + 5).toFixed(2)},`
      + `volume='if(between(t,${s2Start},${s2End}),-16dB,-22dB)':eval=frame,`
      + `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, bgmEnd)}:d=5[bgm]`
    );
    filterParts.push(`[voice][bgm]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[aout]`);
  } else {
    filterParts.push(`[voice]anull[aout]`);
  }

  const args = [
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-r', String(FPS), '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-shortest', '-y', resolve(outputPath),
  ];

  console.log(`   Rendering ${scenes.length} scenes (fill-frame + pan + captions)...`);

  try {
    await execFileAsync('ffmpeg', args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const stderr = err.stderr || '';
    const msg = stderr.slice(-1200) || err.message?.slice(-500) || 'unknown error';
    throw new Error(`ffmpeg render failed: ${msg}`);
  }

  if (!existsSync(resolve(outputPath))) {
    throw new Error(`No output at ${outputPath}`);
  }

  return outputPath;
}
