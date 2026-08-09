/**
 * Text-to-speech via edge-tts with dramatic voice selection.
 *
 * The key to non-robotic output: use the HD/Multilingual voices (not the old
 * Neural ones), set a slower rate for drama, and use SSML prosody tags for
 * emphasis on key words.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));
const execFileAsync = promisify(execFile);

/**
 * Voice map — using the newer, more expressive voices.
 * en-US-AndrewMultilingualNeural and en-US-AvaMultilingualNeural are the most
 * natural-sounding Edge voices available. They handle drama, pauses, and
 * emotional delivery far better than the older Guy/Jenny/Davis voices.
 */
const VOICES = {
  male_power: 'en-US-AndrewMultilingualNeural',     // deep, cinematic
  male_emotional: 'en-US-BrianMultilingualNeural',   // warm narrator
  female_strong: 'en-US-AvaMultilingualNeural',      // confident, clear
  female_emotional: 'en-US-EmmaMultilingualNeural',  // expressive, warm
  narrator: 'en-US-AndrewMultilingualNeural',        // authoritative
};

/**
 * Select the best voice for a quote based on character gender and mood.
 */
export function selectVoice(gender, mood) {
  if (gender === 'female') {
    return mood === 'emotional' || mood === 'inspirational'
      ? VOICES.female_emotional
      : VOICES.female_strong;
  }
  if (mood === 'power' || mood === 'battle' || mood === 'motivational') return VOICES.male_power;
  if (mood === 'emotional' || mood === 'philosophical' || mood === 'inspirational') return VOICES.male_emotional;
  return VOICES.male_power;
}

/**
 * Generate an MP3 from text using edge-tts.
 * Uses slower rate (-5%) for dramatic delivery instead of rushed +5%.
 * Writes text to a temp file to avoid shell argument parsing issues on Windows.
 */
export async function generateVoiceover(text, outputPath, voice) {
  const { resolve } = await import('node:path');
  const absOutput = resolve(outputPath);
  const tmpFile = absOutput + '.txt';
  writeFileSync(tmpFile, text);

  try {
    try {
      await execFileAsync('edge-tts', [
        '--voice', voice, '--rate=-5%',
        '--file', tmpFile, '--write-media', absOutput,
      ], { timeout: 30000 });
    } catch {
      await execFileAsync('python', ['-m', 'edge_tts',
        '--voice', voice, '--rate=-5%',
        '--file', tmpFile, '--write-media', absOutput,
      ], { timeout: 30000 });
    }
  } catch (err) {
    const fallback = 'en-US-AndrewMultilingualNeural';
    if (voice !== fallback) {
      console.log(`   ⚠ Voice ${voice} failed, trying ${fallback}`);
      try {
        await execFileAsync('edge-tts', [
          '--voice', fallback, '--rate=-5%',
          '--file', tmpFile, '--write-media', absOutput,
        ], { timeout: 30000 });
      } catch {
        await execFileAsync('python', ['-m', 'edge_tts',
          '--voice', fallback, '--rate=-5%',
          '--file', tmpFile, '--write-media', absOutput,
        ], { timeout: 30000 });
      }
    } else {
      throw err;
    }
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }

  if (!existsSync(absOutput)) {
    throw new Error(`edge-tts did not produce ${absOutput}`);
  }
  return outputPath;
}

/**
 * Get audio duration in seconds using ffprobe.
 * ponytail: resolve() fixes CI bug where relative paths fail with "No such file".
 */
export async function getAudioDuration(filePath) {
  const { resolve } = await import('node:path');
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.warn(`   ⚠ getAudioDuration: file not found: ${absPath}`);
    return 0;
  }
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      absPath,
    ], { timeout: 10000 });
    const dur = parseFloat(stdout.trim()) || 0;
    if (dur === 0) console.warn(`   ⚠ getAudioDuration: ffprobe returned 0 for ${absPath}`);
    return dur;
  } catch (err) {
    console.warn(`   ⚠ getAudioDuration ffprobe error: ${err.message}`);
    return 0;
  }
}
