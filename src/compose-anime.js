/**
 * HyperFrames composition for Anime Resonance Shorts.
 *
 * Ported from HotDrop's compose-video.js — same retention-proven mechanics:
 *   - GSAP Ken Burns motion on background images (8 distinct patterns)
 *   - Word-by-word karaoke captions with accent color flash
 *   - Scene crossfades via opacity
 *   - Progress bar (subconsciously signals "almost done", reduces late swipe)
 *   - Film grain + vignette for cinema feel
 *   - Subscriber goal badge (X/100)
 *
 * Key differences from HotDrop:
 *   - Accent color: #e63946 (anime red) instead of #ff6600 (orange)
 *   - Badge text: anime/character context instead of "AI NEWS"
 *   - Font: Inter 900 (same, proven readable at small sizes)
 *   - Bottom watermark: "Anime Resonance" instead of "HotDrop"
 *
 * The composition is an HTML file rendered frame-by-frame by HyperFrames CLI.
 * This is what gives us real animation instead of a panning still image —
 * the difference between 20% retention (current ffmpeg approach) and 50%+.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ACCENT = '#e63946';  // anime red — bold, emotional, stands out on dark art
const CAPTION_OFFSET_SEC = parseFloat(process.env.CAPTION_OFFSET_SEC || '0');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 8 Ken Burns motion patterns — same as HotDrop, proven to keep the eye engaged.
 * Scene 0 always gets the "zoom-reveal" (starts tight, pulls out) because it is
 * the hook — the frame is already moving on the very first rendered pixel.
 */
const MOTION_PATTERNS = [
  { from: { scale: 1.35, x: 0, y: -20 }, to: { scale: 1.0, x: 0, y: 0 } },
  { from: { scale: 1.2, x: -20, y: -15 }, to: { scale: 1.0, x: 10, y: 5 } },
  { from: { scale: 1.08, x: 30, y: 0 }, to: { scale: 1.08, x: -30, y: 0 } },
  { from: { scale: 1.0, x: 0, y: 0 }, to: { scale: 1.22, x: 0, y: -8 } },
  { from: { scale: 1.05, x: 0, y: 20 }, to: { scale: 1.12, x: 0, y: -20 } },
  { from: { scale: 1.25, x: -40, y: -30 }, to: { scale: 1.02, x: 5, y: 5 } },
  { from: { scale: 1.1, x: -25, y: 0 }, to: { scale: 1.1, x: 25, y: 0 } },
  { from: { scale: 1.0, x: 0, y: -15 }, to: { scale: 1.16, x: 10, y: 20 } },
];

/**
 * Build a HyperFrames composition for an anime Short.
 *
 * @param {object} opts
 * @param {Array} opts.scenes - [{narration, duration, imagePath, audioPath, words[]}]
 *   words[]: [{text, start, end}] from transcription (null start = proportional fallback)
 * @param {object} opts.topic - {title, type, anime, character}
 * @param {object} [opts.subGoal] - {count, goal, text} for the subscriber overlay
 * @param {string} opts.outputDir - where to write index.html + copy assets
 * @returns {string} path to the composition directory
 */
export function buildAnimeComposition({ scenes, topic, subGoal, outputDir }) {
  mkdirSync(outputDir, { recursive: true });

  const totalDuration = scenes.reduce((n, s) => n + s.duration, 0);

  // Copy images and audio into the composition directory
  const processedScenes = scenes.map((s, i) => {
    const imgName = `img-${i}.jpg`;
    const audioName = `audio-${i}.mp3`;
    if (s.imagePath && existsSync(s.imagePath)) {
      copyFileSync(s.imagePath, join(outputDir, imgName));
    }
    if (s.audioPath && existsSync(s.audioPath)) {
      copyFileSync(s.audioPath, join(outputDir, audioName));
    }

    // Build start times
    let start = 0;
    for (let j = 0; j < i; j++) start += scenes[j].duration;

    // Tokenize narration into words for karaoke
    const words = s.words || s.narration.split(/\s+/).map(w => ({ text: w, start: null, end: null }));

    return { ...s, start, imgName, audioName, words };
  });

  // Badge text — show anime + character for the first scene, then just anime
  const badgeText = topic.type === 'quote'
    ? `${topic.anime || 'ANIME'}`
    : topic.type === 'ranking'
      ? 'TOP 5'
      : topic.type === 'news'
        ? 'BREAKING'
        : 'ANIME';

  // Build HTML clips
  const clips = processedScenes.map((scene, i) => {
    const words = scene.words.map(w => w.text);
    return `
      <section id="scene-${i}" class="clip" data-start="${scene.start.toFixed(3)}" data-duration="${scene.duration.toFixed(3)}" data-track-index="1">
        <div class="scene-bg" id="bg-${i}" style="background-image: url('${scene.imgName}');"></div>
        <div class="film-grain"></div>
        <div class="vignette"></div>
        <div class="caption" id="caption-${i}">
          ${words.map((word, wi) => `<span class="word" id="w-${i}-${wi}">${escapeHtml(word)}</span>`).join('')}
        </div>
        ${i === 0 ? `<div class="badge" id="badge">${escapeHtml(badgeText)}</div>` : ''}
        <audio src="${scene.audioName}" data-start="${scene.start.toFixed(3)}"></audio>
      </section>`;
  }).join('\n');

  // Build GSAP timeline
  const sceneCount = processedScenes.length;
  const tweens = processedScenes.map((scene, i) => {
    const dur = scene.duration;
    const start = scene.start;
    const tokens = scene.words;
    const timed = tokens.length > 0 && tokens[0].start !== null;
    let code = '';

    // Ken Burns motion
    const pattern = MOTION_PATTERNS[i % MOTION_PATTERNS.length];
    code += `
    tl.fromTo("#bg-${i}",
      { scale: ${pattern.from.scale}, x: ${pattern.from.x}, y: ${pattern.from.y} },
      { scale: ${pattern.to.scale}, x: ${pattern.to.x}, y: ${pattern.to.y}, duration: ${dur.toFixed(2)}, ease: "none" },
      ${start.toFixed(3)});`;

    // Word-by-word karaoke
    let spans;
    if (timed) {
      spans = tokens.map(t => ({
        at: start + t.start + CAPTION_OFFSET_SEC,
        off: start + t.end + CAPTION_OFFSET_SEC,
      }));
    } else {
      const totalChars = tokens.reduce((sum, t) => sum + Math.max(t.text.length, 2), 0);
      const speakingWindow = dur * 0.82;
      const startOffset = dur * 0.08;
      let cumChars = 0;
      spans = tokens.map(t => {
        const len = Math.max(t.text.length, 2);
        const at = start + startOffset + (cumChars / totalChars) * speakingWindow;
        cumChars += len;
        const off = start + startOffset + (cumChars / totalChars) * speakingWindow;
        return { at, off };
      });
    }

    spans.forEach(({ at, off }, wi) => {
      code += `
    tl.fromTo("#w-${i}-${wi}", { opacity: 0, y: 10, color: "${ACCENT}" }, { opacity: 1, y: 0, duration: 0.15, ease: "power2.out" }, ${at.toFixed(3)});
    tl.to("#w-${i}-${wi}", { color: "#ffffff", duration: 0.2 }, ${off.toFixed(3)});`;
    });

    // Scene crossfade
    if (i < sceneCount - 1) {
      code += `
    tl.to("#caption-${i}", { opacity: 0, duration: 0.3, ease: "power2.in" }, ${(start + dur - 0.35).toFixed(3)});
    tl.to("#scene-${i}", { opacity: 0, duration: 0.4, ease: "power1.inOut" }, ${(start + dur - 0.4).toFixed(3)});`;
    }

    return code;
  }).join('\n');

  // Badge animation (slides in from left, exits after 2.5s)
  const badgeTween = `
    tl.fromTo("#badge", { x: -300, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: "power4.out" }, 0.05);
    tl.to("#badge", { x: 300, opacity: 0, duration: 0.35, ease: "power3.in" }, ${Math.min(processedScenes[0].duration - 0.5, 2.5).toFixed(2)});`;

  // Progress bar
  const progressTween = `
    tl.fromTo("#progress-bar", { scaleX: 0 }, { scaleX: 1, duration: ${totalDuration.toFixed(2)}, ease: "none" }, 0);`;

  // Flash on scene transitions
  const flashTweens = processedScenes.slice(0, -1).map((s, i) => `
    tl.to("#flash", { opacity: 0.6, duration: 0.04 }, ${(s.start + s.duration - 0.04).toFixed(3)});
    tl.to("#flash", { opacity: 0, duration: 0.15 }, ${(s.start + s.duration).toFixed(3)});`
  ).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1080, height=1920" />
  <title>Anime Resonance Short</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"><\/script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1080px; height: 1920px; overflow: hidden; background: #0a0a0f; font-family: 'Inter', system-ui, sans-serif; }

    .clip { position: absolute; inset: 0; overflow: hidden; }
    .scene-bg {
      position: absolute; inset: -60px;
      background-size: cover; background-position: center;
      will-change: transform;
      transform-origin: center center;
    }
    .film-grain {
      position: absolute; inset: 0; pointer-events: none; opacity: 0.04;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }
    .vignette {
      position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(ellipse 70% 60% at 50% 45%, transparent 0%, rgba(0,0,0,0.5) 100%);
    }
    .caption {
      position: absolute; bottom: 240px; left: 48px; right: 48px;
      text-align: center; display: flex; flex-wrap: wrap;
      justify-content: center; gap: 5px 8px;
    }
    .word {
      display: inline-block; font-size: 46px; font-weight: 900;
      color: #ffffff; text-transform: uppercase; letter-spacing: -0.5px;
      line-height: 1.25;
      text-shadow: 0 4px 40px rgba(0,0,0,0.95), 0 0 60px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.9);
      opacity: 0; will-change: transform, opacity;
    }
    .badge {
      position: absolute; top: 100px; left: 56px;
      background: ${ACCENT}; color: #fff;
      font-size: 28px; font-weight: 900; padding: 14px 28px;
      border-radius: 10px; letter-spacing: 4px; opacity: 0;
      will-change: transform, opacity;
      box-shadow: 0 8px 32px rgba(230,57,70,0.4);
    }
    .watermark {
      position: absolute; bottom: 56px; left: 0; right: 0;
      text-align: center; font-size: 26px; font-weight: 800;
      color: rgba(255,255,255,0.7); letter-spacing: 4px;
      text-transform: uppercase;
      text-shadow: 0 2px 16px rgba(0,0,0,0.9);
      z-index: 50;
    }
    .sub-goal {
      position: absolute; top: 48px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.65); color: #fff;
      font-size: 28px; font-weight: 800; padding: 14px 28px;
      border-radius: 12px; letter-spacing: 1.5px;
      backdrop-filter: blur(4px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      z-index: 50;
    }
    .progress-track { position: absolute; top: 0; left: 0; right: 0; height: 5px; background: rgba(255,255,255,0.15); z-index: 100; }
    .progress-bar { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: ${ACCENT}; transform-origin: left center; transform: scaleX(0); }
    .flash { position: absolute; inset: 0; background: ${ACCENT}; opacity: 0; pointer-events: none; z-index: 99; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${totalDuration.toFixed(2)}">
${clips}
    <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
    <div class="flash" id="flash"></div>
    <div class="watermark">Anime Resonance</div>
${subGoal?.text ? `    <div class="sub-goal">${escapeHtml(subGoal.text)} &#127919; Subscribe</div>` : ''}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
${progressTween}
${badgeTween}
${tweens}
${flashTweens}
    window.__timelines["main"] = tl;
  <\/script>
</body>
</html>`;

  writeFileSync(join(outputDir, 'index.html'), html, 'utf-8');

  // Write hyperframes.json
  writeFileSync(join(outputDir, 'hyperframes.json'), JSON.stringify({
    version: 1,
    width: 1080,
    height: 1920,
    fps: 30,
    duration: totalDuration,
  }, null, 2), 'utf-8');

  console.log(`   Composition: ${sceneCount} scenes, ${totalDuration.toFixed(1)}s, ${processedScenes.reduce((n, s) => n + s.words.length, 0)} words`);
  return outputDir;
}
