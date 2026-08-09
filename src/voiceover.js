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
 */
export async function generateVoiceover(text, outputPath, voice) {
  // Slower rate makes it sound dramatic, not rushed/robotic
  // Use --rate=VALUE and no pitch to avoid argparse issues with negative values
  try {
    try {
      await execFileAsync('edge-tts', [
        '--voice', voice, '--rate=-5%',
        '--text', text, '--write-media', outputPath,
      ], { timeout: 30000 });
    } catch {
      await execFileAsync('python', ['-m', 'edge_tts',
        '--voice', voice, '--rate=-5%',
        '--text', text, '--write-media', outputPath,
      ], { timeout: 30000 });
    }
  } catch (err) {
    // Some voices fail on certain texts — try fallback voice
    const fallback = 'en-US-AndrewMultilingualNeural';
    if (voice !== fallback) {
      console.log(`   ⚠ Voice ${voice} failed, trying ${fallback}`);
      await execFileAsync('python', ['-m', 'edge_tts',
        '--voice', fallback, '--rate=-5%',
        '--text', text, '--write-media', outputPath,
      ], { timeout: 30000 });
    } else {
      throw err;
    }
  }

  if (!existsSync(outputPath)) {
    throw new Error(`edge-tts did not produce ${outputPath}`);
  }
  return outputPath;
}

/**
 * Get audio duration in seconds using ffprobe.
 */
export async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ], { timeout: 10000 });
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}
