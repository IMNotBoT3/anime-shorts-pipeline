# Anime Resonance — Automated YouTube Pipeline

Produces anime Shorts and long-form videos, ranked by measured demand/supply ratio from YouTube + Google Trends. Renders through HyperFrames (word-by-word karaoke, GSAP motion, transitions) for 50%+ retention.

## Quick Start

```bash
# Install dependencies
npm install
pip install -r requirements.txt

# Preview 5 Shorts (no upload)
node src/index.js --once --preview

# Publish 5 Shorts to YouTube
node src/index.js --once

# Preview trending long-form (no upload)
npm run longform:trending:preview

# Publish trending long-form
npm run longform:trending

# Publish quote compilation long-form (legacy)
npm run longform
```

## Commands

| Command | What it does |
|---------|-------------|
| `node src/index.js --once` | Pick 5 best topics, render + upload all |
| `node src/index.js --once --preview` | Same but no upload (safe test) |
| `node src/index.js --once --skip-saturation` | Skip API checks (saves budget during dev) |
| `npm run longform:trending` | 1 long-form (3 min) on the #1 trending topic, upload |
| `npm run longform:trending:preview` | Same but no upload |
| `npm run longform` | Quote compilation long-form (legacy, uses static themes) |
| `npm run longform -- --preview` | Preview legacy long-form |
| `node src/pick-topics.js` | See what topics would be picked (no render) |
| `node src/fetch-quotes.js` | Test live quote sources |
| `node src/fetch-news.js` | Test anime news feeds |
| `node src/saturation-check.js` | Test demand/supply check on sample queries |
| `node src/sub-count.js` | Check current subscriber count |

## How It Works

### Shorts Pipeline (`node src/index.js --once`)

1. **Pick topics** — generates 40+ candidates across 4 content types:
   - Quotes (live from AnimeChan, Yurippe, katanime, Exa + static bank)
   - News (ANN, Anime Corner, MyAnimeList, Siliconera, Google News)
   - Rankings ("Top 5 strongest in [trending anime]")
   - Debates ("Is [anime] overrated?")

2. **Saturation check** — queries YouTube Shorts + Google Short Videos per topic:
   - BLUE (0 existing Shorts) → 2x boost, be first
   - GOLD (>50K views/short) → 1.6x boost, undersupplied
   - GREEN (>10K views/short) → 1.3x boost
   - RED (<2K views/short) → skip, oversaturated

3. **Generate script** — LLM (OpenRouter, GPT-4.1-mini) writes the narration per scene

4. **Fetch art** — Danbooru (character-tagged) → Wallhaven (anime category) → AniList → Pexels/Unsplash

5. **Voiceover** — edge-tts with word-level timestamps for karaoke sync

6. **Compose** — HyperFrames HTML composition with:
   - Word-by-word karaoke captions (red → white flash)
   - GSAP Ken Burns motion (8 patterns, zoom-reveal on scene 1)
   - Scene crossfades + red flash transitions
   - Progress bar (top), film grain, vignette
   - Subscriber goal badge (top center)
   - "ANIME RESONANCE" watermark (bottom center)

7. **Render** — HyperFrames CLI (headless Chromium, frame-by-frame)

8. **Upload** — YouTube Data API, auto-generated titles/tags/description

### Long-form Pipeline (`npm run longform:trending`)

Same topic picker, but produces a 2.5-3 minute video:
- Rankings → 5-item countdown
- News → deep-dive explainer
- Debates → persuasive essay
- Quotes → single-anime compilation

Rendered with ffmpeg (blurred backdrop + contained art + bottom captions + rank pills + crossfade + BGM). Plus HyperFrames thumbnail uploaded via YouTube API.

## Configuration

`config.json` (git skip-worktree, never committed):
- `openrouter.apiKey` — LLM for scripts
- `youtube.clientId/clientSecret/refreshToken` — upload + sub count
- `serpapi.keys[]` — Google Trends + saturation check (17 keys, 4250/month)
- `exa.apiKey` — trending quote search
- `unsplash.accessKey` / `pexels.apiKey` — fallback images
- `poll.maxShortsPerRun` — how many Shorts per run (default: 5)

## CI (GitHub Actions)

Runs automatically 4x/day (every 6 hours). Each run:
- Picks top 2 topics (fits 25-min timeout)
- Renders + uploads
- Commits `.seen-quotes.json` + `published.csv`

Trigger manually: `gh workflow run generate.yml`

## Key Files

```
src/
  index.js              — Main entry, orchestrates everything
  pick-topics.js        — Strategic topic picker (quotes + news + rankings + debates)
  saturation-check.js   — YouTube demand/supply ratio check
  compose-anime.js      — HyperFrames HTML composition (the visual engine)
  generate-script.js    — LLM script generation (quote + topic prompts)
  fetch-quotes.js       — Live quote sources (AnimeChan, Yurippe, katanime, Exa, Reddit)
  fetch-news.js         — Anime news feeds (ANN, MAL, Anime Corner, Google News, Reddit)
  fetch-images.js       — Art sourcing (Danbooru → Wallhaven → AniList → stock)
  voiceover.js          — edge-tts with word timestamps
  transcribe.js         — Word-level sync for karaoke captions
  render.js             — ffmpeg renderer (legacy, still used by CI Shorts)
  sub-count.js          — YouTube subscriber count for goal overlay
  longform-trending.js  — Trending long-form entry point
  render-longform.js    — ffmpeg long-form renderer (captions + BGM + crossfade)
  thumbnail.js          — HyperFrames thumbnail generator
  youtube-upload.js     — Upload + custom thumbnail via YouTube API
  seen-store.js         — Deduplication (never repeats content)
  tts_word_sync.py      — Python script for word-level TTS timestamps
```

## Channel

- **Name:** Anime Resonance
- **Handle:** @Animeeresonance
- **Goal:** 100 subscribers (shown on every video)
- **Content:** Quotes, rankings, news, debates — all anime
- **Strategy:** Target GOLD-rated topics (>50K views per existing Short)
