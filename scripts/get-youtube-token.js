/**
 * OAuth2 token setup for YouTube uploads.
 * Run once: npm run auth
 * Follow the browser prompt, paste the code, get a refresh token.
 */
import { google } from 'googleapis';
import { createInterface } from 'node:readline';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

console.log('\nAnime Resonance — YouTube OAuth Setup\n');
console.log('You need a Google Cloud project with YouTube Data API v3 enabled.');
console.log('Create OAuth credentials (Desktop app type) and enter them below.\n');

const clientId = await ask('Client ID: ');
const clientSecret = await ask('Client Secret: ');

const auth = new google.auth.OAuth2(clientId.trim(), clientSecret.trim(), 'urn:ietf:wg:oauth:2.0:oob');

const url = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
console.log(`\nOpen this URL in your browser:\n${url}\n`);

const code = await ask('Paste the authorization code: ');
const { tokens } = await auth.getToken(code.trim());

console.log('\n=== Add these to your GitHub Secrets ===\n');
console.log(`YOUTUBE_CLIENT_ID=${clientId.trim()}`);
console.log(`YOUTUBE_CLIENT_SECRET=${clientSecret.trim()}`);
console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log('\nDone. The pipeline can now upload to your channel.');

rl.close();
