/**
 * Text-to-speech via edge-tts with per-quote voice selection.
 * Completely free, no API key, unlimited usage.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));
const execFileAsync = promisify(execFile);

const RATE = config.edgeTts?.rate || '+5%';
const PITCH = config.edgeTts?.pitch || '-2Hz';

/**
 * Generate an MP3 from text using edge-tts.
 */
export async function generateVoiceover(text, outputPath, voice) {
  // Use --pitch=VALUE format to avoid argparse treating negative values as flags
  const pyArgs = ['-m', 'edge_tts',
    '--voice', voice,
    '--rate', RATE,
    `--pitch=${PITCH}`,
    '--text', text,
    '--write-media', outputPath,
  ];

  try {
    // Try edge-tts CLI directly
    await execFileAsync('edge-tts', [
      '--voice', voice, '--rate', RATE, `--pitch=${PITCH}`,
      '--text', text, '--write-media', outputPath,
    ], { timeout: 30000 });
  } catch {
    // Fall back to python -m edge_tts
    await execFileAsync('python', pyArgs, { timeout: 30000 });
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
