/**
 * Text-to-speech via edge-tts with per-quote voice selection.
 * Completely free, no API key, unlimited usage.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));
const execFileAsync = promisify(execFile);

const RATE = config.edgeTts?.rate || '+5%';
const PITCH = config.edgeTts?.pitch || '-2Hz';

/**
 * Generate an MP3 from text using edge-tts.
 * Returns the output file path.
 */
export async function generateVoiceover(text, outputPath, voice) {
  const args = [
    '--voice', voice,
    '--rate', RATE,
    '--pitch', PITCH.startsWith('-') ? `${PITCH}` : PITCH,
    '--text', text,
    '--write-media', outputPath,
  ];

  try {
    // Try edge-tts directly first, then as Python module
    try {
      await execFileAsync('edge-tts', args, { timeout: 30000 });
    } catch {
      // edge-tts --pitch=-2Hz (use = to avoid argument parsing issue with negative values)
      const pyArgs = ['-m', 'edge_tts',
        '--voice', voice,
        '--rate', RATE,
        `--pitch=${PITCH}`,
        '--text', text,
        '--write-media', outputPath,
      ];
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
