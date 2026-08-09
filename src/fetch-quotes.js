/**
 * Quote sources for the anime Shorts pipeline.
 *
 * Every source here was verified against the live endpoint. The previous
 * version shipped three fetchers that all returned zero — animechan.io/api was
 * a 404 (the API lives on api.animechan.io), reddit.com's .json is 403 for
 * unauthenticated clients, and the Exa results were scraped with a regex that
 * never matched. Every published Short was silently coming from quotes.json.
 *
 * Yields per call, measured:
 *   Yurippe    ~25 quotes, clean {character, show, quote}      <- bulk source
 *   katanime   ~10 quotes, {english, character, anime}
 *   AnimeChan   1 quote per call, no limit param (400 if sent)
 *   Reddit RSS  ~25 entries, mostly noise; a few parse
 *   Exa         page text, structured by an LLM pass
 *
 * Returns quotes shaped for processQuote():
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
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; AnimeResonance/1.0)' };
const MIN_LEN = 30;
const MAX_LEN = 300;

/** Stable id from the quote text — same quote never publishes twice. */
export function quoteId(quote) {
  return `q-${createHash('sha256').update(quote.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

/**
 * Shared gate. Rejects stage directions, dialogue fragments, and anything too
 * short to carry a 45-60s Short or too long to fit on screen.
 */
function usable(q) {
  if (!q?.quote || !q.character || !q.anime) return false;
  const t = q.quote.trim();
  if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
  if (/^\*|\*$/.test(t)) return false;          // *stage direction*
  if (/\*[^*]{10,}\*/.test(t)) return false;     // embedded stage direction
  if (/^\W*$/.test(t)) return false;
  if ((t.match(/\n/g) || []).length > 4) return false;
  return true;
}

function inferMood(text) {
  const t = text.toLowerCase();
  if (/fight|kill|destroy|power|strong|crush|weak|battle/.test(t)) return 'power';
  if (/never give up|keep going|stand up|protect|hero|forward/.test(t)) return 'motivational';
  if (/love|heart|cry|tear|miss you|goodbye|alone|sad/.test(t)) return 'emotional';
  if (/life|death|world|truth|meaning|exist|human|time/.test(t)) return 'philosophical';
  if (/dream|hope|future|beautiful|shine|believe/.test(t)) return 'inspirational';
  return 'motivational';
}

// ─── Yurippe — the bulk source ───────────────────────────────────────────────

async function fetchYurippe(limit = 25) {
  try {
    const res = await fetch(`https://yurippe.vercel.app/api/quotes?random=${limit}`,
      { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((q) => ({
      quote: String(q.quote || '').trim(),
      character: String(q.character || '').trim(),
      anime: String(q.show || '').trim(),
      gender: 'unknown',
      mood: inferMood(q.quote || ''),
      source: 'yurippe',
    })).filter(usable);
  } catch {
    return [];
  }
}

// ─── katanime ────────────────────────────────────────────────────────────────

async function fetchKatanime() {
  try {
    const res = await fetch('https://katanime.vercel.app/api/getrandom',
      { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.result || []).map((q) => ({
      quote: String(q.english || '').trim(),
      character: String(q.character || '').trim(),
      anime: String(q.anime || '').trim(),
      gender: 'unknown',
      mood: inferMood(q.english || ''),
      source: 'katanime',
    })).filter(usable);
  } catch {
    return [];
  }
}

// ─── AnimeChan — one quote per request ───────────────────────────────────────

async function fetchAnimeChan(calls = 4) {
  const out = [];
  for (let i = 0; i < calls; i++) {
    try {
      // Note the host: api.animechan.io. animechan.io/api/... is a 404, and the
      // endpoint rejects a ?limit param with 400, so batching is not available.
      const res = await fetch('https://api.animechan.io/v1/quotes/random',
        { headers: UA, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const d = (await res.json()).data;
        if (d) {
          out.push({
            quote: String(d.content || '').trim(),
            character: String(d.character?.name || '').trim(),
            anime: String(d.anime?.name || '').trim(),
            gender: 'unknown',
            mood: inferMood(d.content || ''),
            source: 'animechan',
          });
        }
      }
    } catch { /* skip this call */ }
    // The API 429s under load; space the calls out.
    if (i < calls - 1) await new Promise((r) => setTimeout(r, 700));
  }
  return out.filter(usable);
}

// ─── Reddit — native RSS, because .json is 403 ───────────────────────────────

async function fetchRedditRSS() {
  try {
    const res = await fetch('https://www.reddit.com/r/animequotes/.rss',
      { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const xml = await res.text();

    // Skip entry 0: that is the feed title, not a post.
    const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)]
      .map((m) => decodeXml(m[1].trim())).slice(1);

    return titles.map(parseRedditTitle).filter(Boolean).filter(usable);
  } catch {
    return [];
  }
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

/**
 * Post titles are freeform, so most are noise ("Guess the show", "need quotes
 * for edits"). Only the three shapes that actually carry attribution are
 * accepted; anything else is dropped rather than guessed at.
 */
function parseRedditTitle(title) {
  const t = title.trim();

  // "quote" - Character (Anime)   |   "quote" - Character [Anime]
  let m = t.match(/^[“"'](.+?)[”"'][\s]*[—–\-:]+\s*([^(\[]{2,40}?)[\s]*[（(\[](.+?)[）)\]]/);
  if (m) return mk(m[1], m[2], m[3]);

  // Quote by Character: Anime
  m = t.match(/^quote by\s+([^:]{2,40}):\s*(.+)$/i);
  if (m) return mk('', m[1], m[2]);

  // "quote" - Character        (no anime -> unusable, dropped by usable())
  m = t.match(/^[“"'](.+?)[”"'][\s]*[—–\-]\s*(.{2,40})$/);
  if (m) return mk(m[1], m[2], '');

  // plain quote - Character
  m = t.match(/^(.{30,250}?)\s+[—–-]\s+([A-Z][^-–—]{2,40})$/);
  if (m) return mk(m[1], m[2], '');

  return null;
}

function mk(quote, character, anime) {
  const q = String(quote || '').trim().replace(/^[“"']|[”"']$/g, '');
  return {
    quote: q,
    character: String(character || '').trim(),
    anime: String(anime || '').trim(),
    gender: 'unknown',
    mood: inferMood(q),
    source: 'reddit',
  };
}

// ─── Exa — search, then structure with the LLM ───────────────────────────────

/**
 * Exa returns page prose, not quote records. The previous regex approach found
 * nothing on real pages, so the page text is handed to the same model the rest
 * of the pipeline uses and asked for structured output.
 *
 * This is the only source aware of what is trending right now, which is why it
 * is worth the extra call.
 */
async function fetchExaQuotes(trending = []) {
  const key = (process.env.EXA_API_KEY || config.exa?.apiKey || '').replace(/^["']|["']$/g, '').trim();
  if (!key) return [];

  const subject = trending[0] || 'anime';
  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        query: `best ${subject} anime quotes with character names`,
        numResults: 3,
        contents: { text: { maxCharacters: 3000 } },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const results = (await res.json()).results || [];
    const text = results.map((r) => r.text || '').join('\n\n').slice(0, 9000);
    if (text.length < 200) return [];
    return await extractWithLLM(text);
  } catch {
    return [];
  }
}

async function extractWithLLM(pageText) {
  const apiKey = (config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || '')
    .replace(/^["']|["']$/g, '').trim();
  if (!apiKey) return [];

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4.1-mini',
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `Extract anime quotes from the text below. Only include a quote if the character name AND anime title are both stated. Skip anything you are unsure about — precision matters more than volume.

Return JSON: {"quotes":[{"quote":"...","character":"...","anime":"...","gender":"male|female"}]}

Rules:
- quote must be 30-300 characters, verbatim from the text
- gender: the character's, as best known
- max 8 quotes

TEXT:
${pageText}`,
        }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return [];
    const content = (await res.json()).choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    return (parsed.quotes || []).map((q) => ({
      quote: String(q.quote || '').trim(),
      character: String(q.character || '').trim(),
      anime: String(q.anime || '').trim(),
      gender: q.gender === 'female' ? 'female' : 'unknown',
      mood: inferMood(q.quote || ''),
      source: 'exa',
    })).filter(usable);
  } catch {
    return [];
  }
}

// ─── AniList: trending, and character gender ─────────────────────────────────

export async function fetchTrendingAnime(limit = 10) {
  const query = `query {
    Page(perPage: ${limit}) {
      media(type: ANIME, sort: TRENDING_DESC, status: RELEASING) {
        title { english romaji }
      }
    }
  }`;
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
 * Resolve a character's gender so voiceover picks a matching voice.
 *
 * Only the live sources need this — the curated bank already carries gender. A
 * wrong value here is audible: a female character read in a male voice was one
 * of the ways the output sounded off.
 */
async function resolveGender(character) {
  if (!character) return 'unknown';
  const query = `query ($n: String) { Character(search: $n) { gender } }`;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { n: character } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return 'unknown';
    const g = (await res.json()).data?.Character?.gender;
    if (!g) return 'unknown';
    return /female/i.test(g) ? 'female' : /male/i.test(g) ? 'male' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Static bank ─────────────────────────────────────────────────────────────

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

export async function pickQuotes(count = 2) {
  const seen = seenIds();

  // Fetched once and threaded through: AniList 429s on a second call in the
  // same run, which silently zeroed the trending boost.
  const trending = await fetchTrendingAnime();
  const trendingSet = new Set(trending.map((t) => t.toLowerCase()));
  console.log(`  Trending: ${trending.slice(0, 4).join(', ') || '(none)'}`);

  const [yurippe, katanime, animechan, reddit, exa] = await Promise.all([
    fetchYurippe(25),
    fetchKatanime(),
    fetchAnimeChan(4),
    fetchRedditRSS(),
    fetchExaQuotes(trending),
  ]);

  const live = [...yurippe, ...katanime, ...animechan, ...reddit, ...exa];
  console.log(`  Sources: yurippe=${yurippe.length} katanime=${katanime.length} `
    + `animechan=${animechan.length} reddit=${reddit.length} exa=${exa.length} `
    + `-> ${live.length} live`);

  const all = [...live, ...loadQuotes()];

  const deduped = new Map();
  for (const q of all) {
    if (!usable(q)) continue;
    const id = quoteId(q.quote);
    if (seen.has(id) || deduped.has(id)) continue;
    deduped.set(id, { ...q, id });
  }

  const fresh = [...deduped.values()];
  if (!fresh.length) {
    console.log('  ⚠ No fresh quotes from any source.');
    return [];
  }

  // Trending first, then live over bank, then shuffle within tiers.
  const scored = fresh.map((q) => ({
    ...q,
    score: (trendingSet.has(q.anime.toLowerCase()) ? 10 : 0)
      + (q.source !== 'bank' ? 3 : 0)
      + Math.random() * 2,
  }));
  scored.sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, count);

  // Fill in gender only for what is actually being published.
  for (const q of picked) {
    if (q.gender === 'unknown') q.gender = await resolveGender(q.character);
    if (q.gender === 'unknown') q.gender = 'male'; // voice map needs a value
    q.imageQuery = `${q.anime} ${q.character} anime dramatic scene`;
  }

  return picked;
}

// ─── self-check ──────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('fetch-quotes.js');

if (isMain) {
  console.log('\nfetch-quotes self-check\n');
  const trending = await fetchTrendingAnime();
  console.log(`  AniList trending: ${trending.length} shows`);

  const [y, k, a, r, e] = await Promise.all([
    fetchYurippe(25), fetchKatanime(), fetchAnimeChan(2), fetchRedditRSS(), fetchExaQuotes(trending),
  ]);
  console.log(`  yurippe:   ${y.length}`);
  console.log(`  katanime:  ${k.length}`);
  console.log(`  animechan: ${a.length}`);
  console.log(`  reddit:    ${r.length}`);
  console.log(`  exa:       ${e.length}`);
  console.log(`  bank:      ${loadQuotes().length}`);

  const liveTotal = y.length + k.length + a.length + r.length + e.length;
  console.log(`\n  live total: ${liveTotal}`);
  if (liveTotal === 0) {
    console.log('  ✗ every live source returned nothing — the bank is carrying the pipeline');
    process.exit(1);
  }

  const picks = await pickQuotes(2);
  console.log(`\n  picked ${picks.length}:`);
  for (const q of picks) {
    console.log(`    [${q.source}/${q.mood}/${q.gender}] "${q.quote.slice(0, 46)}..." — ${q.character}, ${q.anime}`);
  }
  console.log('\n  ✓ live quote sourcing works');
}
