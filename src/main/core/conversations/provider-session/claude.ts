import { homedir } from 'node:os';
import path from 'node:path';
import { applyTranscriptWindow, findFile, readFileOrEmpty } from './file-utils';
import type {
  TranscriptFetchArgs,
  TranscriptFetchResult,
  TranscriptItem,
  TranscriptReader,
} from './types';

class ClaudeReader implements TranscriptReader {
  async fetch(args: TranscriptFetchArgs): Promise<TranscriptFetchResult> {
    const source = await resolveClaudeTranscriptPath(args.providerSessionId, args.taskPath);
    if (!source) return { items: [] };

    const raw = await readFileOrEmpty(source);
    if (!raw) return { items: [] };

    const items: TranscriptItem[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const item = parseLine(line);
      if (item) items.push(item);
    }

    return applyTranscriptWindow(items, args.limit, args.since);
  }
}

async function resolveClaudeTranscriptPath(
  providerSessionId: string,
  taskPath: string | undefined
): Promise<string | null> {
  const projectsDir = path.join(homedir(), '.claude', 'projects');
  if (taskPath) {
    const encoded = taskPath.replace(/[/\\]/g, '-');
    return path.join(projectsDir, encoded, `${providerSessionId}.jsonl`);
  }

  return findFile(
    projectsDir,
    (filePath) => path.basename(filePath) === `${providerSessionId}.jsonl`
  );
}

function parseLine(line: string): TranscriptItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const type = parsed.type;
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return null;
  const id = typeof parsed.uuid === 'string' ? parsed.uuid : null;
  const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
  if (!id || !timestamp) return null;

  const content = extractContent(parsed.message);
  if (!content) return null;

  const out: TranscriptItem = { id, role: type, timestamp, content };
  if (typeof parsed.parentUuid === 'string') out.parentId = parsed.parentUuid;
  return out;
}

function extractContent(message: unknown): string {
  if (!isRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const claudeReader = new ClaudeReader();
