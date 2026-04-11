import { readFile } from 'node:fs/promises';
import { TranscriptStep } from './telegramTranscriptHarness.js';

export const loadTranscriptFromFile = async (filePath: string): Promise<TranscriptStep[]> => {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as TranscriptStep[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Transcript must be an array: ${filePath}`);
  }
  return parsed;
};
