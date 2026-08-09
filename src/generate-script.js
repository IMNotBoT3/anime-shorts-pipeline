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
export const MAX_TOTAL_WORDS = 55; // ~24s at 2.27 words/sec

/**
 * Voice selection based on character gender and quote mood.
 */
export function selectVoice(gender, mood) {
  const voices = config.edgeTts?.voices || {};

  if (gender === 'female') {
    return mood === 'emotional' ? voices.female_emotional || 'en-US-AriaNeural'
      : voices.female_strong || 'en-US-JennyNeural';
  }

  // Male
  if (mood === 'power' || mood === 'battle') return voices.male_power || 'en-US-GuyNeural';
  if (mood === 'emotional' || mood === 'philosophical') return voices.male_emotional || 'en-US-DavisNeural';
  return voices.male_power || 'en-US-GuyNeural';
}

function buildPrompt(quote) {
  return `You write YouTube Shorts scripts for "Anime Resonance" — a channel that presents powerful anime quotes with dramatic narration.

QUOTE: "${quote.quote}"
CHARACTER: ${quote.character}
ANIME: ${quote.anime}
MOOD: ${quote.mood}
GENDER: ${quote.gender}

Write a 3-scene script for a 20-25 second Short. Total word count: 45-55 words across all 3 scenes.

═══ SCENE 1: INTRO (8-12 words) ═══
Set the stage. Name the character or the moment. Create anticipation.
Example tone: "When all hope was lost, one voice cut through the silence..."
Do NOT say "In [anime name]" — that's the title card's job. Be dramatic, not descriptive.

═══ SCENE 2: THE QUOTE (exact quote, no changes) ═══
Narrate the quote EXACTLY as written above. Do not paraphrase, shorten, or alter it.
This is the emotional core of the Short.

═══ SCENE 3: OUTRO (8-12 words) ═══  
The emotional landing. Reflect on what the quote means. Create the loop moment.
End with something that makes the viewer want to hear the quote again.
Example: "Some words don't just inspire. They change who you become."

═══ imageQuery per scene ═══
Each scene needs a search query for a background image:
- Scene 1: dramatic anime landscape or silhouette matching the mood
- Scene 2: the character or a scene from the anime (use character + anime name)
- Scene 3: abstract/emotional anime art matching the mood (sunset, rain, stars)

═══ YOUTUBE METADATA ═══
- title: under 60 chars, the character name + a teaser of the quote. Include the anime name.
- description: 2-3 lines, the full quote attributed, then the anime name
- hashtags: #AnimeQuotes #[AnimeName] #[CharacterName] #Shorts #Motivation

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
