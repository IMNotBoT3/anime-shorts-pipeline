/**
 * Fetch current subscriber count from YouTube Data API.
 *
 * Used to burn a "X/GOAL 🎯 Subscribe" overlay into each Short. The count is
 * pulled once per run and cached — it won't change between the 5 Shorts in a
 * single batch, and calling the API per-render would waste quota.
 *
 * Self-check: `node src/sub-count.js`
 */
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

let cached = null;

function authorise() {
  const { clientId, clientSecret, refreshToken } = config.youtube || {};
  if (!clientId || !clientSecret || !refreshToken) return null;
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

/**
 * Get the channel's current subscriber count.
 * Returns { count, goal, text } or null on failure.
 */
export async function getSubGoal(goal = 100) {
  if (cached) return cached;

  try {
    const auth = authorise();
    if (!auth) return null;

    const yt = google.youtube({ version: 'v3', auth });
    const res = await yt.channels.list({
      part: ['statistics'],
      mine: true,
    });

    const stats = res.data?.items?.[0]?.statistics;
    if (!stats) return null;

    const count = parseInt(stats.subscriberCount || '0', 10);
    cached = {
      count,
      goal,
      text: `${count}/${goal}`,
      percentage: Math.min(100, Math.round((count / goal) * 100)),
    };

    return cached;
  } catch (err) {
    console.warn(`  ⚠ Could not fetch sub count: ${err.message?.split('\n')[0]}`);
    return null;
  }
}

/**
 * Reset the cache (for testing or multi-channel use).
 */
export function resetSubCache() {
  cached = null;
}

// ─── Self-check ──────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('sub-count.js');

if (isMain) {
  console.log('\nsub-count self-check\n');
  const data = await getSubGoal(100);
  if (data) {
    console.log(`  Subscribers: ${data.count}`);
    console.log(`  Goal:        ${data.goal}`);
    console.log(`  Display:     ${data.text}`);
    console.log(`  Progress:    ${data.percentage}%`);
    console.log('\n  ✓ sub count works');
  } else {
    console.log('  ✗ Could not fetch (no YouTube credentials or API error)');
  }
}
