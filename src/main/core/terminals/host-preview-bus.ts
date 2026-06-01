import { EventEmitter } from 'node:events';
import type { HostPreviewEvent } from '@shared/hostPreview';

type HostPreviewBusEvents = {
  event: [HostPreviewEvent];
};

class HostPreviewBus extends EventEmitter<HostPreviewBusEvents> {
  emitEvent(event: HostPreviewEvent): void {
    this.emit('event', event);
  }

  onEvent(handler: (event: HostPreviewEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
}

export const hostPreviewBus = new HostPreviewBus();
