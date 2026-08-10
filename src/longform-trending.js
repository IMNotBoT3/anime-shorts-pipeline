/**
 * Trending long-form anime video (2-3 minutes, 16:9).
 *
 * Uses the same saturation/trending data as the Shorts pipeline but produces a
 * longer video optimized for watch hours. A 3-min video with 40% retention =
 * 1.2 min/view — the fastest path to YPP monetization.
 *
 * Unlike the quote compilation (longform.js), this isn't locked to quotes — it
 * takes whatever the #1 GOLD topic is and builds the right format:
 *   - ranking   → 5-item countdown with dramatic reveals
 *   - news      → 3-min explainer/deep-dive
 *   - quote     → single-anime deep-dive (5 quotes from that series)
 *   - debate    → hot-take essay with evidence
 *
 *   node src/longform-trending.js              # pick best topic, render + upload
 *   node src/longform-trending.js --preview    # render only
 *   node src/longform-trending.js --topic "Top 5 strongest in One Piece"
 *
 * Visuals: Danbooru character art (portrait contained on blurred backdrop),
 * Wallhaven series art for intros/transitions, dark scrim + bottom captions +
 * rank numbers — same proven stack as the quote longform but driven by trending.
 */
import { existsSync, mkdirSync, rmSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';

import { pickTopics } from './pick-topics.js';
import { generateVoiceover, getAudioDuration } from './voiceover.js';
import { fetchAllImages } from './fetch-images.js';
import { uploadToYouTube, setThumbnail } from './youtube-upload.js';
import { buildThumbnail } from './thumbnail.js';
import { markSeen } from './seen-store.js';
import { checkSaturation } from './saturation-check.js';
import { getSubGoal } from './sub-count.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4.1-mini';
const OUTPUT_DIR = config.output?.dir || './output';
const LOG_FILE = join(__dirname, '..', 'published.csv');

const previewMode = process.argv.includes('--preview');
const topicArg = process.argv.find(a => a === '--topic');
const manualTopic = topicArg ? process.argv[process.argv.indexOf(topicArg) + 1] : null;

/**
 * Generate a 2-3 minute script via LLM, tailored to the topic type.
 */
async function generateLongformScript(topic) {
  const apiKey = (config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || '')
    .replace(/^["']|["']$/g, '').trim();
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY');

  const typeGuide = {
    ranking: `Structure this as a TOP 5 COUNTDOWN. Start with #5 (least powerful) and build to #1.
For each entry:
- SETUP (15-20 words): Why this character/moment/scene earns this spot. Create anticipation.
- REVEAL (10-15 words): Name them and their signature feat/moment.
- IMPACT (10-15 words): Why they're above the previous entry.

The #1 reveal should feel like a mic drop. End with "Who did I miss? Drop your list below."`,

    news: `Structure this as a 3-MINUTE DEEP DIVE. The viewer clicked because the headline hooked them — now deliver the full story.
- HOOK (20-30 words): Restate the bombshell with urgency.
- CONTEXT (30-40 words): What was the situation before this news? Why does it matter?
- DETAILS (40-50 words): The key facts — who, what, when, specific names and numbers.
- IMPLICATIONS (30-40 words): What this means for fans. Will it change the show? When?
- CLOSE (20-30 words): "What do you think?" + subscribe CTA.`,

    debate: `Structure this as a PERSUASIVE ESSAY. The viewer clicked because the take is provocative — now back it up.
- HOOK (15-20 words): State the hot take boldly. No hedging.
- EVIDENCE 1 (25-30 words): Your strongest supporting point with a specific example.
- EVIDENCE 2 (25-30 words): Second point that reinforces the first.
- COUNTER (20-25 words): Acknowledge the biggest counterargument, then dismiss it.
- CLOSE (20-25 words): Restate the take harder. "Agree or fight me below."`,

    quote: `Structure this as a 5-QUOTE COMPILATION from this anime/theme.
For each quote:
- SETUP (15-20 words): Context — what was happening, why this moment hit.
- THE QUOTE (exact quote, no changes).
- BRIDGE (10-15 words): Brief reflection connecting to the next.

Build emotional intensity through the sequence — start with a good quote, end with the one that makes people cry.`,
  };

  const prompt = `You're writing a 2.5-3 minute YouTube video for "Anime Resonance" — a channel covering anime quotes, rankings, news, and hot takes.

TOPIC: "${topic.title}"
TYPE: ${topic.type}
${topic.anime ? `ANIME: ${topic.anime}` : ''}
${topic.url ? `SOURCE: ${topic.url}` : ''}

${typeGuide[topic.type] || typeGuide.ranking}

TOTAL SCRIPT: 250-350 words (at ~2.3 words/sec that's 110-150 seconds = 2-2.5 min of speech).

STRUCTURE: Write 8-12 segments. Each segment is ONE narrative unit with its own emotional beat.

Each segment needs:
- type: "intro" | "entry" | "context" | "reveal" | "bridge" | "close"
- narration: the spoken text (15-40 words)
- imageQuery: specific anime search query for the background
- character: (optional) if a specific character is the focus of this segment
- number: (optional) for ranked entries, the rank number (5, 4, 3, 2, 1)

YOUTUBE METADATA:
- title: under 80 chars, hooks curiosity, includes the anime name
- description: Full breakdown with timestamps (approximate). Subscribe CTA. 500+ chars.
- hashtags: 5 relevant hashtags
- tags: 25-30 tags filling close to 500 chars. Cover: anime names, character names, topic keywords, genre terms, discovery terms (anime motivation, anime explained, etc.)

VISUAL DIRECTION:
- imageQuery must be SPECIFIC to the anime. Not "dramatic scene" — instead "Gojo Satoru Domain Expansion Jujutsu Kaisen"
- For reveals: the character name + their most iconic visual
- For intro/close: the anime's most recognizable setting or symbol
- Think of each frame as a poster — it should be visually striking even as a still

Return ONLY valid JSON:
{
  "segments": [{"type": "...", "narration": "...", "imageQuery": "...", "character": "...", "number": null}],
  "youtube": {"title": "...", "description": "...", "hashtags": [...], "tags": [...]},
  "voice": "en-US-AndrewMultilingualNeural"
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Anime Resonance — Trending Long-Form');
  console.log('  =====================================\n');

  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, 'date,quote_id,character,anime,youtube_id,youtube_url,duration_sec\n');
  }

  // Pick the #1 trending topic with the highest opportunity
  let topic;
  if (manualTopic) {
    const sat = await checkSaturation(manualTopic).catch(() => null);
    topic = { title: manualTopic, type: 'ranking', anime: '', id: `lf-manual-${Date.now()}`, saturation: sat };
  } else {
    console.log('  Finding the highest-opportunity topic...\n');
    const topics = await pickTopics(3);
    if (!topics.length) {
      console.log('  No viable topics. Try --topic "Your Topic" to override.');
      return;
    }
    // Pick the one with the best demand/supply for long-form
    topic = topics[0];
  }

  console.log(`  📌 Topic: "${topic.title}"`);
  console.log(`  📌 Type: ${topic.type}`);
  if (topic.saturation) {
    console.log(`  📌 Opportunity: ${topic.saturation.verdict} — ${topic.saturation.reason}`);
  }
  if (topic.anime) console.log(`  📌 Anime: ${topic.anime}`);

  const compId = `longform-${Date.now()}`;
  const compDir = join(OUTPUT_DIR, compId);
  mkdirSync(compDir, { recursive: true });

  try {
    // 1. Generate script
    console.log('\n  Generating script...');
    const script = await generateLongformScript(topic);
    const segments = script.segments || [];
    console.log(`  ${segments.length} segments`);
    console.log(`  Title: ${script.youtube?.title}`);

    const totalWords = segments.reduce((n, s) => n + (s.narration || '').split(/\s+/).length, 0);
    console.log(`  Words: ${totalWords} (~${Math.round(totalWords / 2.3)}s)`);

    // 2. Generate voiceover for each segment
    console.log('\n  Voiceover...');
    const voice = script.voice || 'en-US-AndrewMultilingualNeural';
    for (let i = 0; i < segments.length; i++) {
      const outPath = join(compDir, `scene-${i}.mp3`);
      await generateVoiceover(segments[i].narration, outPath, voice);
      segments[i].duration = await getAudioDuration(outPath);
      segments[i].audioPath = outPath;
    }
    const totalDuration = segments.reduce((n, s) => n + s.duration, 0);
    console.log(`  Total duration: ${totalDuration.toFixed(1)}s (${(totalDuration / 60).toFixed(1)} min)`);

    // 3. Fetch images — pass anime + character context for on-topic art
    console.log('\n  Fetching images...');
    const imageScenes = segments.map(s => ({
      imageQuery: s.imageQuery,
      anime: topic.anime || s.imageQuery?.split(' ').slice(0, 2).join(' '),
      character: s.character || undefined,
    }));
    const images = await fetchAllImages(imageScenes, compDir, { orientation: 'landscape' });
    for (let i = 0; i < segments.length; i++) {
      segments[i].imagePath = images[i] || join(compDir, `scene-${i}.jpg`);
    }

    // 4. Render — uses the existing longform renderer (blurred backdrop + captions)
    console.log('\n  Rendering...');

    // Fetch sub count for the watermark overlay
    const subGoal = await getSubGoal(100).catch(() => null);
    if (subGoal) console.log(`  📊 Subscribers: ${subGoal.count}/${subGoal.goal}`);

    // Import the render function from longform.js dynamically to reuse its
    // proven filter graph (blurred backdrop, captions, crossfade, BGM).
    // We need to call renderLongform which is module-private, so we pass
    // segments through its expected shape.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    // Build segments in the shape renderLongform expects
    const renderSegments = segments.map((s, i) => ({
      audioPath: s.audioPath,
      imagePath: s.imagePath,
      duration: s.duration,
      type: s.type || 'entry',
      caption: s.narration,
      quoteNumber: s.number || null,
      character: s.character || '',
      anime: topic.anime || '',
    }));

    // Use the longform renderer by importing its module and calling main
    // Actually, since renderLongform is not exported, let's just do a direct
    // ffmpeg render with the same approach: blurred backdrop + contained + captions
    const outputPath = join(compDir, `${compId}.mp4`);

    // For now, call the existing longform pipeline render approach inline.
    // The simplest path: write the segments to disk and call the render chain.
    // This reuses everything already built and tested.
    const { renderLongformTrending } = await import('./render-longform.js');
    await renderLongformTrending(renderSegments, outputPath, { ...topic, subGoal });

    console.log(`  Output: ${outputPath}`);

    // 5. Thumbnail
    let thumbPath = null;
    try {
      console.log('\n  Thumbnail...');
      thumbPath = await buildThumbnail({
        theme: topic.title,
        quoteCount: segments.filter(s => s.number).length || segments.length,
        anime: topic.anime,
        outDir: compDir,
      });
    } catch (err) {
      console.warn(`  ⚠ Thumbnail failed: ${err.message}`);
    }

    // 6. Upload
    if (!previewMode) {
      console.log('\n  Uploading...');
      const meta = {
        ...(script.youtube || {}),
        categoryId: '24',
        longForm: true,
      };
      const videoId = await uploadToYouTube(outputPath, meta);
      if (!videoId) throw new Error('upload failed');

      markSeen(topic.id || compId, topic.title);
      if (thumbPath) await setThumbnail(videoId, thumbPath);

      const row = [
        new Date().toISOString(), compId,
        `"${topic.type}: ${topic.title.slice(0, 40)}"`,
        `"${topic.anime || 'mixed'}"`,
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
    if (!previewMode) {
      try { rmSync(compDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch(console.error);
