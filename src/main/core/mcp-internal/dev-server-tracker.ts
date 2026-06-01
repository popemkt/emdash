import { hostPreviewBus } from '@main/core/terminals/host-preview-bus';
import type { HostPreviewEvent } from '@shared/hostPreview';

interface DevServerEntry {
  taskId: string;
  terminalId: string;
  url: string;
  detectedAt: number;
}

export class DevServerTracker {
  private readonly entries = new Map<string, DevServerEntry>();
  private dispose: (() => void) | null = null;

  start(): void {
    if (this.dispose) return;
    this.dispose = hostPreviewBus.onEvent((event) => this.ingest(event));
  }

  stop(): void {
    this.dispose?.();
    this.dispose = null;
    this.entries.clear();
  }

  listForTask(taskId: string): DevServerEntry[] {
    return Array.from(this.entries.values()).filter((entry) => entry.taskId === taskId);
  }

  private ingest(event: HostPreviewEvent): void {
    if (!event.terminalId) return;
    if (event.type === 'url' && event.url) {
      this.entries.set(event.terminalId, {
        taskId: event.taskId,
        terminalId: event.terminalId,
        url: event.url,
        detectedAt: Date.now(),
      });
      return;
    }
    if (event.type === 'exit') {
      this.entries.delete(event.terminalId);
    }
  }
}
