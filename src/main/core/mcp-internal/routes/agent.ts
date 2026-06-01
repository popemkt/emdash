import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { createConversation } from '@main/core/conversations/createConversation';
import { getConversationById } from '@main/core/conversations/getConversationById';
import {
  getTranscriptReader,
  isTranscriptSupported,
} from '@main/core/conversations/provider-session/manifest';
import type { TranscriptItem } from '@main/core/conversations/provider-session/types';
import { mapConversationRowToConversation } from '@main/core/conversations/utils';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { taskManager } from '@main/core/tasks/task-manager';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { db } from '@main/db/client';
import { conversations, projects, tasks } from '@main/db/schema';
import {
  getProvider,
  isValidProviderId,
  type AgentProviderId,
} from '@shared/agent-provider-registry';
import type { Conversation } from '@shared/conversations';
import type { AgentEvent } from '@shared/events/agentEvents';
import { makePtySessionId } from '@shared/ptySessionId';
import type { AgentEventBuffer } from '../event-buffer';
import { HttpError, type CallerContext } from '../http-server';

const DEFAULT_LONG_POLL_MS = 15_000;
export const MAX_LONG_POLL_MS = 60_000;
export const MIN_LONG_POLL_MS = 1_000;

export const ScopeSchema = z.enum(['task', 'project', 'all']);
export type Scope = z.infer<typeof ScopeSchema>;

export const FetchKindSchema = z.enum(['events', 'scrollback', 'transcript']);
export type FetchKind = z.infer<typeof FetchKindSchema>;

export const SpawnBodySchema = z.object({
  providerId: z.string(),
  name: z.string().optional(),
  initialPrompt: z.string().optional(),
  sameTask: z.literal(true).optional(),
});
export type SpawnBody = z.infer<typeof SpawnBodySchema>;

export const SendBodySchema = z.object({
  message: z.string().min(1),
  crossTask: z.boolean().optional(),
  submit: z.boolean().optional(),
});
export type SendBody = z.infer<typeof SendBodySchema>;

export const InterruptBodySchema = z.object({
  crossTask: z.boolean().optional(),
});
export type InterruptBody = z.infer<typeof InterruptBodySchema>;

export const ObserveQuerySchema = z.object({
  waitForChange: z.boolean().optional(),
  timeoutMs: z.number().int().min(MIN_LONG_POLL_MS).max(MAX_LONG_POLL_MS).optional(),
});
export type ObserveQuery = z.infer<typeof ObserveQuerySchema>;

export const FetchQuerySchema = z.object({
  kind: FetchKindSchema.optional(),
  limit: z.number().int().positive().optional(),
  since: z.string().min(1).optional(),
});
export type FetchQuery = z.infer<typeof FetchQuerySchema>;

export type AgentStatus = 'unknown' | 'working' | 'awaiting-input' | 'error' | 'idle';
export type ProviderTier = 'hooks' | 'classifier' | 'unsupported';
export type EventCursor = string & { readonly __brand: 'EventCursor' };

const encodeCursor = (timestampMs: number): EventCursor => String(timestampMs) as EventCursor;
const decodeCursor = (cursor: string | undefined): number | undefined => {
  if (cursor === undefined) return undefined;
  const value = Number(cursor);
  return Number.isFinite(value) ? value : undefined;
};

interface SelfResponse {
  conversationId: string;
  taskId: string;
  taskName?: string;
  projectId: string;
  projectName?: string;
  providerId: string;
  name: string;
}

interface PeerSummary extends SelfResponse {
  lastActivityAt: string | null;
  running: boolean;
  status: AgentStatus;
}

interface ObserveResponse {
  status: AgentStatus;
  recentEvents: AgentEvent[];
  lastAssistantMessage?: string;
  providerTier: ProviderTier;
  statusChangedAt: number | null;
}

export type FetchResponse =
  | {
      kind: 'events';
      events: AgentEvent[];
      nextCursor?: EventCursor;
      providerTier: ProviderTier;
      transcriptSupported: boolean;
    }
  | {
      kind: 'scrollback';
      scrollback: string;
      providerTier: ProviderTier;
      transcriptSupported: boolean;
    }
  | {
      kind: 'transcript';
      items: TranscriptItem[];
      nextCursor?: string;
      providerTier: ProviderTier;
      transcriptSupported: boolean;
    };

const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set(['idle', 'error', 'awaiting-input']);

async function lookupNames(
  taskIds: string[],
  projectIds: string[]
): Promise<{ taskNames: Map<string, string>; projectNames: Map<string, string> }> {
  const [taskRows, projectRows] = await Promise.all([
    taskIds.length
      ? db.select({ id: tasks.id, name: tasks.name }).from(tasks).where(inArray(tasks.id, taskIds))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    projectIds.length
      ? db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  return {
    taskNames: new Map(taskRows.map((row) => [row.id, row.name])),
    projectNames: new Map(projectRows.map((row) => [row.id, row.name])),
  };
}

function getSessionId(conversation: Conversation): string {
  return makePtySessionId(conversation.projectId, conversation.taskId, conversation.id);
}

function deriveStatus(events: AgentEvent[]): AgentStatus {
  if (events.length === 0) return 'unknown';
  const last = events[events.length - 1];
  if (last.type === 'error') return 'error';
  if (last.type === 'stop') return 'idle';
  if (last.type === 'notification') {
    const notificationType = last.payload.notificationType;
    if (
      notificationType === 'permission_prompt' ||
      notificationType === 'idle_prompt' ||
      notificationType === 'elicitation_dialog'
    ) {
      return 'awaiting-input';
    }
    return 'working';
  }
  return 'working';
}

function deriveProviderTier(providerId: string): ProviderTier {
  const provider = getProvider(providerId as AgentProviderId);
  if (!provider) return 'unsupported';
  return provider.supportsHooks ? 'hooks' : 'classifier';
}

function assertCrossTaskWrite(
  caller: CallerContext,
  target: Conversation,
  crossTask: boolean | undefined,
  op: 'send' | 'interrupt'
): void {
  if (target.taskId === caller.conversation.taskId || crossTask) return;
  throw new HttpError(403, `cross-task ${op} requires crossTask=true`);
}

async function loadTargetConversation(targetConversationId: string): Promise<Conversation> {
  const target = await getConversationById(targetConversationId);
  if (!target) throw new HttpError(410, 'conversation gone');
  return target;
}

async function selectPeerRows(caller: CallerContext, scope: Scope) {
  switch (scope) {
    case 'task':
      return db
        .select()
        .from(conversations)
        .where(eq(conversations.taskId, caller.conversation.taskId));
    case 'project':
      return db
        .select()
        .from(conversations)
        .where(eq(conversations.projectId, caller.conversation.projectId));
    case 'all':
      return db.select().from(conversations);
  }
}

export async function handleAgentSelf(caller: CallerContext): Promise<SelfResponse> {
  const { taskNames, projectNames } = await lookupNames(
    [caller.conversation.taskId],
    [caller.conversation.projectId]
  );
  return {
    conversationId: caller.conversation.id,
    taskId: caller.conversation.taskId,
    taskName: taskNames.get(caller.conversation.taskId),
    projectId: caller.conversation.projectId,
    projectName: projectNames.get(caller.conversation.projectId),
    providerId: caller.conversation.providerId,
    name: caller.conversation.title,
  };
}

export async function handleAgentListPeers(
  caller: CallerContext,
  scope: Scope,
  buffer: AgentEventBuffer
): Promise<PeerSummary[]> {
  const rows = await selectPeerRows(caller, scope);
  const filtered = rows.filter((row) => row.id !== caller.conversation.id);
  const { taskNames, projectNames } = await lookupNames(
    Array.from(new Set(filtered.map((row) => row.taskId))),
    Array.from(new Set(filtered.map((row) => row.projectId)))
  );

  return filtered.map((row) => {
    const conversation = mapConversationRowToConversation(row);
    return {
      conversationId: conversation.id,
      taskId: conversation.taskId,
      taskName: taskNames.get(conversation.taskId),
      projectId: conversation.projectId,
      projectName: projectNames.get(conversation.projectId),
      providerId: conversation.providerId,
      name: conversation.title,
      lastActivityAt: conversation.lastInteractedAt,
      running: Boolean(ptySessionRegistry.get(getSessionId(conversation))),
      status: deriveStatus(buffer.getState(conversation.id)?.recent ?? []),
    };
  });
}

export async function handleAgentObserve(
  _caller: CallerContext,
  targetConversationId: string,
  query: ObserveQuery,
  buffer: AgentEventBuffer
): Promise<ObserveResponse> {
  const target = await loadTargetConversation(targetConversationId);

  if (query.waitForChange) {
    const state = buffer.getState(targetConversationId);
    const currentStatus = deriveStatus(state?.recent ?? []);
    if (!TERMINAL_STATUSES.has(currentStatus)) {
      const timeoutMs = Math.min(
        Math.max(query.timeoutMs ?? DEFAULT_LONG_POLL_MS, MIN_LONG_POLL_MS),
        MAX_LONG_POLL_MS
      );
      await buffer.waitForChange(targetConversationId, state?.lastAt ?? 0, timeoutMs);
    }
  }

  const state = buffer.getState(targetConversationId);
  const recentEvents = state?.recent ?? [];
  return {
    status: deriveStatus(recentEvents),
    recentEvents,
    lastAssistantMessage: state?.lastAssistantMessage,
    providerTier: deriveProviderTier(target.providerId),
    statusChangedAt: state?.lastAt ?? null,
  };
}

export async function handleAgentSpawn(
  caller: CallerContext,
  body: SpawnBody
): Promise<{ conversationId: string; title: string; providerId: string }> {
  if (!isValidProviderId(body.providerId)) throw new HttpError(400, 'invalid providerId');
  const provider = body.providerId as AgentProviderId;
  const title = body.name ?? getProvider(provider)?.name ?? provider;
  const conversation = await createConversation({
    id: randomUUID(),
    projectId: caller.conversation.projectId,
    taskId: caller.conversation.taskId,
    provider,
    title,
    isInitialConversation: false,
    initialPrompt: body.initialPrompt,
  });
  return { conversationId: conversation.id, title: conversation.title, providerId: provider };
}

export async function handleAgentSend(
  caller: CallerContext,
  targetConversationId: string,
  body: SendBody
): Promise<{ ok: true }> {
  const target = await loadTargetConversation(targetConversationId);
  assertCrossTaskWrite(caller, target, body.crossTask, 'send');

  const pty = ptySessionRegistry.get(getSessionId(target));
  if (!pty) throw new HttpError(410, 'pty not running');

  pty.write(body.message);
  if ((body.submit ?? true) === true) {
    pty.write('\r');
  }
  return { ok: true };
}

export async function handleAgentInterrupt(
  caller: CallerContext,
  targetConversationId: string,
  body: InterruptBody
): Promise<{ ok: true }> {
  const target = await loadTargetConversation(targetConversationId);
  assertCrossTaskWrite(caller, target, body.crossTask, 'interrupt');

  const pty = ptySessionRegistry.get(getSessionId(target));
  if (!pty) throw new HttpError(410, 'pty not running');

  pty.write('\x03');
  return { ok: true };
}

export async function handleAgentFetch(
  _caller: CallerContext,
  targetConversationId: string,
  query: FetchQuery,
  buffer: AgentEventBuffer
): Promise<FetchResponse> {
  const target = await loadTargetConversation(targetConversationId);
  const kind: FetchKind = query.kind ?? 'events';
  const providerTier = deriveProviderTier(target.providerId);
  const transcriptSupported = isTranscriptSupported(target.providerId);

  if (kind === 'events') {
    const all = buffer.getEvents(target.id, decodeCursor(query.since));
    const events = query.limit ? all.slice(-query.limit) : all;
    const last = events[events.length - 1];
    return {
      kind: 'events',
      events,
      nextCursor: last ? encodeCursor(last.timestamp) : undefined,
      providerTier,
      transcriptSupported,
    };
  }

  if (kind === 'scrollback') {
    const scrollback = ptySessionRegistry.peekRingBuffer(getSessionId(target));
    return {
      kind: 'scrollback',
      scrollback:
        query.limit && scrollback.length > query.limit
          ? scrollback.slice(-query.limit)
          : scrollback,
      providerTier,
      transcriptSupported,
    };
  }

  const reader = getTranscriptReader(target.providerId);
  if (!reader || !target.providerSessionId) {
    return {
      kind: 'transcript',
      items: [],
      providerTier,
      transcriptSupported: Boolean(reader),
    };
  }

  const workspaceId = taskManager.getWorkspaceId(target.taskId);
  const taskPath = workspaceId ? workspaceRegistry.get(workspaceId)?.path : undefined;
  const result = await reader.fetch({
    providerSessionId: target.providerSessionId,
    taskPath,
    ...(query.limit ? { limit: query.limit } : {}),
    ...(query.since ? { since: query.since } : {}),
  });

  return {
    kind: 'transcript',
    items: result.items,
    nextCursor: result.nextCursor,
    providerTier,
    transcriptSupported,
  };
}
