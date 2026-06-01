import type { AgentProviderId } from '@shared/agent-provider-registry';
import { claudeReader } from './claude';
import { codexReader } from './codex';
import { copilotReader } from './copilot';
import type { TranscriptReader } from './types';

const READERS: Partial<Record<AgentProviderId, TranscriptReader>> = {
  claude: claudeReader,
  codex: codexReader,
  copilot: copilotReader,
};

export function getTranscriptReader(providerId: AgentProviderId): TranscriptReader | null {
  return READERS[providerId] ?? null;
}

export function isTranscriptSupported(providerId: AgentProviderId): boolean {
  return Boolean(getTranscriptReader(providerId));
}
