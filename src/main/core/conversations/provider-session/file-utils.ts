import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function readFileOrEmpty(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

export async function findFile(
  root: string,
  predicate: (filePath: string) => Promise<boolean> | boolean,
  maxEntries = 20_000
): Promise<string | null> {
  const stack = [root];
  let visited = 0;

  while (stack.length > 0 && visited < maxEntries) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      visited++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && (await predicate(full))) {
        return full;
      }
      if (visited >= maxEntries) break;
    }
  }

  return null;
}

export function applyTranscriptWindow<T extends { timestamp: string }>(
  items: T[],
  limit?: number,
  since?: string
): { items: T[]; nextCursor?: string } {
  const filtered = since ? items.filter((item) => item.timestamp > since) : items;
  const limited = limit && filtered.length > limit ? filtered.slice(-limit) : filtered;
  const last = limited[limited.length - 1];
  return { items: limited, nextCursor: last?.timestamp };
}
