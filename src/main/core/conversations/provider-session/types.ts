export interface TranscriptItem {
  id: string;
  parentId?: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  content: string;
}

export interface TranscriptFetchArgs {
  providerSessionId: string;
  taskPath?: string;
  limit?: number;
  since?: string;
}

export interface TranscriptFetchResult {
  items: TranscriptItem[];
  nextCursor?: string;
}

export interface TranscriptReader {
  fetch(args: TranscriptFetchArgs): Promise<TranscriptFetchResult>;
}
