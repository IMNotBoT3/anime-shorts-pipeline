/**
 * Anime news and trending-topic sources.
 *
 * Every feed here was probed live; only ones that returned items without auth
 * are included. Measured item counts per call:
 *
 *   Google News RSS      ~100  queryable with ANY search term  <- most flexible
 *   Anime News Network   ~135  (all) / ~40 (news only)
 *   Anime Corner          ~25
 *   MyAnimeList news      ~20
 *   Siliconera            ~15
 *   Otaku USA             ~10
 *   Jikan (MAL) JSON      ~10  top anime / current season
 *   Kitsu trending JSON   ~10
 *   Reddit r/anime .rss   ~25  (.json is 403; .rss 429s if called repeatedly)
 *
 * Rejected after probing: Crunchyroll newsrss (404), comicbook.com/anime
 * (200 but no items), Jikan top/characters (504), Google Trends daily RSS
 * (works, but returns general trends like "yankees schedule" — not anime).
 *
 * This module only sources material. Nothing here decides what gets published.
 */
import fetch from 'node-fetch';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; AnimeResonance/1.0)' };

const FEEDS = [
  { name: 'ann',        url: 'https://www.animenewsnetwork.com/news/rss.xml' },
  { name: 'animecorner', url: 'https://animecorner.me/feed/' },
  { name: 'mal',        url: 'https://myanimelist.net/rss/news.xml' },
  { name: 'siliconera', url: 'https://www.siliconera.com/feed/' },
  // Otaku USA is deliberately absent: the feed still returns 200 with 10 items,
  // but the newest is ~11 months old, so it is dead weight behind the age gate.
];

/**
 * Google News RSS accepts an arbitrary query, which makes it the one source
 * that can be aimed at a specific show, studio, or event on demand.
 */
export function googleNewsUrl(query) {
  return 'https://news.google.com/rss/search'
    + `?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

/** Parse RSS 2.0 <item> and Atom <entry> with one pass. */
function parseFeed(xml, source) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map((m) => m[0]);

  return blocks.map((b) => {
    const title = b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1];
    // Atom uses <link href="...">, RSS uses <link>...</link>.
    const link = b.match(/<link[^>]*href=["']([^"']+)/)?.[1]
      || b.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/)?.[1];
    const date = b.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/)?.[1];
    const desc = b.match(/<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/)?.[1];

    if (!title) return null;
    const ts = date ? Date.parse(date.trim()) : NaN;

    return {
      title: decodeEntities(stripTags(title)),
      summary: decodeEntities(stripTags(desc || '')).slice(0, 400),
      link: (link || '').trim(),
      published: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
      ts: Number.isNaN(ts) ? 0 : ts,
      source,
    };
  }).filter(Boolean);
}

async function fetchFeed({ name, url }) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    return parseFeed(await res.text(), name);
  } catch {
    return [];
  }
}

// Headlines that are never a video subject.
const NOISE = /(questions,?\s+recommendations|discussion thread|daily thread|weekly thread|casual discussion|help me find|watch order)/i;
const ANIME_HINT = /(anime|manga|manhwa|webtoon|studio|season|episode|film|movie|crunchyroll|isekai|shonen|seiyuu|voice cast|light novel)/i;

const STOP = new Set(['the', 'and', 'for', 'with', 'gets', 'get', 'new', 'anime', 'manga',
  'series', 'season', 'announced', 'reveals', 'reveal', 'from', 'that', 'this', 'its',
  'his', 'her', 'their', 'will', 'has', 'have', 'been', 'more', 'about', 'into']);

/** Significant lowercase tokens of a headline, for same-story detection. */
function tokenize(title) {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );
}

/**
 * Is this the same story as one already accepted?
 *
 * The same announcement runs on every site under a different headline — "…
 * Webtoon Ends, Gets TV Anime" vs "Webtoon '…' Gets TV Anime" vs "… TV Anime
 * Adaptation Announced" were three entries for one story. Exact-title dedupe
 * cannot see that, so compare significant-token overlap against the smaller
 * set: one headline is often a superset of the other.
 */
function isSameStory(tokens, acceptedTokenSets, threshold = 0.6) {
  for (const prev of acceptedTokenSets) {
    let shared = 0;
    for (const t of tokens) if (prev.has(t)) shared++;
    const smaller = Math.min(tokens.size, prev.size);
    if (smaller >= 2 && shared / smaller >= threshold) return true;
  }
  return false;
}

/**
 * Merge every news feed, newest first, deduped by title.
 *
 * @param {object} opts
 * @param {string} [opts.query]  - also pull a Google News search for this topic
 * @param {number} [opts.limit]  - max items returned
 * @param {number} [opts.maxAgeHours] - drop anything older
 */
export async function fetchAnimeNews({ query = '', limit = 30, maxAgeHours = 72 } = {}) {
  const jobs = FEEDS.map(fetchFeed);
  if (query) jobs.push(fetchFeed({ name: 'googlenews', url: googleNewsUrl(query) }));
  // Reddit .rss 429s when hit repeatedly, so it is one best-effort call.
  jobs.push(fetchFeed({ name: 'reddit', url: 'https://www.reddit.com/r/anime/.rss' }));

  const all = (await Promise.all(jobs)).flat();
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;

  // Filter and dedupe, keeping each source's items in recency order.
  const seen = new Set();
  const storyTokens = [];
  const bySource = new Map();
  for (const item of all.sort((a, b) => b.ts - a.ts)) {
    if (NOISE.test(item.title)) continue;
    if (!ANIME_HINT.test(item.title + ' ' + item.summary)) continue;
    if (item.ts && item.ts < cutoff) continue;

    // Exact-title dedupe first (cheap), then same-story detection across sites.
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
    if (!key || seen.has(key)) continue;

    const tokens = tokenize(item.title);
    if (isSameStory(tokens, storyTokens)) continue;

    seen.add(key);
    storyTokens.push(tokens);

    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }

  // Interleave sources instead of returning a pure recency sort. Reddit and
  // Google News publish continuously, so sorting by time alone buried the
  // curated editorial feeds (ANN, MAL, Anime Corner) beneath ~100 fresher
  // items and they never appeared in the result at all.
  const queues = [...bySource.values()];
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const q of queues) {
      if (round < q.length) {
        out.push(q[round]);
        added = true;
        if (out.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return out;
}

/**
 * Currently airing / top anime titles, used to aim searches and rank material
 * by what people are actually watching.
 *
 * Jikan proxies MyAnimeList and returns 504 whenever MAL is unreachable — it
 * did exactly that during testing — so AniList is the fallback rather than
 * letting the caller silently get an empty list.
 */
export async function fetchTrendingTitles(limit = 10) {
  const out = [];

  for (const path of [`/seasons/now?limit=${limit}`, `/top/anime?limit=${limit}`]) {
    try {
      const res = await fetch(`https://api.jikan.moe/v4${path}`,
        { headers: UA, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const a of data.data || []) {
        const title = a.title_english || a.title;
        if (title && !out.includes(title)) out.push(title);
      }
    } catch { /* try the next path */ }
    // Jikan asks for <=3 req/s.
    await new Promise((r) => setTimeout(r, 400));
  }

  if (out.length) return out.slice(0, limit * 2);

  // Jikan unavailable — AniList covers the same need and has held up.
  const { fetchTrendingAnime } = await import('./fetch-quotes.js');
  return await fetchTrendingAnime(limit);
}

// ─── self-check ──────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('fetch-news.js');

if (isMain) {
  console.log('\nfetch-news self-check\n');

  const titles = await fetchTrendingTitles(6);
  console.log(`  Jikan trending: ${titles.length} titles`);
  console.log(`    ${titles.slice(0, 4).join(' | ')}`);

  const news = await fetchAnimeNews({ query: titles[0] || 'anime', limit: 12 });
  console.log(`\n  News items: ${news.length}`);
  const bySource = {};
  for (const n of news) bySource[n.source] = (bySource[n.source] || 0) + 1;
  console.log(`  By source: ${JSON.stringify(bySource)}`);
  console.log('');
  for (const n of news.slice(0, 8)) {
    console.log(`    [${n.source}] ${n.title.slice(0, 82)}`);
  }

  if (!news.length) {
    console.log('\n  ✗ no news items — every feed failed');
    process.exit(1);
  }
  console.log('\n  ✓ news sourcing works');
}
