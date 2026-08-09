/**
 * Quote source for the anime Shorts pipeline.
 *
 * Live fetchers (tried in parallel, merged + deduped):
 *   1. AnimeChan API — free, no auth, random anime quotes
 *   2. Exa search — "best [trending anime] quotes" (key in env/config)
 *   3. r/animequotes RSS via rss.app — recent community posts
 *
 * Fallback: quotes.json curated bank (always available).
 *
 * Returns quotes shaped for processQuote():
 *   { id, quote, character, anime, gender, mood, imageQuery }
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fetch from 'node-fetch';

import { seenIds } from './seen-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUOTES_FILE = join(__dirname, '..', 'quotes.json');
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

/** Stable id from the quote text — same quote never publishes twice. */
export function quoteId(quote) {
  return `q-${createHash('sha256').update(quote.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

// ─── Live source: AnimeChan ──────────────────────────────────────────────────

async function fetchAnimeChan(count = 10) {
  try {
    const res = await fetch(`https://animechan.io/api/v1/quotes/random?limit=${count}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const quotes = data.data || data || [];
    return quotes
      .filter((q) => q.content && q.character?.name && q.anime?.name)
      .filter((q) => q.content.length >= 30 && q.content.length <= 300)
      .map((q) => ({
        quote: q.content,
        character: q.character.name,
        anime: q.anime.name,
        gender: 'male', // AnimeChan doesn't provide gender; default
        mood: inferMood(q.content),
        source: 'animechan',
      }));
  } catch {
    return [];
  }
}

// ─── Live source: Exa search ─────────────────────────────────────────────────

async function fetchExaQuotes(trendingAnime = []) {
  const key = process.env.EXA_API_KEY || config.exa?.apiKey;
  if (!key) return [];

  // Search for quotes from trending shows
  const searchTerms = trendingAnime.length
    ? trendingAnime.slice(0, 3).map((a) => `best "${a}" anime quotes`)
    : ['best anime quotes inspirational 2024 2025'];

  const results = [];
  for (const query of searchTerms) {
    try {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify({
          query,
          numResults: 5,
          type: 'neural',
          useAutoprompt: true,
          contents: { text: { maxCharacters: 2000 } },
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.results || []) {
        const extracted = extractQuotesFromText(r.text || '', trendingAnime);
        results.push(...extracted);
      }
    } catch {
      continue;
    }
  }
  return results;
}

/**
 * Extract quote-like sentences from Exa text results.
 * Looks for patterns like "quote" — Character or "quote" - Character, Anime
 */
function extractQuotesFromText(text, knownAnime = []) {
  const quotes = [];
  // Pattern: "..." — Character (from Anime) or similar
  const patterns = [
    /[""]([^""]{30,250})[""][\s]*[—–-]\s*([A-Z][^,\n]{2,30})(?:,\s*(.+?))?(?:\n|$)/g,
    /[""]([^""]{30,250})[""][\s]*[—–-]\s*([A-Z][^,\n]{2,30})(?:\s+\((.+?)\))?/g,
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const [, q, char, anime] = m;
      if (q && char) {
        quotes.push({
          quote: q.trim(),
          character: char.trim(),
          anime: anime?.trim() || guessAnime(char.trim(), knownAnime) || 'Unknown',
          gender: 'male',
          mood: inferMood(q),
          source: 'exa',
        });
      }
    }
  }
  return quotes.slice(0, 5);
}

function guessAnime(character, knownAnime) {
  // Well-known character -> anime mapping for common ones
  const map = {
    'naruto': 'Naruto', 'sasuke': 'Naruto', 'itachi': 'Naruto',
    'luffy': 'One Piece', 'zoro': 'One Piece',
    'goku': 'Dragon Ball Z', 'vegeta': 'Dragon Ball Z',
    'tanjiro': 'Demon Slayer', 'gojo': 'Jujutsu Kaisen',
    'eren': 'Attack on Titan', 'levi': 'Attack on Titan',
  };
  const key = character.toLowerCase().split(/\s/)[0];
  return map[key] || '';
}

// ─── Live source: r/animequotes RSS ─────────────────────────────────────────

async function fetchRedditRSS() {
  // rss.app feed for r/animequotes (public, no auth)
  const FEED_URL = 'https://www.reddit.com/r/animequotes/hot.json?limit=20';
  try {
    const res = await fetch(FEED_URL, {
      headers: { 'User-Agent': 'AnimeResonanceBot/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const posts = data?.data?.children || [];

    return posts
      .map((p) => p.data)
      .filter((d) => d.title && !d.over_18)
      .map((d) => parseRedditTitle(d.title))
      .filter((q) => q && q.quote.length >= 20 && q.quote.length <= 300);
  } catch {
    return [];
  }
}

/**
 * Parse r/animequotes post titles. Common formats:
 *   "Quote text" — Character (Anime)
 *   "Quote text" - Character [Anime]
 *   Character (Anime): "Quote text"
 */
function parseRedditTitle(title) {
  // Format: "quote" — Character (Anime)
  let m = title.match(/[""](.+?)[""][\s]*[—–\-:]+\s*([^(\[]+?)[\s]*(?:\((.+?)\)|\[(.+?)\])/);
  if (m) {
    return {
      quote: m[1].trim(),
      character: m[2].trim(),
      anime: (m[3] || m[4] || '').trim(),
      gender: 'male',
      mood: inferMood(m[1]),
      source: 'reddit',
    };
  }
  // Format: Character (Anime): "quote"
  m = title.match(/^([^(\[]+?)[\s]*(?:\((.+?)\)|\[(.+?)\])[\s]*:?\s*[""](.+?)[""]$/);
  if (m) {
    return {
      quote: m[4].trim(),
      character: m[1].trim(),
      anime: (m[2] || m[3] || '').trim(),
      gender: 'male',
      mood: inferMood(m[4]),
      source: 'reddit',
    };
  }
  return null;
}

// ─── Mood inference ──────────────────────────────────────────────────────────

function inferMood(text) {
  const t = text.toLowerCase();
  if (/fight|kill|destroy|power|strong|crush|weak/.test(t)) return 'power';
  if (/never give up|keep going|stand up|protect|hero/.test(t)) return 'motivational';
  if (/love|heart|cry|tear|miss you|goodbye|alone/.test(t)) return 'emotional';
  if (/life|death|world|truth|meaning|exist|human/.test(t)) return 'philosophical';
  if (/dream|hope|future|beautiful|shine|believe/.test(t)) return 'inspirational';
  return 'motivational'; // safe default
}

// ─── AniList trending (unchanged) ────────────────────────────────────────────

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

// ─── Static bank fallback ────────────────────────────────────────────────────

/** Load the curated bank. Exported — longform.js builds compilations from it. */
export function loadQuotes() {
  try {
    const data = JSON.parse(readFileSync(QUOTES_FILE, 'utf-8'));
    return (data.quotes || []).map((q) => ({ ...q, source: 'bank' }));
  } catch {
    return [];
  }
}

// ─── Main picker ─────────────────────────────────────────────────────────────

/**
 * Pick the next quote(s) to turn into Shorts.
 *
 * Strategy:
 *   1. Fetch from all live sources in parallel
 *   2. Merge + dedupe with static bank
 *   3. Filter already-published
 *   4. Prefer trending anime, then fresh live quotes, then bank
 */
export async function pickQuotes(count = 2) {
  const seen = seenIds();
  const trending = await fetchTrendingAnime();
  const trendingSet = new Set(trending.map((t) => t.toLowerCase()));

  console.log(`  Trending: ${trending.slice(0, 5).join(', ') || '(none)'}`);

  // Fetch all sources in parallel
  const [animechan, exa, reddit] = await Promise.all([
    fetchAnimeChan(10),
    fetchExaQuotes(trending),
    fetchRedditRSS(),
  ]);

  console.log(`  Sources: AnimeChan=${animechan.length}, Exa=${exa.length}, Reddit=${reddit.length}`);

  // Merge all sources + static bank
  const bank = loadQuotes();
  const all = [...animechan, ...exa, ...reddit, ...bank];

  // Dedupe by quote hash, filter seen
  const deduped = new Map();
  for (const q of all) {
    if (!q.quote || !q.character || !q.anime || q.anime === 'Unknown') continue;
    const id = quoteId(q.quote);
    if (seen.has(id)) continue;
    if (deduped.has(id)) continue;
    deduped.set(id, { ...q, id, imageQuery: `${q.anime} ${q.character} anime dramatic scene` });
  }

  const fresh = [...deduped.values()];
  if (!fresh.length) {
    console.log('  ⚠ No fresh quotes from any source.');
    return [];
  }

  // Score: trending boost + live source boost
  const scored = fresh.map((q) => ({
    ...q,
    score: (trendingSet.has(q.anime.toLowerCase()) ? 10 : 0)
      + (q.source !== 'bank' ? 3 : 0)
      + Math.random() * 2, // tie-break variety
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count);
}

// ─── self-check ──────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('fetch-quotes.js');

if (isMain) {
  console.log('\nfetch-quotes self-check\n');
  const trending = await fetchTrendingAnime();
  console.log(`  AniList trending: ${trending.length} shows (${trending.slice(0, 3).join(', ')}...)`);

  const [animechan, exa, reddit] = await Promise.all([
    fetchAnimeChan(5),
    fetchExaQuotes(trending),
    fetchRedditRSS(),
  ]);
  console.log(`  AnimeChan: ${animechan.length} quotes`);
  console.log(`  Exa: ${exa.length} quotes`);
  console.log(`  Reddit: ${reddit.length} quotes`);

  const bank = loadQuotes();
  console.log(`  Bank: ${bank.length} quotes`);

  const picks = await pickQuotes(2);
  console.log(`\n  Picked ${picks.length} quote(s):`);
  for (const q of picks) {
    console.log(`    [${q.source}/${q.mood}] "${q.quote.slice(0, 50)}..." — ${q.character}, ${q.anime}`);
  }
  console.log('\n  ✓ quote source works');
}
