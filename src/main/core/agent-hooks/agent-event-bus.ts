import { EventEmitter } from 'node:events';
import type { AgentEventEnvelope } from '@shared/events/agentEvents';

type AgentEventBusEvents = {
  event: [AgentEventEnvelope];
};

class AgentEventBus extends EventEmitter<AgentEventBusEvents> {
  emitEnvelope(envelope: AgentEventEnvelope): void {
    this.emit('event', envelope);
  }

  onEvent(handler: (envelope: AgentEventEnvelope) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
}

export const agentEventBus = new AgentEventBus();
