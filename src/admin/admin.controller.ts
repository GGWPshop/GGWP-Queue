import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { FRAGMENT_QUEUE, JOB_NAMES, JobName, ScraperJobData } from '../queue/queue.types';
import { QueueLogBuffer } from '../shared/queue-log-buffer';

// ─── Response shapes (GiftsJob-compatible) ────────────────────────────────────

interface GiftsJobOut {
  id: string;
  job_type: string;
  status: string;
  priority: number;
  run_at: string;
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  created_at: string;
  finished_at: string | null;
}

interface QueueStatsOut {
  enabled: boolean;
  running: boolean;
  concurrency: number;
  poll_seconds: number;
  stats: Record<string, unknown>;
}

interface FragmentScheduleOut {
  id: string;
  title: string;
  description: string;
  job_type: string;
  mode: 'discover' | 'price_sync';
  enabled: boolean;
  cron: string;
  timezone: string;
  next_run_at: string | null;
  last_job: GiftsJobOut | null;
}

// ─── Schedule metadata ────────────────────────────────────────────────────────

const SCHEDULE_META: Record<string, { id: string; title: string; description: string; mode: 'discover' | 'price_sync' }> = {
  [JOB_NAMES.DISCOVER]: {
    id: 'fragment-discovery',
    title: 'Fragment Catalog Discovery',
    description: 'Полное обновление каталога Fragment (запускается раз в сутки)',
    mode: 'discover',
  },
  [JOB_NAMES.PRICE_SYNC]: {
    id: 'fragment-price-sync',
    title: 'Fragment Price Sync',
    description: 'Синхронизация цен каталога Fragment (запускается ежечасно)',
    mode: 'price_sync',
  },
};

const STATE_TO_PYTHON: Record<string, string> = {
  waiting: 'queued',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
  delayed: 'delayed',
  paused: 'queued',
  unknown: 'queued',
};

const PYTHON_TO_BULLMQ: Record<string, string[]> = {
  queued: ['waiting', 'paused'],
  active: ['active'],
  running: ['active'],
  completed: ['completed'],
  failed: ['failed'],
  delayed: ['delayed'],
  cancelled: [],
};

const MODE_FROM_JOB_TYPE: Record<string, ScraperJobData['mode']> = {
  [JOB_NAMES.DISCOVER]: 'discover',
  [JOB_NAMES.PRICE_SYNC]: 'price_sync',
  [JOB_NAMES.SOLD_SCAN]: 'sold_scan',
};

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('admin')
export class AdminController {
  constructor(
    @InjectQueue(FRAGMENT_QUEUE) private readonly queue: Queue<ScraperJobData>,
    private readonly cfg: ConfigService,
    private readonly logBuffer: QueueLogBuffer,
  ) {}

  // ─── Queue Stats ────────────────────────────────────────────────────────────

  @Get('queue/stats')
  async getQueueStats(): Promise<QueueStatsOut> {
    const [counts, isPaused] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      this.queue.isPaused(),
    ]);
    return {
      enabled: this.cfg.get<string>('QUEUE_WORKER_ENABLED', 'true') === 'true',
      running: !isPaused,
      concurrency: parseInt(this.cfg.get<string>('WORKER_CONCURRENCY', '2')),
      poll_seconds: 0,
      stats: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      },
    };
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────────

  @Get('jobs')
  async getJobs(
    @Query('status') status?: string,
    @Query('job_type') jobType?: string,
    @Query('limit') limitStr?: string,
  ): Promise<GiftsJobOut[]> {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr ?? '50') || 50));

    let bullmqStates: string[];
    if (status && status in PYTHON_TO_BULLMQ) {
      bullmqStates = PYTHON_TO_BULLMQ[status];
    } else if (status) {
      bullmqStates = [status];
    } else {
      bullmqStates = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'];
    }

    if (bullmqStates.length === 0) return [];

    const jobs: Job[] = await this.queue.getJobs(bullmqStates as any[], 0, limit - 1);
    const filtered = jobType ? jobs.filter((j) => j.name === jobType) : jobs;

    return Promise.all(filtered.map((j) => this.toGiftsJob(j)));
  }

  @Post('jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelJob(@Param('id') id: string) {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    const state = await job.getState();
    if (state === 'active') {
      await job.discard();
    } else {
      await job.remove();
    }
    return { ok: true, id };
  }

  @Post('jobs/:id/requeue')
  @HttpCode(HttpStatus.OK)
  async requeueJob(@Param('id') id: string) {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    await job.retry();
    return { ok: true, id };
  }

  @Post('jobs/enqueue')
  async enqueueJob(
    @Body() body: { job_type: string; payload?: Record<string, unknown>; priority?: number; max_attempts?: number },
  ): Promise<GiftsJobOut> {
    const { job_type, payload, priority, max_attempts } = body;

    const mode: ScraperJobData['mode'] =
      (payload?.mode as ScraperJobData['mode']) ?? MODE_FROM_JOB_TYPE[job_type];
    if (!mode) {
      throw new BadRequestException(`Unknown job_type: ${job_type}`);
    }

    const job = await this.queue.add(
      job_type as JobName,
      { mode, trigger: 'api' },
      {
        priority,
        attempts: max_attempts ?? 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
        removeOnFail: { count: 200, age: 30 * 24 * 3600 },
      },
    );
    return this.toGiftsJob(job);
  }

  // ─── Queue Control ──────────────────────────────────────────────────────────

  @Post('queue/pause')
  @HttpCode(HttpStatus.OK)
  async pauseQueue() {
    await this.queue.pause();
    this.logBuffer.push({ level: 'warn', source: 'admin', message: 'Queue paused via admin API' });
    return { ok: true, paused: true };
  }

  @Post('queue/resume')
  @HttpCode(HttpStatus.OK)
  async resumeQueue() {
    await this.queue.resume();
    this.logBuffer.push({ level: 'info', source: 'admin', message: 'Queue resumed via admin API' });
    return { ok: true, paused: false };
  }

  @Delete('jobs/failed')
  @HttpCode(HttpStatus.OK)
  async clearFailedJobs() {
    await this.queue.clean(0, 10_000, 'failed');
    this.logBuffer.push({ level: 'warn', source: 'admin', message: 'All failed jobs cleared' });
    return { ok: true };
  }

  @Post('jobs/:id/promote')
  @HttpCode(HttpStatus.OK)
  async promoteJob(@Param('id') id: string) {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    await job.promote();
    return { ok: true, id };
  }

  // ─── Repeatable Jobs ────────────────────────────────────────────────────────

  @Get('jobs/repeatable')
  async getRepeatableJobs() {
    const jobs = await this.queue.getRepeatableJobs();
    return jobs.map((j) => ({
      key: j.key,
      name: j.name,
      pattern: j.pattern ?? null,
      every: j.every ?? null,
      tz: j.tz ?? null,
      next: j.next ? new Date(j.next).toISOString() : null,
    }));
  }

  @Post('jobs/repeatable')
  async addRepeatableJob(
    @Body() body: {
      name: string;
      pattern?: string;
      every?: number;
      timezone?: string;
      attempts?: number;
      payload?: Record<string, unknown>;
    },
  ) {
    const { name, pattern, every, timezone, attempts, payload } = body;
    if (!pattern && !every) {
      throw new BadRequestException('Either pattern (cron) or every (ms) is required');
    }
    const mode: ScraperJobData['mode'] = (payload?.mode as ScraperJobData['mode']) ?? MODE_FROM_JOB_TYPE[name];
    if (!mode) {
      throw new BadRequestException(`Unknown job name: ${name}. Must be one of: ${Object.keys(MODE_FROM_JOB_TYPE).join(', ')}`);
    }

    const repeatOpts: any = {};
    if (pattern) { repeatOpts.pattern = pattern; if (timezone) repeatOpts.tz = timezone; }
    if (every) repeatOpts.every = every;

    const job = await this.queue.add(
      name as JobName,
      { mode, trigger: 'scheduler' },
      {
        repeat: repeatOpts,
        attempts: attempts ?? 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
        removeOnFail: { count: 200, age: 30 * 24 * 3600 },
      },
    );
    this.logBuffer.push({ level: 'info', source: 'admin', message: `Added repeatable job: ${name}`, jobName: name });
    return { ok: true, id: job.id };
  }

  @Delete('jobs/repeatable/:key')
  @HttpCode(HttpStatus.OK)
  async removeRepeatableJob(@Param('key') key: string) {
    const removed = await this.queue.removeRepeatableByKey(decodeURIComponent(key));
    if (!removed) throw new NotFoundException(`Repeatable job key not found: ${key}`);
    this.logBuffer.push({ level: 'warn', source: 'admin', message: `Removed repeatable job key: ${key}` });
    return { ok: true, key };
  }

  // ─── Logs ────────────────────────────────────────────────────────────────────

  @Get('logs')
  getLogs(@Query('limit') limitStr?: string) {
    const limit = Math.min(300, Math.max(1, parseInt(limitStr ?? '100') || 100));
    return this.logBuffer.getLast(limit);
  }

  @Delete('logs')
  @HttpCode(HttpStatus.OK)
  clearLogs() {
    this.logBuffer.clear();
    return { ok: true };
  }

  // ─── Fragment Schedules ────────────────────────────────────────────────────

  @Get('fragment/schedules')
  async getFragmentSchedules(): Promise<FragmentScheduleOut[]> {
    const [repeatableJobs, completedJobs, failedJobs] = await Promise.all([
      this.queue.getRepeatableJobs(),
      this.queue.getJobs(['completed'] as any[], 0, 49),
      this.queue.getJobs(['failed'] as any[], 0, 49),
    ]);

    const allRecentJobs = [...completedJobs, ...failedJobs];

    const result: FragmentScheduleOut[] = [];

    for (const [jobName, meta] of Object.entries(SCHEDULE_META)) {
      const repeatable = repeatableJobs.find((r) => r.name === jobName);
      const lastJob = allRecentJobs
        .filter((j) => j.name === jobName)
        .sort((a, b) => (b.finishedOn ?? b.timestamp) - (a.finishedOn ?? a.timestamp))[0];

      result.push({
        id: meta.id,
        title: meta.title,
        description: meta.description,
        job_type: jobName,
        mode: meta.mode,
        enabled: repeatable !== undefined,
        cron: repeatable?.pattern ?? '',
        timezone: repeatable?.tz ?? this.cfg.get<string>('FRAGMENT_TIMEZONE', 'Europe/Moscow'),
        next_run_at: repeatable?.next ? new Date(repeatable.next).toISOString() : null,
        last_job: lastJob ? await this.toGiftsJob(lastJob) : null,
      });
    }

    return result;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async toGiftsJob(job: Job): Promise<GiftsJobOut> {
    const state = await job.getState();
    return {
      id: job.id as string,
      job_type: job.name,
      status: STATE_TO_PYTHON[state] ?? state,
      priority: (job.opts as any)?.priority ?? 0,
      run_at: new Date(job.timestamp).toISOString(),
      attempts: job.attemptsMade,
      max_attempts: (job.opts as any)?.attempts ?? 5,
      locked_at: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      locked_by: null,
      last_error: job.failedReason ?? null,
      payload: job.data as Record<string, unknown>,
      result: (job.returnvalue as Record<string, unknown>) ?? null,
      created_at: new Date(job.timestamp).toISOString(),
      finished_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }
}
