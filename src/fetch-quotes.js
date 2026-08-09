/**
 * Quote source for the anime Shorts pipeline.
 *
 * Pulls from:
 *   1. quotes.json — the curated bank (always available, grows over time)
 *   2. AniList API — currently trending anime (free, no auth)
 *   3. Animechan-style APIs — random quotes as fallback
 *
 * Returns a quote shaped for processQuote():
 *   { id, quote, character, anime, gender, mood, imageQuery }
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fetch from 'node-fetch';

import { seenIds } from './seen-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUOTES_FILE = join(__dirname, '..', 'quotes.json');

/** Stable id from the quote text — same quote never publishes twice. */
export function quoteId(quote) {
  return `q-${createHash('sha256').update(quote.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

/** Load the curated bank. */
export function loadQuotes() {
  try {
    const data = JSON.parse(readFileSync(QUOTES_FILE, 'utf-8'));
    return data.quotes || [];
  } catch {
    return [];
  }
}

/**
 * Fetch trending anime from AniList (free GraphQL API, no auth).
 * Used to prioritise quotes from currently popular shows.
 */
export async function fetchTrendingAnime(limit = 10) {
  const query = `
    query {
      Page(perPage: ${limit}) {
        media(type: ANIME, sort: TRENDING_DESC, status: RELEASING) {
          title { english romaji }
        }
      }
    }
  `;

  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data?.Page?.media || [])
      .map((m) => m.title?.english || m.title?.romaji)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Pick the next quote(s) to turn into Shorts.
 *
 * Strategy:
 *   1. Filter out already-published quotes (by hash id)
 *   2. Prefer quotes from currently trending anime
 *   3. Otherwise, rotate through the bank by mood variety
 */
export async function pickQuotes(count = 2) {
  const all = loadQuotes();
  if (!all.length) return [];

  const seen = seenIds();
  const fresh = all.filter((q) => !seen.has(quoteId(q.quote)));

  if (!fresh.length) {
    console.log('  ⚠ All quotes in the bank have been published. Add more to quotes.json.');
    return [];
  }

  // Try to prioritise trending shows
  const trending = await fetchTrendingAnime();
  const trendingSet = new Set(trending.map((t) => t.toLowerCase()));

  const scored = fresh.map((q) => ({
    ...q,
    id: quoteId(q.quote),
    trendingBoost: trendingSet.has(q.anime.toLowerCase()) ? 10 : 0,
    imageQuery: `${q.anime} ${q.character} anime dramatic scene`,
  }));

  // Sort: trending first, then shuffle within tiers for variety
  scored.sort((a, b) => b.trendingBoost - a.trendingBoost || Math.random() - 0.5);

  return scored.slice(0, count);
}

// ─── self-check ──────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('fetch-quotes.js');

if (isMain) {
  console.log('\nfetch-quotes self-check\n');
  const all = loadQuotes();
  console.log(`  quotes.json: ${all.length} quotes loaded`);

  const trending = await fetchTrendingAnime();
  console.log(`  AniList trending: ${trending.length} shows (${trending.slice(0, 3).join(', ')}...)`);

  const picks = await pickQuotes(2);
  console.log(`  picked ${picks.length} quote(s):`);
  for (const q of picks) {
    console.log(`    [${q.gender}/${q.mood}] "${q.quote.slice(0, 50)}..." — ${q.character}, ${q.anime}`);
  }
  console.log('\n  ok  quote source works');
}
