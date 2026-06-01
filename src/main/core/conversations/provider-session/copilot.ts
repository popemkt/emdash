import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyTranscriptWindow } from './file-utils';
import type {
  TranscriptFetchArgs,
  TranscriptFetchResult,
  TranscriptItem,
  TranscriptReader,
} from './types';

const DB_PATH = path.join(homedir(), '.copilot', 'session-store.db');

interface TurnRow {
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string;
}

class CopilotReader implements TranscriptReader {
  async fetch(args: TranscriptFetchArgs): Promise<TranscriptFetchResult> {
    let db: Database.Database;
    try {
      db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CANTOPEN') return { items: [] };
      throw error;
    }

    try {
      const rows = db
        .prepare<[string], TurnRow>(
          'SELECT turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index ASC'
        )
        .all(args.providerSessionId);

      const items: TranscriptItem[] = [];
      for (const row of rows) {
        if (row.user_message) {
          items.push({
            id: `copilot-${args.providerSessionId}-${row.turn_index}-u`,
            role: 'user',
            timestamp: row.timestamp,
            content: row.user_message,
          });
        }
        if (row.assistant_response) {
          items.push({
            id: `copilot-${args.providerSessionId}-${row.turn_index}-a`,
            role: 'assistant',
            timestamp: row.timestamp,
            content: row.assistant_response,
          });
        }
      }
      return applyTranscriptWindow(items, args.limit, args.since);
    } finally {
      db.close();
    }
  }
}

export const copilotReader = new CopilotReader();
