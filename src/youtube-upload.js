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
  const tags = meta.tags?.length ? meta.tags : config.channel?.defaultTags || [];

  const title = meta.title.includes('#shorts') || meta.title.includes('#Shorts')
    ? meta.title : `${meta.title} #shorts`.slice(0, 100);

  const description = [
    meta.description || '',
    '',
    (meta.hashtags || []).join(' '),
  ].join('\n').trim();

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
