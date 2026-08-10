/**
 * Fetch a background image per scene.
 *
 * Source order matters more than it looks. Unsplash and Pexels are stock photo
 * libraries with essentially no anime content, so an "One Piece Brook" query
 * returned unrelated portrait photography -- an anime channel illustrated with
 * stock models. Danbooru is searched first because its character and copyright
 * tags are the only way to guarantee the art is from the right series;
 * Wallhaven follows because it holds anime art at Shorts resolution but matches
 * on freetext, and the stock sites are kept only for mood-only scenes and as a
 * last resort.
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

// Default target is the vertical Shorts frame. Long-form passes 16:9 instead --
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

// --- Danbooru: character-tagged art ------------------------------------------

const DANBOORU = 'https://danbooru.donmai.us';
const SAFE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const seriesTagCache = new Map();
const charTagCache = new Map();

function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Score tag candidates on name-token overlap and pick the best.
 *
 * Shared by the character and series resolvers because both fail the same way
 * if ranked by post count: the most-posted tag matching a wildcard is usually
 * not the one asked for. `contextWords` is the surrounding series name for a
 * character lookup (it settles homonyms via tags like brook_(one_piece)), and
 * empty for a series lookup. `alias` is the English title a tag is an alias of,
 * when the API reports one -- an exact alias hit is the strongest signal there
 * is, and the only thing that resolves a title with no shared tokens at all.
 */
function pickBestTag(candidates, nameWords, contextWords = []) {
  const ctx = new Set(contextWords);
  const wanted = nameWords.join('_');
  let best = null;

  for (const c of candidates) {
    if (!c?.name || !c.post_count) continue;
    const tagWords = tokens(c.name);
    let score = 0;

    // An alias of exactly the requested title is definitive: Danbooru files
    // "Classroom of the Elite" under youkoso_jitsuryoku_shijou_shugi_no_-
    // kyoushitsu_e, which shares no tokens with the English name at all.
    if (c.alias && tokens(c.alias).join('_') === wanted) score += 12;

    for (const w of nameWords) {
      if (tagWords.includes(w)) score += 3;                       // exact token
      else if (w.length >= 4 && tagWords.some((t) => t.startsWith(w) || w.startsWith(t))) {
        score += 2;                                               // romanisation drift
      }
    }
    // A tag like brook_(one_piece) carries its series; that settles homonyms.
    if (ctx.size && tagWords.some((t) => ctx.has(t))) score += 4;

    if (score <= 0) continue;
    if (!best || score > best.score
      || (score === best.score && c.post_count > best.post_count)) {
      best = { name: c.name, score, post_count: c.post_count };
    }
  }
  return best?.name || null;
}

/**
 * Resolve a character name to a real Danbooru tag.
 *
 * Danbooru names characters in Japanese order, so "Itachi Uchiha" is tagged
 * uchiha_itachi. Ranking candidates by post count alone picks the wrong
 * character outright -- "Brook" resolves to barnaby_brooks_jr. (3424 posts)
 * over brook_(one_piece) (1182), and "Nami" to nanami_chiaki over
 * nami_(one_piece) -- so candidates are scored on name-token overlap, with the
 * series name as a tie-breaker, and post count only settling ties.
 */
async function resolveDanbooruTag(character, anime) {
  const nameWords = tokens(character);
  if (!nameWords.length) return null;
  // Cached like the series tags: a scene now walks several post ranks, and each
  // attempt would otherwise re-resolve the same name.
  const key = `${nameWords.join('_')}|${tokens(anime).join('_')}`;
  if (charTagCache.has(key)) return charTagCache.get(key);

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

  const tag = pickBestTag(candidates, nameWords, tokens(anime));
  charTagCache.set(key, tag);
  return tag;
}

/**
 * Resolve an anime title to its Danbooru copyright (series) tag.
 *
 * The autocomplete endpoint is used instead of a name wildcard because it
 * follows tag aliases, and English titles usually are aliases: measured on the
 * four titles in the last long-form run, a `*classroom*` wildcard over
 * category=3 returns classroom_crisis and assassination_classroom but never the
 * real tag, while autocomplete returns
 * youkoso_jitsuryoku_shijou_shugi_no_kyoushitsu_e as an alias of
 * classroom_of_the_elite. Same story for shingeki_no_kyojin and
 * kimetsu_no_yaiba. Results still go through the shared scorer, since
 * autocomplete happily offers new_game! for "No Game No Life".
 *
 * ponytail: resolutions are cached for the process lifetime -- a long-form run
 * asks for the same handful of titles once per scene. Unbounded, but the key
 * space is the titles in one video; if that ever grows, cap it with an LRU.
 */
async function resolveDanbooruSeriesTag(anime) {
  const nameWords = tokens(anime);
  if (!nameWords.length) return null;
  const key = nameWords.join('_');
  if (seriesTagCache.has(key)) return seriesTagCache.get(key);

  let rows;
  try {
    const url = `${DANBOORU}/autocomplete.json`
      + `?search[query]=${encodeURIComponent(anime)}&search[type]=tag_query&limit=10`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    rows = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  // category 3 is copyright/series; 4 is character. Only series belongs here.
  const candidates = rows
    .filter((r) => r?.category === 3 && r.value)
    .map((r) => ({ name: r.value, post_count: r.post_count, alias: r.antecedent }));

  const tag = pickBestTag(candidates, nameWords);
  seriesTagCache.set(key, tag);
  return tag;
}

/**
 * Fetch and filter the usable posts for a tag, once per process.
 *
 * rating:general is not optional. An unfiltered `code_geass` query measured
 * 17 general / 17 sensitive / 3 questionable / 3 explicit out of 40, and
 * `no_game_no_life` only 10 general out of 40 -- so the rating is pinned in the
 * query and re-checked on each post before use.
 *
 * ponytail: cached because callers now walk many attempts per scene to avoid
 * repeating artwork, and every attempt used to re-request the same 30 posts.
 * Only successes are cached, so a transient failure doesn't kill the source for
 * the run. Same lifetime/key-space argument as seriesTagCache.
 */
const postCache = new Map();

async function danbooruPosts(tag) {
  if (postCache.has(tag)) return postCache.get(tag);
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

    postCache.set(tag, safe);
    return safe;
  } catch {
    return null;
  }
}

/**
 * Tags that mark art as correctly tagged but visually off-series: a 1920s
 * gangster AU carried `bleach` legitimately and showed no Bleach signifiers.
 * Only a soft sort penalty -- these tags are reliable when present but absent on
 * plenty of AU art, so rejecting on them would cost relevance for no guarantee.
 */
const AU_TAGS = /(?:^| )(?:crossover|alternate_universe|parody|cosplay)(?: |$)/;

/**
 * Pick a post for an already-resolved Danbooru tag.
 *
 * `attempt` selects a different post from the ranked pool. Callers walk several,
 * both because a single bright pick would otherwise drop the whole source and
 * lose the series accuracy only Danbooru's tagging provides, and because
 * multiple scenes in one video resolve to the same tag and must not all land on
 * the same artwork.
 *
 * `usedUrls` (optional Set) allows the caller to skip URLs already consumed
 * elsewhere in the video. The function walks forward from `attempt` until it
 * finds an unused URL or exhausts the pool, returning null on exhaustion so the
 * caller advances to the next source.
 */
async function searchDanbooruTag(tag, attempt = 0, ratio = TARGET_RATIO, usedUrls = null) {
  if (!tag) return null;
  const safe = await danbooruPosts(tag);
  if (!safe?.length) return null;

  // Orientation gate: hard-reject posts on the wrong side of the square line.
  // ponytail: if orientation-gated pool is empty, return null and let the next
  // source try. A pillarboxed portrait in a landscape frame is worse than
  // Wallhaven or AniList cover art that's at least the right shape.
  const wantLandscape = ratio >= 1;
  const gated = safe.filter((p) => {
    const ar = p.image_width / p.image_height;
    return wantLandscape ? ar >= 1 : ar <= 1;
  });
  if (!gated.length) return null;

  // Bucket the ratio distance so community score actually gets a say -- sorted
  // on the raw distance it never ties, so score was dead weight.
  // AU penalty is large (4 rank buckets) to push parody/crossover art well
  // below on-model art, addressing visually-unidentifiable content.
  const rank = (p) => {
    const bucket = Math.round(Math.abs(p.image_width / p.image_height - ratio) / 0.2);
    const penalty = AU_TAGS.test(` ${p.tag_string || ''} `) ? 4 : 0;
    return bucket + penalty;
  };
  const ranked = [...gated].sort((a, b) => (rank(a) - rank(b)) || (b.score - a.score));

  // Walk forward from `attempt`, skipping URLs already used in this video.
  // This is the core dedup mechanism: several scenes sharing a tag each start
  // at a different attempt offset and skip anything the earlier scene consumed.
  const len = ranked.length;
  for (let k = 0; k < len; k++) {
    const url = ranked[(attempt + k) % len].file_url;
    if (usedUrls && usedUrls.has(url)) continue;
    return url;
  }
  // Every post in the pool was already used -- signal exhaustion.
  return null;
}

/** Search Danbooru for art of a specific character. */
async function searchDanbooru(character, anime, attempt = 0, ratio = TARGET_RATIO, usedUrls = null) {
  return searchDanbooruTag(await resolveDanbooruTag(character, anime), attempt, ratio, usedUrls);
}

/**
 * Search Danbooru for art of a series, for scenes with no named character.
 *
 * This exists because Wallhaven's freetext search collapses on titles with
 * common words: of the top four "No Game No Life" results, three were Saiki K.
 * screencaps, and two of four "Classroom of the Elite" results were unrelated
 * maid-cafe art. A copyright tag cannot drift like that.
 */
async function searchDanbooruSeries(anime, attempt = 0, ratio = TARGET_RATIO, usedUrls = null) {
  return searchDanbooruTag(await resolveDanbooruSeriesTag(anime), attempt, ratio, usedUrls);
}

/**
 * Search Wallhaven for anime art.
 * categories=010 restricts to the anime category, purity=100 to SFW only --
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

/** AniList cover art -- on topic and free, but only ~460px wide. */
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
 * luma comes from the same pass and is used to prefer moodier art -- a blown-out
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
// the threshold is deliberately generous -- it exists for mood consistency, and
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
  // URLs already spent in this video. Five of thirteen segments used to share
  // one Naruto image because several scenes resolve to the same series tag and
  // the ranked pick is deterministic; dedup is on the resolved URL, so a
  // duplicate is never downloaded at all.
  const usedUrls = new Set();
  // ponytail: per-tag consumption counter. Each time a scene accepts an image
  // from a tag, the counter increments so the next scene sharing that tag starts
  // DEPTH ranks deeper. This guarantees distinct art without relying on scene
  // index alignment, which overlapped heavily for adjacent scenes.
  const tagConsumeCount = new Map();

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const outPath = join(outputDir, `scene-${i}.jpg`);
    const art = artQuery(scene);
    const mood = String(scene.imageQuery || 'dark cinematic sky dramatic').trim();

    // Ordered candidates: character-accurate art first, then series art, then
    // mood stock last. Danbooru leads whenever the series is known -- its
    // copyright tag cannot drift the way Wallhaven's freetext search does on
    // titles built from common words ("No Game No Life" returned Saiki K.).
    //
    // Attempt offset uses a per-tag consumption counter: each scene that shares
    // a tag starts where the previous one left off, guaranteeing distinct ranks
    // even when five scenes all resolve to "naruto". DEPTH=8 gives each scene
    // 8 chances across the 30-post pool before giving up.
    const DEPTH = 8;
    const charTag = scene.character ? await resolveDanbooruTag(scene.character, scene.anime) : null;
    const seriesTag = scene.anime ? await resolveDanbooruSeriesTag(scene.anime) : null;

    const charOffset = (tagConsumeCount.get(charTag || '') || 0) * DEPTH;
    const seriesOffset = (tagConsumeCount.get(seriesTag || '') || 0) * DEPTH;

    // Each candidate is [asyncFn, tagItCameFrom | null].
    const danbooruAttempts = (tag, baseOffset) =>
      Array.from({ length: DEPTH }, (_, k) => [() => searchDanbooruTag(tag, baseOffset + k, ratio, usedUrls), tag]);

    const candidates = [
      ...(charTag ? danbooruAttempts(charTag, charOffset) : []),
      ...(seriesTag ? danbooruAttempts(seriesTag, seriesOffset) : []),
      [() => searchWallhaven(art, { minW, minH, ratio }), null],
      [() => searchWallhaven(art, { minW: Math.round(minW * 0.7), minH: Math.round(minH * 0.7), ratio }), null],
      [() => searchWallhaven(String(scene.anime || '').trim(), { minW, minH, ratio }), null],
      [() => searchAniListCover(String(scene.anime || art).trim()), null],
      [() => searchPexels(mood, orientation), null],
      [() => searchUnsplash(mood, orientation), null],
    ];

    let got = null;
    // Track which tag provided the winning URL so the consumption counter
    // advances for the right tag.
    let gotFromTag = null;
    // A decodable but washed-out image is held as a fallback: better to use it
    // than to drop to a flat placeholder if nothing darker turns up.
    let fallbackUrl = null;
    let fallbackTag = null;
    // Last resort before stock photography: art already used earlier in this
    // video. Every other source is tried first.
    let dupUrl = null;

    for (const [nextCandidate, candidateTag] of candidates) {
      const url = await nextCandidate();
      if (!url) continue;
      if (usedUrls.has(url)) { dupUrl ??= url; continue; }
      try {
        if (!await downloadImage(url, outPath)) continue;
        const info = await inspectImage(outPath);
        if (!info) {
          if (existsSync(outPath)) unlinkSync(outPath);
          continue;
        }
        if (info.yavg <= MAX_LUMA) {
          got = url;
          gotFromTag = candidateTag;
          break;
        }
        if (!fallbackUrl) {
          fallbackUrl = url;
          fallbackTag = candidateTag;
        }
      } catch {
        try { if (existsSync(outPath)) unlinkSync(outPath); } catch {}
      }
    }

    // Nothing dark enough -- take the brightest-but-valid option we saw, then a
    // repeat of earlier art, before giving up on real artwork entirely.
    for (const [url, tag] of [[fallbackUrl, fallbackTag], [dupUrl, null]]) {
      if (got || !url) continue;
      try {
        if (await downloadImage(url, outPath) && await inspectImage(outPath)) {
          got = url;
          gotFromTag = tag;
        }
      } catch {}
    }

    if (got) {
      usedUrls.add(got);
      // Advance the consumption counter for whichever tag delivered.
      if (gotFromTag) {
        tagConsumeCount.set(gotFromTag, (tagConsumeCount.get(gotFromTag) || 0) + 1);
      }
      results.push(outPath);
      const src = got.includes('donmai') ? 'danbooru'
        : got.includes('wallhaven') ? 'wallhaven'
          : got.includes('anilist') ? 'anilist'
            : got.includes('pexels') ? 'pexels' : 'unsplash';
      console.log(`  [ok] Image ${i + 1}/${scenes.length} [${src}]: "${(art || mood).slice(0, 40)}"`);
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
        console.log(`  [!!] Image ${i + 1}/${scenes.length}: placeholder for "${(art || mood).slice(0, 40)}"`);
        continue;
      }
    } catch {}

    console.log(`  [!!] Image ${i + 1}/${scenes.length}: MISSING "${(art || mood).slice(0, 40)}"`);
    results.push(null);
  }

  return results;
}
