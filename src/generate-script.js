/**
 * Generate a Short script from an anime quote using an LLM.
 *
 * The model's job: take a single powerful quote and wrap it in a 20-25s Short
 * with a dramatic intro, the quote itself, and a reflective closer.
 *
 * Shape: 3 scenes (intro → quote → outro), each with narration + imageQuery.
 */
import fetch from 'node-fetch';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4.1-mini';

export const SCENE_COUNT = 3;
export const MAX_TOTAL_WORDS = 120; // ~53s at 2.27 words/sec — matches the 45-60s sweet spot

/**
 * Channel data (last 90 days) shows the sweet spot is 45-60 seconds:
 *   - 0:56 (41.7% retention, 2389 views) — Re:Zero Subaru
 *   - 0:54 (37.0% retention, 410 views) — Code Geass Lelouch
 *   - 0:49 (35.9% retention, 617 views) — Re:Zero Rem
 * Shorter clips (0:14-0:23) get 10-22% retention and <50 views.
 * The audience wants to FEEL the quote, not speed through it.
 */
export const TARGET_DURATION_SECONDS = [45, 60];

/**
 * Voice selection based on character gender and quote mood.
 * Uses the newer Multilingual voices — much more natural and dramatic.
 */
export function selectVoice(gender, mood) {
  if (gender === 'female') {
    return mood === 'emotional' || mood === 'inspirational'
      ? 'en-US-EmmaMultilingualNeural'
      : 'en-US-AvaMultilingualNeural';
  }
  if (mood === 'power' || mood === 'battle' || mood === 'motivational') return 'en-US-AndrewMultilingualNeural';
  if (mood === 'emotional' || mood === 'philosophical' || mood === 'inspirational') return 'en-US-BrianMultilingualNeural';
  return 'en-US-AndrewMultilingualNeural';
}

function buildPrompt(quote) {
  return `You write YouTube Shorts scripts for "Anime Resonance" — a channel that presents powerful anime quotes with dramatic narration.

QUOTE: "${quote.quote}"
CHARACTER: ${quote.character}
ANIME: ${quote.anime}
MOOD: ${quote.mood}
GENDER: ${quote.gender}

Write a 3-scene script for a 45-60 second Short. Total word count: 90-120 words across all 3 scenes. The audience wants to FEEL the quote — build atmosphere, deliver with weight, land the emotion. Do NOT rush.

═══ SCENE 1: DRAMATIC INTRO (25-35 words) ═══
Build the atmosphere. Set the emotional stage. Name what was at stake in the moment.
Paint the scene — the battle, the goodbye, the breaking point.
Use vivid sensory language: "Rain hammered the battlefield as the last standing warrior faced an army alone..."
Do NOT say "In [anime name]" — that's generic. Be cinematic. Be specific to THIS moment.
End on a dramatic pause — the breath before the quote lands.

═══ SCENE 2: THE QUOTE (exact quote, no changes) ═══
Narrate the quote EXACTLY as written above. Do not paraphrase, shorten, or alter it.
This is the emotional core. The voice will deliver it with dramatic weight.

═══ SCENE 3: REFLECTIVE OUTRO (25-35 words) ═══  
The emotional landing. What this quote means beyond the anime.
Connect it to the viewer's own life — make it personal and universal.
End with a line that creates the loop moment — something that makes the viewer want to hear it again.
Example: "Some battles are fought not with fists, but with the words you refuse to let die inside you."

═══ imageQuery per scene ═══
Each scene needs a search query for a dramatic background:
- Scene 1: moody cinematic landscape or dark dramatic sky matching the emotional tone
- Scene 2: ${quote.character} ${quote.anime} anime scene (the character in an emotional moment)
- Scene 3: emotional cinematic scene — rain, sunset, stars, silhouette — matching the mood

═══ YOUTUBE METADATA ═══
- title: under 70 chars. Format: "${quote.anime} - ${quote.character}'s [emotional descriptor] [Words/Speech/Quote]" Include (Dub) if English.
- description: 3-4 lines. The full quote in quotes, attributed to character and anime with episode if known. Then a line about why this moment matters. Then "Subscribe for more powerful anime moments."
- hashtags: #anime #${quote.anime.replace(/[^a-zA-Z0-9]/g, '')} #${quote.character.replace(/[^a-zA-Z0-9]/g, '')} #animequotes #shorts #animespeech #motivation
- tags: Generate 25-30 tags covering: character name, anime name, related characters, genre, mood, anime quotes, motivation, emotional anime, similar anime names, voice actor if known. Each tag under 30 chars. Fill close to the 500 char YouTube limit.

Return ONLY valid JSON matching this exact schema:`;
}

const SCRIPT_SCHEMA = {
  name: 'anime_short_script',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['scenes', 'youtube'],
    properties: {
      scenes: {
        type: 'array',
        description: '3 scenes: intro, quote, outro',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['narration', 'imageQuery'],
          properties: {
            narration: { type: 'string' },
            imageQuery: { type: 'string' },
          },
        },
      },
      youtube: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'hashtags', 'tags'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export async function generateScript(quote) {
  const rawKey = config.openrouter?.apiKey
    || process.env.OPENROUTER_API_KEY
    || '';
  // Strip wrapping quotes — GitHub Secrets UI sometimes adds them if pasted with quotes
  const apiKey = rawKey.replace(/^["']|["']$/g, '').trim();
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY configured');
  if (apiKey.length < 10) throw new Error(`API key looks invalid (${apiKey.length} chars)`);

  const prompt = buildPrompt(quote);

  const res = await fetch(OPENROUTER_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/IMNotBoT3/anime-shorts-pipeline',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      response_format: { type: 'json_schema', json_schema: SCRIPT_SCHEMA },
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;

  if (choice?.finish_reason === 'length') {
    throw new Error('response hit max_tokens — truncated');
  }
  if (!content) throw new Error(`Empty completion (finish_reason: ${choice?.finish_reason})`);

  const script = JSON.parse(content);

  // Ensure scene 2 is the exact quote (model sometimes paraphrases)
  if (script.scenes?.length >= 2) {
    script.scenes[1].narration = quote.quote;
  }

  // Attach voice selection
  script.voice = selectVoice(quote.gender, quote.mood);
  script.quote = quote;

  const totalWords = script.scenes.reduce((n, s) => n + s.narration.split(/\s+/).length, 0);
  console.log(`   ${script.scenes.length} scenes, ${totalWords} words, voice: ${script.voice}`);

  return script;
}
