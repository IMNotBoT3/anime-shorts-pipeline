/**
 * Inject CI secrets from env vars into config.json.
 * Same pattern as HotDrop.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CONFIG_PATH = 'config.json';

const MAP = {
  OPENROUTER_API_KEY: ['openrouter', 'apiKey'],
  UNSPLASH_API_KEY: ['unsplash', 'accessKey'],
  PEXELS_API_KEY: ['pexels', 'apiKey'],
  EXA_API_KEY: ['exa', 'apiKey'],
  YOUTUBE_CLIENT_ID: ['youtube', 'clientId'],
  YOUTUBE_CLIENT_SECRET: ['youtube', 'clientSecret'],
  YOUTUBE_REFRESH_TOKEN: ['youtube', 'refreshToken'],
};

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const injected = [];
const missing = [];

for (const [envVar, [section, key]] of Object.entries(MAP)) {
  const raw = process.env[envVar];
  if (!raw) { missing.push(envVar); continue; }
  // Strip wrapping quotes — some secret managers add them
  const value = raw.replace(/^["']|["']$/g, '').trim();
  config[section] ??= {};
  config[section][key] = value;
  injected.push(envVar);
}

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
console.log(`Injected ${injected.length} secret(s)`);
if (missing.length) {
  console.warn(`Missing: ${missing.join(', ')}`);
}

if (!config.openrouter?.apiKey && !process.env.OPENROUTER_API_KEY) {
  console.error('FATAL: no OPENROUTER_API_KEY — script generation will fail.');
  process.exit(1);
}
