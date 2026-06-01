import { homedir } from 'node:os';
import path from 'node:path';
import { applyTranscriptWindow, findFile, readFileOrEmpty } from './file-utils';
import type {
  TranscriptFetchArgs,
  TranscriptFetchResult,
  TranscriptItem,
  TranscriptReader,
} from './types';

class CodexReader implements TranscriptReader {
  async fetch(args: TranscriptFetchArgs): Promise<TranscriptFetchResult> {
    const source = await resolveCodexTranscriptPath(args.providerSessionId);
    if (!source) return { items: [] };

    const raw = await readFileOrEmpty(source);
    if (!raw) return { items: [] };

    const items: TranscriptItem[] = [];
    let index = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const item = parseLine(line, index++);
      if (item) items.push(item);
    }

    return applyTranscriptWindow(items, args.limit, args.since);
  }
}

async function resolveCodexTranscriptPath(providerSessionId: string): Promise<string | null> {
  return findFile(path.join(homedir(), '.codex', 'sessions'), async (filePath) => {
    if (!path.basename(filePath).startsWith('rollout-') || !filePath.endsWith('.jsonl')) {
      return false;
    }
    const raw = await readFileOrEmpty(filePath);
    const firstLine = raw?.split('\n', 1)[0];
    if (!firstLine) return false;
    try {
      const parsed = JSON.parse(firstLine);
      return (
        isRecord(parsed) &&
        parsed.type === 'session_meta' &&
        isRecord(parsed.payload) &&
        parsed.payload.id === providerSessionId
      );
    } catch {
      return false;
    }
  });
}

function parseLine(line: string, index: number): TranscriptItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== 'response_item') return null;

  const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
  const payload = parsed.payload;
  if (!timestamp || !isRecord(payload) || payload.type !== 'message') return null;

  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return null;

  const content = extractContent(payload.content);
  if (!content) return null;

  return { id: `codex-${index}-${timestamp}`, role, timestamp, content };
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      if (typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const codexReader = new CodexReader();
