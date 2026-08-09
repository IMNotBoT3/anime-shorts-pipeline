/**
 * Fetch a background image per scene.
 *
 * Source order matters more than it looks. Unsplash and Pexels are stock photo
 * libraries with essentially no anime content, so an "One Piece Brook" query
 * returned unrelated portrait photography — an anime channel illustrated with
 * stock models. Wallhaven is searched first because it actually holds anime art
 * at Shorts resolution; the stock sites are kept only for mood-only scenes and
 * as a last resort.
 */
import fetch from 'node-fetch';
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));
const execFileAsync = promisify(execFile);

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; AnimeResonance/1.0)' };

// Default target is the vertical Shorts frame. Long-form passes 16:9 instead —
// picking vertical art for a landscape frame crops the subject's head off.
const VERTICAL_RATIO = 1080 / 1920;   // 0.5625
const TARGET_RATIO = VERTICAL_RATIO;

/** Words that help a stock-photo search but only add noise on an art site. */
const FILLER = /\b(anime|dramatic|scene|cinematic|emotional|moody|dark|background|wallpaper|4k|hd)\b/gi;

function artQuery(scene) {
  // Prefer explicit anime/character context over the LLM's prose query.
  const parts = [scene.anime, scene.character].filter(Boolean).join(' ').trim();
  if (parts) return parts;
  return String(scene.imageQuery || '').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Danbooru: character-tagged art ──────────────────────────────────────────

const DANBOORU = 'https://danbooru.donmai.us';
const SAFE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);

function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Resolve a character name to a real Danbooru tag.
 *
 * Danbooru names characters in Japanese order, so "Itachi Uchiha" is tagged
 * uchiha_itachi. Ranking candidates by post count alone picks the wrong
 * character outright — "Brook" resolves to barnaby_brooks_jr. (3424 posts)
 * over brook_(one_piece) (1182), and "Nami" to nanami_chiaki over
 * nami_(one_piece) — so candidates are scored on name-token overlap, with the
 * series name as a tie-breaker, and post count only settling ties.
 */
async function resolveDanbooruTag(character, anime) {
  const nameWords = tokens(character);
  if (!nameWords.length) return null;

  // Query on the most distinctive word; wildcards need a stem, not a phrase.
  const probe = [...nameWords].sort((a, b) => b.length - a.length)[0];
  if (probe.length < 3) return null;

  let candidates;
  try {
    const url = `${DANBOORU}/tags.json?search[name_matches]=*${encodeURIComponent(probe)}*`
      + `&search[category]=4&search[order]=count&limit=12`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    candidates = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const animeWords = new Set(tokens(anime));

  let best = null;
  for (const c of candidates) {
    if (!c?.name || !c.post_count) continue;
    const tagWords = tokens(c.name);
    let score = 0;

    for (const w of nameWords) {
      if (tagWords.includes(w)) score += 3;                       // exact token
      else if (w.length >= 4 && tagWords.some((t) => t.startsWith(w) || w.startsWith(t))) {
        score += 2;                                               // romanisation drift
      }
    }
    // A tag like brook_(one_piece) carries its series; that settles homonyms.
    if (animeWords.size && tagWords.some((t) => animeWords.has(t))) score += 4;

    if (score <= 0) continue;
    if (!best || score > best.score
      || (score === best.score && c.post_count > best.post_count)) {
      best = { name: c.name, score, post_count: c.post_count };
    }
  }
  return best?.name || null;
}

/**
 * Search Danbooru for art of a specific character.
 *
 * rating:general is not optional. An unfiltered `one_piece` query returns a
 * mix of general, sensitive and questionable posts, so the rating is pinned in
 * the query and re-checked on each post before use.
 *
 * `attempt` selects a different post from the ranked pool. Callers try a few,
 * because a single bright pick would otherwise drop the whole source and lose
 * the character accuracy that only Danbooru's tagging provides.
 */
async function searchDanbooru(character, anime, attempt = 0, ratio = TARGET_RATIO) {
  const tag = await resolveDanbooruTag(character, anime);
  if (!tag) return null;

  try {
    const url = `${DANBOORU}/posts.json`
      + `?tags=${encodeURIComponent(`${tag} rating:general`)}`
      + `&limit=30`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const posts = await res.json();
    if (!Array.isArray(posts)) return null;

    const safe = posts.filter((p) =>
      p?.file_url
      && p.rating === 'g'                       // re-check, do not trust the query alone
      && SAFE_EXT.has(String(p.file_ext || '').toLowerCase())
      && p.image_width >= 800 && p.image_height >= 800);

    if (!safe.length) return null;

    // Prefer art closest to the target frame shape, then community score.
    safe.sort((a, b) => {
      const ar = Math.abs(a.image_width / a.image_height - ratio);
      const br = Math.abs(b.image_width / b.image_height - ratio);
      return (ar - br) || (b.score - a.score);
    });

    // Deterministic per attempt so retries genuinely differ.
    const idx = attempt % safe.length;
    return safe[idx].file_url;
  } catch {
    return null;
  }
}

/**
 * Search Wallhaven for anime art.
 * categories=010 restricts to the anime category, purity=100 to SFW only —
 * both are required for a brand-safe channel.
 */
async function searchWallhaven(query, { minW = 1080, minH = 1350, ratio = TARGET_RATIO } = {}) {
  if (!query) return null;
  const url = 'https://wallhaven.cc/api/v1/search'
    + `?q=${encodeURIComponent(query)}`
    + '&categories=010&purity=100&sorting=relevance'
    + `&atleast=${minW}x${minH}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    const hits = (data.data || []).filter((w) => w.path && w.purity === 'sfw');
    if (!hits.length) return null;

    // Prefer whatever is closest to the target frame shape, then vary between
    // runs so the same anime doesn't reuse one wallpaper in every video.
    hits.sort((a, b) =>
      Math.abs(parseFloat(a.ratio) - ratio) - Math.abs(parseFloat(b.ratio) - ratio));
    const pool = hits.slice(0, Math.min(5, hits.length));
    return pool[Math.floor(Math.random() * pool.length)].path;
  } catch {
    return null;
  }
}

/** AniList cover art — on topic and free, but only ~460px wide. */
async function searchAniListCover(query) {
  if (!query) return null;
  const gql = `query ($s: String) {
    Media(search: $s, type: ANIME) {
      coverImage { extraLarge }
      bannerImage
    }
  }`;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { s: query } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const m = (await res.json()).data?.Media;
    return m?.coverImage?.extraLarge || m?.bannerImage || null;
  } catch {
    return null;
  }
}

async function searchPexels(query, orientation = 'portrait') {
  const key = config.pexels?.apiKey || process.env.PEXELS_API_KEY;
  if (!key || !query) return null;
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=5`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const photos = (await res.json()).photos || [];
    if (!photos.length) return null;
    const pick = photos[Math.floor(Math.random() * photos.length)];
    return pick?.src?.large2x || null;
  } catch {
    return null;
  }
}

async function searchUnsplash(query, orientation = 'portrait') {
  const key = config.unsplash?.accessKey || process.env.UNSPLASH_API_KEY;
  if (!key || !query) return null;
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=5`,
      { headers: { Authorization: `Client-ID ${key}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const results = (await res.json()).results || [];
    if (!results.length) return null;
    return results[Math.floor(Math.random() * results.length)]?.urls?.regular || null;
  } catch {
    return null;
  }
}

async function downloadImage(url, outputPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return false;
  await pipeline(res.body, createWriteStream(outputPath));
  return existsSync(outputPath);
}

/**
 * Inspect a downloaded image: does it decode, how big is it, how bright is it?
 *
 * A truncated download would otherwise fail inside the render filter graph and
 * take the whole video with it, long after the cheap place to catch it. Mean
 * luma comes from the same pass and is used to prefer moodier art — a blown-out
 * poster scan is on topic but reads as cheap behind white captions.
 */
async function inspectImage(path) {
  try {
    if (!existsSync(path) || statSync(path).size < 5000) return null;
    let info = '';
    try {
      const r = await execFileAsync('ffmpeg', ['-hide_banner', '-i', path,
        '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
        '-frames:v', '1', '-f', 'null', '-'], { timeout: 20000 });
      info = r.stderr;
    } catch (e) {
      info = e.stderr || '';
    }
    const dims = /, (\d+)x(\d+)/.exec(info);
    if (!dims || +dims[1] < 400 || +dims[2] < 400) return null;
    const yavg = parseFloat(/YAVG=([\d.]+)/.exec(info)?.[1] ?? '128');
    return { w: +dims[1], h: +dims[2], yavg };
  } catch {
    return null;
  }
}

// Above this mean luma the art is washed out for white captions; try the next
// candidate before settling for it. The render applies a 0.42 black scrim, so
// the threshold is deliberately generous — it exists for mood consistency, and
// being too strict here throws away character-accurate art for a mood match.
const MAX_LUMA = 200;

/**
 * Fetch images for all scenes. Returns array of file paths (null on failure).
 *
 * Each scene may carry {imageQuery, anime, character}; anime/character drive the
 * art search, imageQuery is the mood fallback.
 *
 * @param {object} [opts]
 * @param {'portrait'|'landscape'} [opts.orientation] - frame shape to source for.
 *   Long-form must pass 'landscape': vertical art cropped to 16:9 loses the
 *   subject's head entirely.
 */
export async function fetchAllImages(scenes, outputDir, { orientation = 'portrait' } = {}) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const landscape = orientation === 'landscape';
  const ratio = landscape ? 1920 / 1080 : VERTICAL_RATIO;
  const minW = landscape ? 1600 : 1080;
  const minH = landscape ? 900 : 1350;

  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const outPath = join(outputDir, `scene-${i}.jpg`);
    const art = artQuery(scene);
    const mood = String(scene.imageQuery || 'dark cinematic sky dramatic').trim();

    // Ordered candidates: character-accurate art first, then series art, then
    // mood stock last. Danbooru leads only when a character is known, since
    // that is where its character tagging beats Wallhaven's freetext search.
    const candidates = [
      ...(scene.character ? [
        () => searchDanbooru(scene.character, scene.anime, 0, ratio),
        () => searchDanbooru(scene.character, scene.anime, 1, ratio),
        () => searchDanbooru(scene.character, scene.anime, 2, ratio),
      ] : []),
      () => searchWallhaven(art, { minW, minH, ratio }),
      () => searchWallhaven(art, { minW: Math.round(minW * 0.7), minH: Math.round(minH * 0.7), ratio }),
      () => searchWallhaven(String(scene.anime || '').trim(), { minW, minH, ratio }),
      () => searchAniListCover(String(scene.anime || art).trim()),
      () => searchPexels(mood, orientation),
      () => searchUnsplash(mood, orientation),
    ];

    let got = null;
    // A decodable but washed-out image is held as a fallback: better to use it
    // than to drop to a flat placeholder if nothing darker turns up.
    let fallbackUrl = null;

    for (const nextCandidate of candidates) {
      const url = await nextCandidate();
      if (!url) continue;
      try {
        if (!await downloadImage(url, outPath)) continue;
        const info = await inspectImage(outPath);
        if (!info) {
          if (existsSync(outPath)) unlinkSync(outPath);
          continue;
        }
        if (info.yavg <= MAX_LUMA) { got = url; break; }
        if (!fallbackUrl) fallbackUrl = url;   // keep looking for something moodier
      } catch {
        try { if (existsSync(outPath)) unlinkSync(outPath); } catch {}
      }
    }

    // Nothing dark enough — take the brightest-but-valid option we saw.
    if (!got && fallbackUrl) {
      try {
        if (await downloadImage(fallbackUrl, outPath) && await inspectImage(outPath)) {
          got = fallbackUrl;
        }
      } catch {}
    }

    if (got) {
      results.push(outPath);
      const src = got.includes('donmai') ? 'danbooru'
        : got.includes('wallhaven') ? 'wallhaven'
          : got.includes('anilist') ? 'anilist'
            : got.includes('pexels') ? 'pexels' : 'unsplash';
      console.log(`  ✓ Image ${i + 1}/${scenes.length} [${src}]: "${(art || mood).slice(0, 40)}"`);
      continue;
    }

    // Solid dark placeholder so the render can still proceed.
    try {
      await execFileAsync('ffmpeg', [
        '-f', 'lavfi', '-i', 'color=c=0x12121c:s=1080x1920',
        '-frames:v', '1', '-update', '1', '-y', outPath,
      ], { timeout: 15000 });
      if (existsSync(outPath)) {
        results.push(outPath);
        console.log(`  ⚠ Image ${i + 1}/${scenes.length}: placeholder for "${(art || mood).slice(0, 40)}"`);
        continue;
      }
    } catch {}

    console.log(`  ⚠ Image ${i + 1}/${scenes.length}: MISSING "${(art || mood).slice(0, 40)}"`);
    results.push(null);
  }

  return results;
}
