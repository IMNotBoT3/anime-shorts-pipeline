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
 * Generate an MP3 + word timestamps from text using edge-tts.
 *
 * Uses the Python tts_word_sync.py script which produces both the audio AND
 * a .words.json file with per-word timing. These timestamps power the
 * word-by-word karaoke captions in the HyperFrames composition — without them
 * the captions fall back to proportional timing which looks mechanical.
 *
 * Rate is -5% for dramatic delivery (not rushed like HotDrop's +10%).
 */
const TTS_SCRIPT = join(__dirname, 'tts_word_sync.py');

export async function generateVoiceover(text, outputPath, voice) {
  const { resolve } = await import('node:path');
  const absOutput = resolve(outputPath);
  const wordsPath = absOutput.replace('.mp3', '.words.json');

  // Try the word-sync Python script first (produces .mp3 + .words.json)
  try {
    // Write text to file to avoid shell quoting issues on Windows
    const tmpTextFile = absOutput + '.input.txt';
    writeFileSync(tmpTextFile, text);
    
    await execFileAsync('python', [
      TTS_SCRIPT,
      text,
      absOutput,
      wordsPath,
      voice || 'en-US-AndrewMultilingualNeural',
      '-5%',
    ], { timeout: 45000 });
    
    try { unlinkSync(tmpTextFile); } catch {}
    
    if (existsSync(absOutput)) return outputPath;
  } catch {
    // Fall through to basic edge-tts
  }

  // Fallback: basic edge-tts without word timestamps
  console.log('   ⚠ Word-sync TTS failed, using basic edge-tts (captions will use proportional timing)');
  const tmpFile = absOutput + '.txt';
  writeFileSync(tmpFile, text);

  try {
    try {
      await execFileAsync('edge-tts', [
        '--voice', voice || 'en-US-AndrewMultilingualNeural', '--rate=-5%',
        '--file', tmpFile, '--write-media', absOutput,
      ], { timeout: 30000 });
    } catch {
      await execFileAsync('python', ['-m', 'edge_tts',
        '--voice', voice || 'en-US-AndrewMultilingualNeural', '--rate=-5%',
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
 * Read word timestamps for a scene's audio.
 * Returns [{word, start, end}] or null if no .words.json exists.
 */
export function getWordTimestamps(audioPath) {
  const wordsPath = String(audioPath).replace('.mp3', '.words.json');
  if (!existsSync(wordsPath)) return null;
  try {
    const data = JSON.parse(readFileSync(wordsPath, 'utf-8'));
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

/**
 * Get audio duration in seconds.
 *
 * Tries ffprobe, then falls back to parsing ffmpeg's own stderr. The fallback
 * is not redundant: a broken or missing ffprobe binary silently yielded 0,
 * which made every scene fall back to the 8s default and desynced the render
 * from the voiceover. Returning 0 is never acceptable here, so a failure to
 * measure is thrown rather than swallowed.
 */
export async function getAudioDuration(filePath) {
  const { resolve } = await import('node:path');
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`getAudioDuration: file not found: ${absPath}`);
  }

  // 1. ffprobe — the direct route.
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      absPath,
    ], { timeout: 10000 });
    const dur = parseFloat(stdout.trim());
    if (dur > 0) return dur;
  } catch {
    // fall through
  }

  // 2. ffmpeg stderr — "Duration: 00:00:12.34, start: ...". ffmpeg exits 0 on a
  //    successful decode and non-zero on failure, and prints the header either
  //    way, so read stderr from both outcomes.
  const parseDur = (text) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text || '');
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
  };

  try {
    const { stderr } = await execFileAsync('ffmpeg',
      ['-hide_banner', '-i', absPath, '-f', 'null', '-'], { timeout: 15000 });
    const dur = parseDur(stderr);
    if (dur > 0) return dur;
  } catch (err) {
    const dur = parseDur(err.stderr);
    if (dur > 0) return dur;
  }

  throw new Error(
    `getAudioDuration: could not measure ${absPath}. `
    + `ffprobe and ffmpeg both failed — check that ffmpeg is installed and working.`
  );
}
