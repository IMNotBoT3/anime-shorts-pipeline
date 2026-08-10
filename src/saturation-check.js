/**
 * Pre-render saturation check via SerpAPI.
 *
 * Before spending 2-3 minutes rendering a Short, check whether the opportunity
 * window for this topic is still open. The signal is not "does coverage exist?"
 * but "is the demand-to-supply ratio still high enough to absorb another
 * entrant?" — a topic with 400K views across 2 Shorts is undersupplied; the
 * same 400K across 50 Shorts is saturated.
 *
 * Strategy (derived from the House of Dragon observation: 1.5K views on a
 * trending topic because the Short went up while demand was still unmet):
 *
 *   demand_per_short = total_views / existing_shorts_count
 *
 *   demand_per_short > 50K   → GOLD: proven demand, barely served
 *   demand_per_short > 10K   → GREEN: room for more
 *   demand_per_short > 2K    → YELLOW: competitive but viable
 *   demand_per_short < 2K    → RED: oversaturated, skip unless you have an angle
 *   existing_shorts === 0    → BLUE: virgin territory, be first (highest priority)
 *
 * A topic with high views on recent Shorts (< 3 days old) ALSO gets a "proven
 * velocity" boost — if someone else got 100K in 2 days, the audience is still
 * hungry and actively searching. That's a signal TO enter, not to avoid.
 *
 * Costs 2 API calls per topic checked (YouTube Search + Google Short Videos).
 * At 5 topics/run × 5 runs/day = 50 calls/day = 1500/month — within budget.
 *
 * Self-check: `node src/saturation-check.js`
 */

import fetch from 'node-fetch';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const SERPAPI_BASE = 'https://serpapi.com/search.json';

function getKeys() {
  const env = process.env.SERPAPI_KEYS || '';
  if (env) return env.split(',').map(k => k.trim()).filter(Boolean);
  const cfg = config.serpapi?.keys;
  if (Array.isArray(cfg)) return cfg.filter(Boolean);
  if (cfg) return [cfg];
  return [];
}

// ponytail: round-robin index persists across calls within one process, so
// a batch of 5 topics doesn't hammer the same key 10 times. Resets between
// runs because the module is re-imported fresh. Ceiling: a very long-running
// process could exhaust one key while others are fresh. Upgrade path: track
// per-key 429 count and deprioritise exhausted keys.
let keyIndex = 0;

async function serpFetch(params) {
  const keys = getKeys();
  if (!keys.length) return null;

  // Try from the current round-robin position, wrapping once.
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (keyIndex + attempt) % keys.length;
    const key = keys[idx];
    try {
      const url = new URL(SERPAPI_BASE);
      url.searchParams.set('api_key', key);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
      if (res.status === 429 || res.status === 401 || res.status === 403) continue;
      if (!res.ok) continue;
      keyIndex = (idx + 1) % keys.length; // advance for next call
      return await res.json();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Parse "1.2M views" / "418,611 views" / "5.6K views" into a number.
 */
function parseViews(str) {
  if (!str && str !== 0) return 0;
  if (typeof str === 'number') return str;
  const s = String(str).toLowerCase().replace(/,/g, '').replace(/views?/g, '').trim();
  const m = s.match(/([\d.]+)\s*(m|k)?/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const mult = m[2] === 'm' ? 1000000 : m[2] === 'k' ? 1000 : 1;
  return Math.round(num * mult);
}

/**
 * Parse "5 hours ago" / "3 days ago" / "1 month ago" into hours.
 */
function parseAge(str) {
  if (!str) return Infinity;
  const s = String(str).toLowerCase();
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
  if (!m) return Infinity;
  const n = parseInt(m[1]);
  const unit = m[2];
  const mult = { second: 1/3600, minute: 1/60, hour: 1, day: 24, week: 168, month: 720, year: 8760 };
  return n * (mult[unit] || 720);
}

/**
 * Check YouTube Shorts competition for a topic.
 * Uses the Shorts filter (sp=EgIYAQ%3D%3D) to only see vertical short-form.
 */
async function checkYouTubeShorts(query) {
  const data = await serpFetch({
    engine: 'youtube',
    search_query: query,
    gl: 'us',
    sp: 'EgIYAQ%3D%3D', // YouTube Shorts filter
  });

  if (!data?.video_results) return { shorts: [], totalViews: 0, count: 0 };

  const shorts = (data.video_results || []).map(v => ({
    title: v.title || '',
    views: parseViews(v.views),
    ageHours: parseAge(v.published_date),
    channel: v.channel?.name || v.channel || '',
    link: v.link || '',
  }));

  const totalViews = shorts.reduce((n, s) => n + s.views, 0);
  return { shorts, totalViews, count: shorts.length };
}

/**
 * Check Google Short Videos (cross-platform: YouTube + TikTok + Instagram + X).
 */
async function checkGoogleShortVideos(query) {
  const data = await serpFetch({
    engine: 'google_short_videos',
    google_domain: 'google.com',
    q: query,
    hl: 'en',
    gl: 'us',
  });

  if (!data?.short_video_results) return { results: [], count: 0 };

  const results = (data.short_video_results || []).map(s => ({
    title: s.title || '',
    source: s.source || '',
    duration: s.duration || '',
    link: s.link || '',
  }));

  return { results, count: results.length };
}

/**
 * The core strategic signal.
 *
 * @returns {object} {
 *   verdict: 'blue'|'gold'|'green'|'yellow'|'red',
 *   demandPerShort: number,
 *   totalViews: number,
 *   existingCount: number,
 *   recentHits: number,       // shorts < 72h old with > 50K views (proven velocity)
 *   crossPlatformCount: number,
 *   boost: number,            // multiplier to apply to the story score (1.0 = neutral)
 *   reason: string,
 * }
 */
export async function checkSaturation(query) {
  const [yt, gv] = await Promise.all([
    checkYouTubeShorts(query),
    checkGoogleShortVideos(query),
  ]);

  const { shorts, totalViews, count } = yt;
  const crossPlatformCount = gv.count;

  // Virgin territory — no one has made a Short on this yet
  if (count === 0) {
    return {
      verdict: 'blue',
      demandPerShort: Infinity,
      totalViews: 0,
      existingCount: 0,
      recentHits: 0,
      crossPlatformCount,
      boost: 2.0,
      reason: 'No existing Shorts — be first',
    };
  }

  const demandPerShort = Math.round(totalViews / count);

  // "Proven velocity" — a Short posted < 72h ago that already has > 50K views
  // means the audience is actively consuming this topic RIGHT NOW. This is a
  // signal TO enter, not to avoid — they validated the demand for you.
  const recentHits = shorts.filter(s => s.ageHours < 72 && s.views > 50000).length;

  // A single viral Short (> 200K in < 48h) is the strongest possible signal
  // that the topic has breakout potential and is still fresh.
  const breakout = shorts.find(s => s.ageHours < 48 && s.views > 200000);

  let verdict, boost, reason;

  if (breakout) {
    verdict = 'gold';
    boost = 1.8;
    reason = `Breakout: "${breakout.title.slice(0, 40)}" got ${(breakout.views / 1000).toFixed(0)}K in ${breakout.ageHours.toFixed(0)}h — demand is proven and active`;
  } else if (demandPerShort > 50000) {
    verdict = 'gold';
    boost = 1.6;
    reason = `${(demandPerShort / 1000).toFixed(0)}K views per Short — massive undersupply`;
  } else if (demandPerShort > 10000) {
    verdict = 'green';
    boost = 1.3;
    reason = `${(demandPerShort / 1000).toFixed(0)}K per Short — room for more`;
  } else if (demandPerShort > 2000 || recentHits > 0) {
    verdict = 'yellow';
    boost = 1.0;
    reason = recentHits
      ? `${recentHits} recent hit(s) — competitive but velocity is there`
      : `${(demandPerShort / 1000).toFixed(1)}K per Short — viable`;
  } else {
    verdict = 'red';
    boost = 0.3;
    reason = `${(demandPerShort / 1000).toFixed(1)}K per Short across ${count} — oversaturated`;
  }

  return {
    verdict,
    demandPerShort,
    totalViews,
    existingCount: count,
    recentHits,
    crossPlatformCount,
    boost,
    reason,
  };
}

/**
 * Get follow-up topic ideas from Google Trends Autocomplete.
 * After you cover topic X, these are the next Shorts to make.
 */
export async function getRelatedTopics(query) {
  const data = await serpFetch({
    engine: 'google_trends_autocomplete',
    q: query,
  });

  if (!data?.suggestions) return [];
  return data.suggestions
    .filter(s => s.title && s.title.toLowerCase() !== query.toLowerCase())
    .map(s => ({ title: s.title, type: s.type || '', query: s.q || s.title }))
    .slice(0, 5);
}

// ─── Self-check ──────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('saturation-check.js');

if (isMain) {
  console.log('\nsaturation-check self-check\n');

  const queries = [
    'house of the dragon season 3',  // known high-view topic
    'don nelson',                      // currently trending
    'xyzzy fake topic nobody covers',  // should be blue/virgin
  ];

  for (const q of queries) {
    console.log(`  "${q}":`);
    const sat = await checkSaturation(q);
    const color = { blue: '🔵', gold: '🥇', green: '🟢', yellow: '🟡', red: '🔴' }[sat.verdict] || '⚪';
    console.log(`    ${color} ${sat.verdict.toUpperCase()} — ${sat.reason}`);
    console.log(`       views: ${(sat.totalViews / 1000).toFixed(0)}K across ${sat.existingCount} Shorts`);
    console.log(`       demand/short: ${sat.demandPerShort === Infinity ? '∞' : (sat.demandPerShort / 1000).toFixed(0) + 'K'}`);
    console.log(`       cross-platform: ${sat.crossPlatformCount} short videos on Google`);
    console.log(`       boost: ${sat.boost}x`);

    const related = await getRelatedTopics(q);
    if (related.length) {
      console.log(`       follow-ups: ${related.map(r => r.title).join(', ')}`);
    }
    console.log('');
  }
}
