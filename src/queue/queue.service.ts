import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job, RepeatableJob } from 'bullmq';
import { FRAGMENT_QUEUE, JOB_NAMES, JobName, JobView, ScraperJobData } from './queue.types';

export interface QueueStats {
  queue: string;
  paused: boolean;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
}

export interface ScheduleView {
  key: string;
  name: JobName;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
}

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(FRAGMENT_QUEUE) private readonly queue: Queue<ScraperJobData>,
    private readonly cfg: ConfigService,
  ) {}

  async onModuleInit() {
    await this.ensureRepeatableJobs();
  }

  // ─── Stats ──────────────────────────────────────────────────────────────

  async getStats(): Promise<QueueStats> {
    const [counts, isPaused] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      this.queue.isPaused(),
    ]);
    return {
      queue: FRAGMENT_QUEUE,
      paused: isPaused,
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        paused: counts.paused ?? 0,
      },
    };
  }

  // ─── Jobs ───────────────────────────────────────────────────────────────

  async getJobs(opts: {
    states?: string[];
    name?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: JobView[]; total: number }> {
    const states = (opts.states?.length
      ? opts.states
      : ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused']) as any[];
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const start = (page - 1) * limit;
    const end = start + limit - 1;

    const jobs: Job[] = await this.queue.getJobs(states, start, end);
    const filtered = opts.name ? jobs.filter((j) => j.name === opts.name) : jobs;

    const views = await Promise.all(filtered.map((j) => this.toView(j)));
    return { items: views, total: filtered.length };
  }

  async getJob(id: string): Promise<JobView | null> {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    return this.toView(job);
  }

  async enqueueJob(name: JobName, data: ScraperJobData, opts?: { priority?: number; delay?: number }): Promise<JobView> {
    const job = await this.queue.add(name, data, {
      priority: opts?.priority,
      delay: opts?.delay,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
      removeOnFail: { count: 200, age: 30 * 24 * 3600 },
    });
    this.logger.log(`Enqueued job ${job.name} id=${job.id} trigger=api`);
    return this.toView(job);
  }

  async cancelJob(id: string): Promise<boolean> {
    const job = await this.queue.getJob(id);
    if (!job) return false;
    const state = await job.getState();
    if (state === 'active') {
      await job.discard();
    } else {
      await job.remove();
    }
    return true;
  }

  async retryJob(id: string): Promise<JobView | null> {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    await job.retry();
    return this.toView(job);
  }

  // ─── Repeatable (Schedules) ──────────────────────────────────────────────

  async getSchedules(): Promise<ScheduleView[]> {
    const repeatableJobs: RepeatableJob[] = await this.queue.getRepeatableJobs();
    const tz = this.cfg.get<string>('FRAGMENT_TIMEZONE', 'Europe/Moscow');
    return repeatableJobs.map((r) => ({
      key: r.key,
      name: r.name as JobName,
      cron: r.pattern ?? '',
      timezone: r.tz ?? tz,
      enabled: true,
      nextRunAt: r.next ? new Date(r.next).toISOString() : null,
    }));
  }

  async upsertSchedule(name: JobName, cron: string, timezone?: string): Promise<void> {
    const tz = timezone ?? this.cfg.get<string>('FRAGMENT_TIMEZONE', 'Europe/Moscow');
    const modeMap: Record<JobName, ScraperJobData['mode']> = {
      [JOB_NAMES.DISCOVER]: 'discover',
      [JOB_NAMES.PRICE_SYNC]: 'price_sync',
      [JOB_NAMES.SOLD_SCAN]: 'sold_scan',
    };
    await this.queue.add(
      name,
      { mode: modeMap[name], trigger: 'scheduler' },
      {
        repeat: { pattern: cron, tz },
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
        removeOnFail: { count: 200, age: 30 * 24 * 3600 },
      },
    );
    this.logger.log(`Upserted schedule ${name} cron="${cron}" tz=${tz}`);
  }

  async removeSchedule(key: string): Promise<boolean> {
    const jobs = await this.queue.getRepeatableJobs();
    const job = jobs.find((j) => j.key === key);
    if (!job) return false;
    await this.queue.removeRepeatableByKey(key);
    this.logger.log(`Removed schedule key=${key}`);
    return true;
  }

  // ─── Maintenance ─────────────────────────────────────────────────────────

  async pauseQueue(): Promise<void> {
    await this.queue.pause();
  }

  async resumeQueue(): Promise<void> {
    await this.queue.resume();
  }

  async cleanJobs(grace: number, limit: number, state: 'completed' | 'failed'): Promise<string[]> {
    const ids = await this.queue.clean(grace, limit, state);
    return ids as string[];
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async ensureRepeatableJobs(): Promise<void> {
    const discoverCron = this.cfg.get<string>('FRAGMENT_DISCOVER_CRON', '0 0 * * *');
    const priceSyncCron = this.cfg.get<string>('FRAGMENT_PRICE_SYNC_CRON', '0 * * * *');
    const tz = this.cfg.get<string>('FRAGMENT_TIMEZONE', 'Europe/Moscow');
    const enabled = this.cfg.get<string>('FRAGMENT_SCHEDULER_ENABLED', 'true') === 'true';

    if (!enabled) {
      this.logger.warn('Fragment scheduler disabled — skipping repeatable job registration');
      return;
    }

    await this.upsertSchedule(JOB_NAMES.DISCOVER, discoverCron, tz);
    await this.upsertSchedule(JOB_NAMES.PRICE_SYNC, priceSyncCron, tz);
    this.logger.log(`Scheduled: discover="${discoverCron}" price_sync="${priceSyncCron}" tz=${tz}`);
  }

  private async toView(job: Job<ScraperJobData>): Promise<JobView> {
    const state = await job.getState();
    return {
      id: job.id as string,
      name: job.name,
      state: state as JobView['state'],
      data: job.data,
      result: (job.returnvalue as any) ?? null,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? 5,
      progress: job.progress,
      createdAt: job.timestamp,
      processedAt: job.processedOn ?? null,
      finishedAt: job.finishedOn ?? null,
      delay: job.opts?.delay ?? 0,
    };
  }
}
