import { Injectable } from '@nestjs/common';

export interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  jobId?: string;
  jobName?: string;
}

const MAX_ENTRIES = 300;

/**
 * In-memory circular log buffer.
 * Captures BullMQ worker events for display in the admin panel.
 */
@Injectable()
export class QueueLogBuffer {
  private readonly entries: LogEntry[] = [];

  push(entry: Omit<LogEntry, 'ts'>): void {
    this.entries.push({ ts: new Date().toISOString(), ...entry });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  getLast(limit = 100): LogEntry[] {
    return this.entries.slice(-Math.min(limit, MAX_ENTRIES));
  }

  clear(): void {
    this.entries.length = 0;
  }
}
