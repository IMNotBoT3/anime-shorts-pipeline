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
THE FIRST 3 SECONDS DECIDE EVERYTHING. 87% of viewers swipe away before hearing the quote.
Your intro must stop the thumb INSTANTLY with a visual + spoken hook.

The FIRST LINE (first 8-10 words) must work as BOLD TEXT ON SCREEN — it will appear
as a text overlay on the first frame before the voiceover finishes. It must create
an information gap or emotional tension that makes swiping away feel like missing out.

NOT: "In one of anime's most powerful moments..."  (generic, could be any video)
YES: "He watched everyone he loved die — then said THIS."  (specific, creates gap)
YES: "One sentence. That's all it took to change a coward into a hero."

After the hook line, build the atmosphere. Set the emotional stage — the battle,
the goodbye, the breaking point. Use vivid sensory language.
End on a dramatic pause — the breath before the quote lands.

═══ SCENE 2: THE QUOTE (exact quote, no changes) ═══
Narrate the quote EXACTLY as written above. Do not paraphrase, shorten, or alter it.
This is the emotional core. The voice will deliver it with dramatic weight.

═══ SCENE 3: REFLECTIVE OUTRO (25-35 words) ═══  
PREVENT GRADUAL DECLINE — by scene 3 viewers are drifting unless you RE-ESCALATE.
The outro must NOT be a calm reflection. It must hit HARDER than the quote itself.
Connect the quote to something UNIVERSAL and PERSONAL — make the viewer feel it about
their own life, their own battles, their own moments of doubt.

End with a line that creates the loop moment — something that reframes the quote so
hearing it again hits differently. The best outros make the intro feel like foreshadowing.
Example: "Some battles are fought not with fists, but with the words you refuse to let die inside you. And maybe... that voice is yours."

MANDATORY: The outro MUST end with a subscribe CTA. The LAST sentence must be one of:
- "Subscribe for more powerful anime moments."
- "Follow Anime Resonance for daily quotes that hit different."
- "Subscribe — we find these moments so you never miss them."
Do NOT skip this. Every successful anime channel verbally asks for the subscribe.

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

/**
 * Generate a script for non-quote content: rankings, news, debates, reactions.
 * Same output shape as generateScript() so the pipeline handles them uniformly.
 */
export async function generateTopicScript(topic) {
  const rawKey = (config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || '')
    .replace(/^["']|["']$/g, '').trim();
  if (!rawKey || rawKey.length < 10) throw new Error('No valid OPENROUTER_API_KEY');

  const typeInstructions = {
    ranking: `This is a "Top 5" or ranking video. Structure it as a countdown — each entry gets one scene. Create tension between entries. The hook must promise a payoff ("Wait for #1"). Each entry: name the character/anime/moment, say WHY it earns this spot in one punchy line. End with a call for disagreement ("Comment your #1").`,
    news: `This is breaking anime news. The hook must convey URGENCY — something just happened that anime fans need to know. Give the key facts fast: what happened, which anime/studio, why it matters. End by asking what viewers think or teasing what's next.`,
    debate: `This is a hot take / unpopular opinion. The hook must be PROVOCATIVE — state the take boldly enough that viewers stop to argue. Back it up with 2-3 specific examples. End with "Agree or fight me in the comments" energy.`,
    reaction: `This is a reaction to a specific anime moment. The hook must reference the moment WITHOUT spoiling it. Build the context, describe the impact, land on why it matters. Make the viewer feel the weight of what happened.`,
  };

  const prompt = `You write YouTube Shorts scripts for "Anime Resonance" — an anime channel covering quotes, news, rankings, and hot takes.

TOPIC: "${topic.title}"
TYPE: ${topic.type}
${topic.anime ? `ANIME: ${topic.anime}` : ''}
${topic.url ? `SOURCE URL: ${topic.url}` : ''}

${typeInstructions[topic.type] || typeInstructions.ranking}

Write a 3-5 scene script for a 45-60 second Short. Total: 90-120 words across all scenes.

THE FIRST 3 SECONDS DECIDE EVERYTHING. 87% of viewers swipe before scene 2.
Your hook (first 8-10 words) must stop the thumb INSTANTLY — create an information gap
or emotional tension that makes swiping feel like missing out.

Each scene needs:
- narration: the spoken text (10-25 words)
- imageQuery: a search query for the background (specific anime characters/scenes, NOT generic)

MANDATORY: The LAST scene's narration MUST end with a subscribe CTA like "Subscribe for more" or "Follow Anime Resonance for daily anime content." Every successful channel verbally asks.

YOUTUBE METADATA:
- title: under 70 chars, includes #shorts, hooks curiosity
- description: 3-4 lines, key facts, subscribe CTA
- hashtags: 5 relevant hashtags
- tags: 25-30 discovery tags under 500 chars total

Return ONLY valid JSON:
{
  "scenes": [{"narration": "...", "imageQuery": "..."}],
  "youtube": {"title": "...", "description": "...", "hashtags": [...], "tags": [...]}
}`;

  const res = await fetch(OPENROUTER_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${rawKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/IMNotBoT3/anime-shorts-pipeline',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty completion');

  const script = JSON.parse(content);
  script.voice = 'en-US-AndrewMultilingualNeural'; // narrator voice for non-quote content
  script.anime = topic.anime || '';

  const totalWords = (script.scenes || []).reduce((n, s) => n + (s.narration || '').split(/\s+/).length, 0);
  console.log(`   ${(script.scenes || []).length} scenes, ${totalWords} words`);
  console.log(`   YT: ${script.youtube?.title || '(no title)'}`);

  return script;
}
