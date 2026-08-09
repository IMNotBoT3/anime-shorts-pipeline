/**
 * Basic self-check for the anime-shorts-pipeline.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let checks = 0;
const ok = (m) => { checks++; console.log(`  ok  ${m}`); };

console.log('\nanime-shorts-pipeline self-check\n');

// quotes.json is loadable and has content
{
  const f = join(ROOT, 'quotes.json');
  assert.ok(existsSync(f), 'quotes.json must exist');
  const data = JSON.parse(readFileSync(f, 'utf-8'));
  assert.ok(data.quotes.length >= 10, `need 10+ quotes, got ${data.quotes.length}`);
  for (const q of data.quotes) {
    assert.ok(q.quote, 'every quote needs text');
    assert.ok(q.character, 'every quote needs a character');
    assert.ok(q.anime, 'every quote needs an anime');
    assert.ok(q.gender, 'every quote needs gender');
    assert.ok(q.mood, 'every quote needs mood');
  }
  ok(`quotes.json: ${data.quotes.length} valid quotes`);
}

// Voice selection works
{
  const { selectVoice } = await import('../src/generate-script.js');
  assert.ok(selectVoice('male', 'power').includes('Guy'));
  assert.ok(selectVoice('male', 'emotional').includes('Davis'));
  assert.ok(selectVoice('female', 'strong').includes('Jenny'));
  assert.ok(selectVoice('female', 'emotional').includes('Aria'));
  ok('voice selection maps gender+mood to correct voices');
}

// Seen store works
{
  const { quoteId } = await import('../src/fetch-quotes.js');
  const id1 = quoteId('test quote one');
  const id2 = quoteId('test quote two');
  assert.notEqual(id1, id2, 'different quotes must have different ids');
  assert.equal(quoteId('test quote one'), id1, 'same quote must be stable');
  assert.ok(id1.startsWith('q-'), 'ids must start with q- prefix');
  ok('quoteId is stable and unique');
}

// Config is parseable and has no secrets
{
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
  assert.ok(cfg.edgeTts?.voices, 'config must have voice settings');
  assert.ok(cfg.video?.width === 1080, 'video width must be 1080');
  assert.ok(cfg.video?.height === 1920, 'video height must be 1920');
  assert.ok(!cfg.openrouter?.apiKey, 'config must not contain API keys');
  assert.ok(!cfg.youtube?.refreshToken, 'config must not contain tokens');
  ok('config.json is valid and secret-free');
}

console.log(`\n${checks} checks passed\n`);
