/**
 * Fetch images for each scene. Uses Unsplash/Pexels for anime-aesthetic backgrounds.
 * Falls back gracefully — a missing image doesn't block the render.
 */
import fetch from 'node-fetch';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

async function searchUnsplash(query) {
  const key = config.unsplash?.accessKey || process.env.UNSPLASH_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=portrait&per_page=1`,
      { headers: { Authorization: `Client-ID ${key}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.[0]?.urls?.regular || null;
  } catch {
    return null;
  }
}

async function searchPexels(query) {
  const key = config.pexels?.apiKey || process.env.PEXELS_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=1`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.photos?.[0]?.src?.large2x || null;
  } catch {
    return null;
  }
}

async function downloadImage(url, outputPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return false;
  await pipeline(res.body, createWriteStream(outputPath));
  return true;
}

/**
 * Fetch images for all scenes. Returns array of file paths (or null for failures).
 */
export async function fetchAllImages(scenes, outputDir) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const results = [];
  for (let i = 0; i < scenes.length; i++) {
    const query = scenes[i].imageQuery;
    const outPath = join(outputDir, `scene-${i}.jpg`);

    // Try Pexels first (better anime/artistic content), then Unsplash
    let url = await searchPexels(query) || await searchUnsplash(query);

    // Fallback queries if specific one fails — use abstract/aesthetic terms that stock sites have
    if (!url) {
      const fallbacks = ['dark moody landscape dramatic sky', 'sunset silhouette person dramatic', 'night sky stars dramatic cinematic'];
      url = await searchPexels(fallbacks[i % fallbacks.length]) || await searchUnsplash(fallbacks[i % fallbacks.length]);
    }

    if (url) {
      try {
        await downloadImage(url, outPath);
        results.push(outPath);
        console.log(`  ✓ Image ${i + 1}/${scenes.length}: "${query.slice(0, 40)}"`);
        continue;
      } catch {}
    }

    console.log(`  ⚠ Image ${i + 1}/${scenes.length}: fallback for "${query.slice(0, 40)}"`);
    results.push(null);
  }

  return results;
}
