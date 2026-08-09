/**
 * YouTube upload via the Data API v3.
 */
import { google } from 'googleapis';
import { readFileSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

function authorise() {
  const { clientId, clientSecret, refreshToken } = config.youtube || {};
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube credentials missing. Run: npm run auth');
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export async function uploadToYouTube(videoPath, meta) {
  const auth = authorise();
  const yt = google.youtube({ version: 'v3', auth });

  const categoryId = meta.categoryId || config.channel?.category || '24';

  // Sanitize tags: YouTube rejects tags with #, special chars, or >30 chars each
  const rawTags = meta.tags?.length ? meta.tags : config.channel?.defaultTags || [];
  const tags = rawTags
    .map(t => String(t)
      .replace(/^#/, '')              // strip leading #
      .replace(/[^a-zA-Z0-9\s\-]/g, '') // only letters, numbers, spaces, hyphens
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
    )
    .filter(t => t.length >= 2 && t.length <= 30)
    .filter(t => !/[<>"{}|\\^`]/.test(t)) // extra safety: reject any weird chars
    .filter((t, i, arr) => arr.indexOf(t) === i) // dedupe
    .slice(0, 30);

  const title = meta.longForm
    ? (meta.title || 'Anime Compilation').replace(/#shorts|#Shorts/g, '').trim().slice(0, 100)
    : (meta.title || 'Anime Quote').replace(/#shorts|#Shorts/g, '').trim().slice(0, 95) + ' #shorts';

  // YouTube rejects more than 15 hashtags in description, and some LLM-generated
  // ones contain invalid chars. Keep it to max 5 clean ones.
  const cleanHashtags = (meta.hashtags || [])
    .map(h => h.startsWith('#') ? h : `#${h}`)
    .map(h => h.replace(/[^#a-zA-Z0-9]/g, ''))
    .filter(h => h.length > 2 && h.length < 30)
    .slice(0, 5);

  const description = [
    (meta.description || '').slice(0, 4500),
    '',
    cleanHashtags.join(' '),
  ].join('\n').trim();

  console.log(`   Tags (${tags.length}): ${tags.slice(0, 5).join(', ')}...`);
  console.log(`   Title: ${title.slice(0, 60)}`);
  console.log(`   Hashtags in desc: ${JSON.stringify(meta.hashtags?.slice(0, 5))}`);
  console.log(`   Desc (first 100): ${description.slice(0, 100)}`);
  console.log(`   Uploading: "${title.slice(0, 60)}"`);

  try {
    const res = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description, tags, categoryId, defaultLanguage: 'en' },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      },
      media: { body: createReadStream(videoPath) },
    });
    const videoId = res.data?.id;
    if (videoId) console.log(`   ✅ https://youtube.com/shorts/${videoId}`);
    return videoId || null;
  } catch (err) {
    console.error(`   ❌ Upload failed: ${err.message?.split('\n')[0]}`);
    return null;
  }
}
