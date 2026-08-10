/**
 * Strategic topic picker for the anime Shorts pipeline.
 *
 * Picks the 5 highest-potential topics from multiple content types, ranked by
 * the saturation check's demand/supply ratio. Not limited to quotes — anything
 * anime-related that has proven demand and low competition.
 *
 * Content types:
 *   - quotes     (existing bank + live fetchers)
 *   - news       (anime news feeds — announcements, trailers, episodes)
 *   - rankings   (top 5 strongest, best villain, saddest death, etc.)
 *   - reactions  (new episode moments, plot twists)
 *   - debates    (unpopular opinions, who would win, overrated/underrated)
 *
 * Each type generates candidate search queries, then the saturation check ranks
 * them by opportunity (demand ÷ supply). The top N become Shorts.
 *
 * Self-check: `node src/pick-topics.js`
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickQuotes, fetchTrendingAnime } from './fetch-quotes.js';
import { fetchAnimeNews, fetchTrendingTitles } from './fetch-news.js';
import { checkSaturation } from './saturation-check.js';
import { seenIds } from './seen-store.js';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

function topicId(text) {
  return `topic-${createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

// ─── Candidate generators ────────────────────────────────────────────────────

/**
 * Rankings / listicle candidates. These perform extremely well because they
 * promise a payoff ("Top 5"), trigger curiosity, and have repeat-watch value.
 */
function generateRankingCandidates(trendingAnime) {
  const templates = [
    'Top 5 strongest characters in {anime}',
    'Top 5 saddest anime deaths',
    'Top 5 anime betrayals that broke us',
    'Top 5 anime villains of all time',
    'Best anime fights of {year}',
    'Most powerful anime characters ranked',
    'Top 5 anime plot twists nobody saw coming',
    'Anime characters who could beat Goku',
    'Top 5 underrated anime you need to watch',
    'Best anime openings of all time',
    'Top 5 anime comebacks that gave us chills',
    'Anime characters with the saddest backstory',
  ];

  const year = new Date().getFullYear();
  const candidates = [];

  for (const tmpl of templates) {
    if (tmpl.includes('{anime}')) {
      for (const anime of trendingAnime.slice(0, 3)) {
        candidates.push({
          title: tmpl.replace('{anime}', anime),
          type: 'ranking',
          anime,
        });
      }
    } else {
      candidates.push({
        title: tmpl.replace('{year}', String(year)),
        type: 'ranking',
      });
    }
  }
  return candidates;
}

/**
 * Debate / hot-take candidates. These drive comments (engagement signal) because
 * people HAVE to respond when they disagree.
 */
function generateDebateCandidates(trendingAnime) {
  const templates = [
    'Is {anime} overrated?',
    '{anime} is the greatest anime of all time',
    'Unpopular anime opinions that are actually right',
    'Anime fans will fight you over this',
    'The most overrated anime character',
    'Why {anime} ending was actually perfect',
    'Anime hot takes that will make you angry',
  ];

  const candidates = [];
  for (const tmpl of templates) {
    if (tmpl.includes('{anime}')) {
      for (const anime of trendingAnime.slice(0, 3)) {
        candidates.push({
          title: tmpl.replace('{anime}', anime),
          type: 'debate',
          anime,
        });
      }
    } else {
      candidates.push({ title: tmpl, type: 'debate' });
    }
  }
  return candidates;
}

/**
 * News-driven candidates. Fresh events that people are searching NOW.
 */
async function generateNewsCandidates() {
  const news = await fetchAnimeNews({ limit: 8 }).catch(() => []);
  return news.map(n => ({
    title: n.title,
    type: 'news',
    url: n.link,
    anime: extractAnimeName(n.title),
  }));
}

/**
 * Quote candidates from the existing quote system.
 */
async function generateQuoteCandidates(count = 8) {
  const quotes = await pickQuotes(count);
  return quotes.map(q => ({
    title: `${q.anime} ${q.character} quote`,
    type: 'quote',
    quote: q,
    anime: q.anime,
  }));
}

/** Try to extract an anime name from a news headline. */
function extractAnimeName(title) {
  // Common pattern: "Anime Name Season X ..." or "Anime Name Episode Y ..."
  const m = title.match(/^(.+?)(?:\s+Season|\s+Episode|\s+Anime|\s+Film|\s+Movie|\s+Gets|\s+Reveals|\s+Ends)/i);
  return m ? m[1].trim() : '';
}

// ─── Main picker ─────────────────────────────────────────────────────────────

/**
 * Pick the top N highest-potential topics across all content types.
 *
 * Strategy:
 *   1. Generate candidates from all types
 *   2. Dedupe against already-published
 *   3. Run saturation check on each (2 API calls per candidate)
 *   4. Sort by boosted score (demand/supply ratio)
 *   5. Return top N with their saturation data
 *
 * @param {number} count - how many topics to return
 * @param {object} opts
 * @param {boolean} opts.skipSaturation - skip API calls (for testing)
 */
export async function pickTopics(count = 5, { skipSaturation = false } = {}) {
  const seen = seenIds();
  const trending = await fetchTrendingAnime().catch(() => []);
  const trendingTitles = await fetchTrendingTitles().catch(() => []);
  const allTrending = [...new Set([...trending, ...trendingTitles])].slice(0, 8);

  console.log(`  Trending anime: ${allTrending.slice(0, 4).join(', ') || '(none)'}`);

  // Generate candidates from all content types in parallel
  const [quotes, news] = await Promise.all([
    generateQuoteCandidates(8),
    generateNewsCandidates(),
  ]);

  const rankings = generateRankingCandidates(allTrending);
  const debates = generateDebateCandidates(allTrending);

  const allCandidates = [...quotes, ...news, ...rankings, ...debates];
  console.log(`  Candidates: ${quotes.length} quotes, ${news.length} news, ${rankings.length} rankings, ${debates.length} debates = ${allCandidates.length} total`);

  // Dedupe against already-published
  const fresh = allCandidates.filter(c => !seen.has(topicId(c.title)));

  if (!fresh.length) {
    console.log('  No fresh candidates after dedup.');
    return [];
  }

  // Saturation check — rank by opportunity
  if (skipSaturation) {
    // Without saturation data, prefer news (timely) > rankings (evergreen) > quotes > debates
    const priority = { news: 4, ranking: 3, quote: 2, debate: 1 };
    fresh.sort((a, b) => (priority[b.type] || 0) - (priority[a.type] || 0));
    return fresh.slice(0, count).map(c => ({ ...c, id: topicId(c.title), saturation: null }));
  }

  console.log('  Checking saturation (YouTube + Google Short Videos)...');

  // Check top candidates only to save API budget. Pick the best from each type
  // plus any news items, up to ~12 candidates checked.
  const toCheck = [];
  const byType = {};
  for (const c of fresh) {
    byType[c.type] = byType[c.type] || [];
    byType[c.type].push(c);
  }

  // Take top 3 from each type (quotes already scored by trending, news by recency)
  for (const type of ['quote', 'news', 'ranking', 'debate']) {
    const pool = byType[type] || [];
    toCheck.push(...pool.slice(0, 3));
  }

  const checked = [];
  for (const c of toCheck) {
    // Build a search query that matches what a viewer would actually type
    const searchQuery = c.type === 'quote'
      ? `${c.anime} anime quotes`
      : c.type === 'ranking'
        ? c.title
        : c.type === 'news'
          ? `${c.anime || c.title.split(' ').slice(0, 4).join(' ')} anime`
          : c.title;

    const sat = await checkSaturation(searchQuery);
    const color = { blue: '🔵', gold: '🥇', green: '🟢', yellow: '🟡', red: '🔴' }[sat.verdict] || '⚪';
    console.log(`    ${color} ${sat.verdict.padEnd(6)} [${c.type.padEnd(7)}] ${c.title.slice(0, 50)}`);

    if (sat.verdict === 'red') continue; // skip oversaturated

    checked.push({
      ...c,
      id: topicId(c.title),
      saturation: sat,
      finalScore: sat.boost * (c.type === 'news' ? 1.2 : 1.0), // news gets a freshness nudge
    });
  }

  checked.sort((a, b) => b.finalScore - a.finalScore);
  return checked.slice(0, count);
}

// ─── Self-check ──────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('pick-topics.js');

if (isMain) {
  console.log('\npick-topics self-check\n');
  const topics = await pickTopics(5, { skipSaturation: process.argv.includes('--skip-saturation') });
  console.log(`\n  Picked ${topics.length} topic(s):\n`);
  for (const t of topics) {
    const sat = t.saturation;
    const satInfo = sat ? `${sat.verdict} ${(sat.demandPerShort === Infinity ? '∞' : (sat.demandPerShort/1000).toFixed(0)+'K')}/short` : 'no-check';
    console.log(`    [${t.type.padEnd(7)}] ${satInfo.padEnd(18)} ${t.title.slice(0, 55)}`);
  }
}
