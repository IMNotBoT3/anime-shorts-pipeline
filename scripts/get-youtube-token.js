/**
 * OAuth2 token setup for YouTube uploads.
 * Run once: npm run auth
 * Starts a local HTTP server to catch the redirect, no manual code pasting.
 */
import { google } from 'googleapis';
import { createServer } from 'node:http';
import { URL } from 'node:url';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

const REDIRECT_URI = 'http://localhost:3000/callback';

import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

console.log('\nAnime Resonance — YouTube OAuth Setup\n');

const clientId = (await ask('Client ID: ')).trim();
const clientSecret = (await ask('Client Secret: ')).trim();

const auth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const url = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

console.log(`\nOpen this URL in your browser:\n\n${url}\n`);
console.log('Waiting for the redirect on localhost:3000...\n');

// Start a tiny server to catch the OAuth callback
const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const parsed = new URL(req.url, 'http://localhost:3000');
    const authCode = parsed.searchParams.get('code');
    if (authCode) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Done! You can close this tab.</h1><p>Go back to your terminal.</p>');
      server.close();
      resolve(authCode);
    } else {
      res.writeHead(400);
      res.end('No code received');
    }
  });

  server.listen(3000, () => {
    console.log('  Listening on http://localhost:3000/callback ...');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port 3000 is in use. Close whatever is using it and retry.');
    }
    reject(err);
  });

  // Timeout after 5 minutes
  setTimeout(() => { server.close(); reject(new Error('Timed out waiting for auth')); }, 300000);
});

const { tokens } = await auth.getToken(code);

console.log('\n=== Add these as GitHub Secrets ===\n');
console.log(`YOUTUBE_CLIENT_ID=${clientId}`);
console.log(`YOUTUBE_CLIENT_SECRET=${clientSecret}`);
console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log('\nDone! The pipeline can now upload to the channel.');

rl.close();
