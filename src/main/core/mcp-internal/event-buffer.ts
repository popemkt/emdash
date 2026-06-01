import { agentEventBus } from '@main/core/agent-hooks/agent-event-bus';
import type { AgentEvent } from '@shared/events/agentEvents';

const RECENT_LIMIT = 5;

interface ConversationState {
  recent: AgentEvent[];
  lastAt: number;
  lastAssistantMessage?: string;
}

export class AgentEventBuffer {
  private readonly states = new Map<string, ConversationState>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private dispose: (() => void) | null = null;

  start(): void {
    if (this.dispose) return;
    this.dispose = agentEventBus.onEvent(({ event }) => this.ingest(event));
  }

  stop(): void {
    this.dispose?.();
    this.dispose = null;
    this.states.clear();
    this.waiters.clear();
  }

  getState(conversationId: string): ConversationState | undefined {
    return this.states.get(conversationId);
  }

  getEvents(conversationId: string, since?: number): AgentEvent[] {
    const state = this.states.get(conversationId);
    if (!state) return [];
    if (since === undefined) return state.recent.slice();
    return state.recent.filter((event) => event.timestamp > since);
  }

  waitForChange(conversationId: string, since: number, timeoutMs: number): Promise<boolean> {
    const state = this.states.get(conversationId);
    if (state && state.lastAt > since) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.get(conversationId)?.delete(notify);
        resolve(changed);
      };
      const notify = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const waiters = this.waiters.get(conversationId) ?? new Set<() => void>();
      waiters.add(notify);
      this.waiters.set(conversationId, waiters);
    });
  }

  private ingest(event: AgentEvent): void {
    const state = this.states.get(event.conversationId) ?? { recent: [], lastAt: 0 };
    state.recent = [...state.recent, event].slice(-RECENT_LIMIT);
    state.lastAt = event.timestamp;
    if (event.payload.lastAssistantMessage) {
      state.lastAssistantMessage = event.payload.lastAssistantMessage;
    }
    this.states.set(event.conversationId, state);

    const waiters = this.waiters.get(event.conversationId);
    if (!waiters) return;
    for (const waiter of waiters) waiter();
    waiters.clear();
  }
}
