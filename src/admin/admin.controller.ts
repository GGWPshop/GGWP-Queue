import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue, Job } from 'bullmq';
import { QueueLogBuffer } from '../shared/queue-log-buffer';
import { FRAGMENT_QUEUE } from '../queue/queue.types';
import type { JobName } from '../queue/queue.types';
import type { ScraperJobData } from '../queue/queue.types';
import { previewScheduleRuns } from './schedule-preview';

interface GiftsJobOut {
  id: string;
  job_type: string;
  status: 'queued' | 'active' | 'completed' | 'failed' | 'delayed' | 'cancelled';
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  progress: unknown;
  priority: number;
  max_attempts: number;
  attempts_made: number;
  created_at: string;
  updated_at: string;
  run_at: string | null;
  locked_at: string | null;
  finished_at: string | null;
  delay_ms: number;
  source_trigger: string | null;
  last_error: string | null;
}

interface QueueStatsOut {
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  health: 'healthy' | 'degraded';
  queue_enabled: boolean;
  queue_running: boolean;
  queue_concurrency: number;
  queue_poll_seconds: number;
}

interface QueueMonitoringOut {
  paused: boolean;
  sample_size: number;
  queue_counts: QueueStatsOut['counts'];
  sample_counts: Record<GiftsJobOut['status'], number>;
  success_rate: number | null;
  avg_duration_ms: number | null;
  avg_queue_wait_ms: number | null;
  completed_last_hour: number;
  failed_last_hour: number;
  stale_active: number;
  delayed_over_15m: number;
  oldest_active_ms: number | null;
  oldest_delayed_ms: number | null;
  schedules_total: number;
  overdue_schedules: number;
  next_schedule_at: string | null;
}

interface BatchJobRequest {
  action: 'cancel' | 'requeue' | 'promote';
  ids: string[];
}

interface BatchJobResultOut {
  id: string;
  ok: boolean;
  message: string;
}

interface RepeatableJobOut {
  key: string;
  name: string;
  pattern?: string | null;
  every?: number | null;
  tz?: string | null;
  next?: number | null;
  next_runs: string[];
}

interface FragmentScheduleOut {
  id: string;
  title: string;
  description: string;
  mode: 'discover' | 'price_sync' | 'sold_scan';
  enabled: boolean;
  job_type: string;
  schedule_key: string;
  cron: string | null;
  interval_ms: number | null;
  timezone: string | null;
  next_run_at: string | null;
  next_runs: string[];
  last_job: GiftsJobOut | null;
}

function inferMode(jobType: string, requestedMode?: string): ScraperJobData['mode'] {
  if (requestedMode === 'price_sync' || requestedMode === 'sold_scan' || requestedMode === 'discover') {
    return requestedMode;
  }
  if (jobType.includes('price_sync')) return 'price_sync';
  if (jobType.includes('sold_scan')) return 'sold_scan';
  return 'discover';
}

function toIsoOrNull(value?: number | null): string | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly configService: ConfigService,
    private readonly logBuffer: QueueLogBuffer,
    @InjectQueue(FRAGMENT_QUEUE) private readonly queue: Queue<ScraperJobData>,
  ) {}

  @Get('queue/stats')
  async getQueueStats(): Promise<QueueStatsOut> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    const paused = await this.queue.isPaused();
    const schedulerEnabled = this.configService.get<string>('FRAGMENT_SCHEDULER_ENABLED', 'true') === 'true';
    const health: QueueStatsOut['health'] = (counts.failed ?? 0) >= 5 ? 'degraded' : 'healthy';
    return {
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      },
      health,
      queue_enabled: schedulerEnabled,
      queue_running: !paused,
      queue_concurrency: 2,
      queue_poll_seconds: 0,
    };
  }

  @Get('queue/monitoring')
  async getQueueMonitoring(
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit: number,
  ): Promise<QueueMonitoringOut> {
    const sampleLimit = Math.min(Math.max(limit, 50), 500);
    const [counts, paused, repeatableJobs, jobs] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      this.queue.isPaused(),
      this.queue.getRepeatableJobs(),
      this.queue.getJobs(['active', 'waiting', 'delayed', 'failed', 'completed'], 0, sampleLimit - 1, true),
    ]);

    const sample = await Promise.all(jobs.map((job) => this.toGiftsJob(job)));
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    const sampleCounts: Record<GiftsJobOut['status'], number> = {
      queued: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      cancelled: 0,
    };

    let durationTotal = 0;
    let durationCount = 0;
    let queueWaitTotal = 0;
    let queueWaitCount = 0;
    let staleActive = 0;
    let delayedOver15m = 0;
    let oldestActiveMs: number | null = null;
    let oldestDelayedMs: number | null = null;
    let completedLastHour = 0;
    let failedLastHour = 0;

    for (const job of sample) {
      sampleCounts[job.status] += 1;

      if (job.locked_at) {
        const waitMs = new Date(job.locked_at).getTime() - new Date(job.created_at).getTime();
        if (waitMs >= 0) {
          queueWaitTotal += waitMs;
          queueWaitCount += 1;
        }
      }

      if (job.finished_at) {
        const finishedAt = new Date(job.finished_at).getTime();
        const startedAt = new Date(job.locked_at ?? job.created_at).getTime();
        const durationMs = finishedAt - startedAt;
        if (durationMs >= 0) {
          durationTotal += durationMs;
          durationCount += 1;
        }

        if (job.status === 'completed' && finishedAt >= oneHourAgo) {
          completedLastHour += 1;
        }
        if (job.status === 'failed' && finishedAt >= oneHourAgo) {
          failedLastHour += 1;
        }
      }

      if (job.status === 'active' && job.locked_at) {
        const activeAge = now - new Date(job.locked_at).getTime();
        if (activeAge >= 15 * 60 * 1000) {
          staleActive += 1;
        }
        oldestActiveMs = oldestActiveMs === null ? activeAge : Math.max(oldestActiveMs, activeAge);
      }

      if (job.status === 'delayed' && job.run_at) {
        const delayedAge = now - new Date(job.run_at).getTime();
        if (delayedAge >= 15 * 60 * 1000) {
          delayedOver15m += 1;
        }
        oldestDelayedMs = oldestDelayedMs === null ? delayedAge : Math.max(oldestDelayedMs, delayedAge);
      }
    }

    const successfulSample = sampleCounts.completed;
    const terminalSample = sampleCounts.completed + sampleCounts.failed;
    const successRate = terminalSample > 0 ? successfulSample / terminalSample : null;

    const schedulePreview = repeatableJobs
      .map((job) => this.toRepeatableJob(job))
      .filter((job) => typeof job.next === 'number')
      .sort((left, right) => (left.next ?? 0) - (right.next ?? 0));

    const overdueSchedules = schedulePreview.filter((job) => (job.next ?? 0) < now - 60_000).length;
    const nextScheduleAt = schedulePreview[0]?.next ? new Date(schedulePreview[0].next as number).toISOString() : null;

    return {
      paused,
      sample_size: sample.length,
      queue_counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      },
      sample_counts: sampleCounts,
      success_rate: successRate,
      avg_duration_ms: durationCount > 0 ? Math.round(durationTotal / durationCount) : null,
      avg_queue_wait_ms: queueWaitCount > 0 ? Math.round(queueWaitTotal / queueWaitCount) : null,
      completed_last_hour: completedLastHour,
      failed_last_hour: failedLastHour,
      stale_active: staleActive,
      delayed_over_15m: delayedOver15m,
      oldest_active_ms: oldestActiveMs,
      oldest_delayed_ms: oldestDelayedMs,
      schedules_total: repeatableJobs.length,
      overdue_schedules: overdueSchedules,
      next_schedule_at: nextScheduleAt,
    };
  }

  @Get('jobs')
  async getJobs(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<GiftsJobOut[]> {
    const normalizedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 0, 1), 500) : 200;
    const statuses = status ? status.split(',').map((value) => value.trim()).filter(Boolean) : undefined;

    const bullStatuses = (statuses?.length ? statuses : ['active', 'waiting', 'delayed', 'failed', 'completed'])
      .filter((value): value is 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' => (
        value === 'waiting'
        || value === 'active'
        || value === 'completed'
        || value === 'failed'
        || value === 'delayed'
      ));

    const jobs = await this.queue.getJobs(bullStatuses, 0, normalizedLimit - 1, true);
    return Promise.all(jobs.map((job) => this.toGiftsJob(job)));
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string): Promise<GiftsJobOut> {
    const job = await this.queue.getJob(id);
    if (!job) {
      throw new BadRequestException('Job not found');
    }
    return this.toGiftsJob(job);
  }

  @Post('jobs/:id/cancel')
  async cancelJob(@Param('id') id: string): Promise<{ ok: boolean }> {
    const job = await this.queue.getJob(id);
    if (!job) throw new BadRequestException('Job not found');
    await job.remove();
    this.logBuffer.push({
      level: 'warn',
      source: 'admin',
      message: `Job removed from queue`,
      jobId: id,
      jobName: job.name,
    });
    return { ok: true };
  }

  @Post('jobs/:id/requeue')
  async requeueJob(@Param('id') id: string): Promise<{ ok: boolean }> {
    const job = await this.queue.getJob(id);
    if (!job) throw new BadRequestException('Job not found');
    await job.retry();
    this.logBuffer.push({
      level: 'info',
      source: 'admin',
      message: `Job retried`,
      jobId: id,
      jobName: job.name,
    });
    return { ok: true };
  }

  @Post('jobs/:id/promote')
  async promoteJob(@Param('id') id: string): Promise<{ ok: boolean }> {
    const job = await this.queue.getJob(id);
    if (!job) throw new BadRequestException('Job not found');
    await job.promote();
    this.logBuffer.push({
      level: 'info',
      source: 'admin',
      message: `Delayed job promoted`,
      jobId: id,
      jobName: job.name,
    });
    return { ok: true };
  }

  @Post('jobs/batch')
  async batchJobs(@Body() body: BatchJobRequest): Promise<{
    action: BatchJobRequest['action'];
    total: number;
    success_count: number;
    failed_count: number;
    results: BatchJobResultOut[];
  }> {
    if (!body || !Array.isArray(body.ids)) {
      throw new BadRequestException('ids[] is required');
    }
    if (!['cancel', 'requeue', 'promote'].includes(body.action)) {
      throw new BadRequestException('Unsupported batch action');
    }

    const ids = Array.from(new Set(body.ids.map((id) => String(id).trim()).filter(Boolean))).slice(0, 100);
    if (ids.length === 0) {
      throw new BadRequestException('At least one job id is required');
    }

    const results: BatchJobResultOut[] = [];
    for (const id of ids) {
      const job = await this.queue.getJob(id);
      if (!job) {
        results.push({ id, ok: false, message: 'Job not found' });
        continue;
      }

      try {
        if (body.action === 'cancel') {
          await job.remove();
          this.logBuffer.push({
            level: 'warn',
            source: 'admin',
            message: `Batch cancel`,
            jobId: id,
            jobName: job.name,
          });
        } else if (body.action === 'requeue') {
          await job.retry();
          this.logBuffer.push({
            level: 'info',
            source: 'admin',
            message: `Batch retry`,
            jobId: id,
            jobName: job.name,
          });
        } else {
          await job.promote();
          this.logBuffer.push({
            level: 'info',
            source: 'admin',
            message: `Batch promote`,
            jobId: id,
            jobName: job.name,
          });
        }

        results.push({ id, ok: true, message: 'ok' });
      } catch (error) {
        results.push({
          id,
          ok: false,
          message: error instanceof Error ? error.message : 'Unexpected error',
        });
      }
    }

    const successCount = results.filter((result) => result.ok).length;
    return {
      action: body.action,
      total: ids.length,
      success_count: successCount,
      failed_count: ids.length - successCount,
      results,
    };
  }

  @Delete('jobs/failed')
  async clearFailedJobs(): Promise<{ ok: boolean }> {
    await this.queue.clean(0, 1000, 'failed');
    this.logBuffer.push({
      level: 'warn',
      source: 'admin',
      message: 'Failed jobs cleaned',
    });
    return { ok: true };
  }

  @Post('jobs')
  @Post('jobs/enqueue')
  async enqueueJob(@Body() body: {
    job_type: string;
    payload?: Record<string, unknown>;
    priority?: number;
    max_attempts?: number;
    backoff_delay_ms?: number;
    run_at?: string;
  }): Promise<GiftsJobOut> {
    const {
      job_type,
      payload,
      priority,
      max_attempts,
      backoff_delay_ms,
      run_at,
    } = body ?? {};

    if (!job_type) throw new BadRequestException('job_type is required');

    const mode = inferMode(job_type, typeof payload?.mode === 'string' ? payload.mode : undefined);

    let delayMs: number | undefined;
    if (run_at) {
      const runAtMs = new Date(run_at).getTime();
      if (Number.isNaN(runAtMs)) {
        throw new BadRequestException('run_at must be a valid ISO date');
      }
      delayMs = Math.max(0, runAtMs - Date.now());
    }

    const job = await this.queue.add(
      job_type as JobName,
      {
        ...(payload ?? {}),
        mode,
        trigger: 'api',
      } as ScraperJobData,
      {
        priority,
        delay: delayMs,
        attempts: max_attempts ?? 5,
        backoff: {
          type: 'exponential',
          delay: backoff_delay_ms ?? 30_000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    );

    this.logBuffer.push({
      level: 'info',
      source: 'admin',
      message: `Job enqueued`,
      jobId: String(job.id),
      jobName: job.name,
    });

    return this.toGiftsJob(job);
  }

  @Get('jobs/repeatable')
  async getRepeatableJobs(): Promise<RepeatableJobOut[]> {
    const jobs = await this.queue.getRepeatableJobs();
    return jobs.map((job) => this.toRepeatableJob(job));
  }

  @Get('jobs/repeatable/preview')
  getRepeatablePreview(
    @Query('pattern') pattern?: string,
    @Query('every') every?: string,
    @Query('timezone') timezone?: string,
    @Query('count', new DefaultValuePipe(5), ParseIntPipe) count = 5,
  ): { runs: string[] } {
    const interval = every ? parseInt(every, 10) : undefined;
    const runs = previewScheduleRuns({
      pattern,
      every: Number.isFinite(interval) ? interval : undefined,
      timezone,
      count,
    });
    return { runs };
  }

  @Post('jobs/repeatable')
  async addRepeatableJob(@Body() body: {
    name: string;
    pattern?: string;
    every?: number;
    tz?: string;
    mode?: 'discover' | 'price_sync' | 'sold_scan';
    attempts?: number;
    priority?: number;
    backoff_delay_ms?: number;
    payload?: Record<string, unknown>;
  }): Promise<{ ok: boolean }> {
    const {
      name,
      pattern,
      every,
      tz,
      mode,
      attempts = 3,
      priority,
      backoff_delay_ms,
      payload,
    } = body ?? {};

    if (!name) throw new BadRequestException('name is required');
    if (!pattern && !every) throw new BadRequestException('pattern or every is required');

    if (pattern) {
      previewScheduleRuns({ pattern, timezone: tz, count: 1 });
    }
    if (every !== undefined && every <= 0) {
      throw new BadRequestException('every must be greater than 0');
    }

    await this.queue.add(
      name as JobName,
      {
        ...(payload ?? {}),
        mode: inferMode(name, mode),
        trigger: 'scheduler',
      } as ScraperJobData,
      {
        repeat: {
          pattern,
          every,
          tz,
        },
        attempts,
        priority,
        backoff: {
          type: 'exponential',
          delay: backoff_delay_ms ?? 30_000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    );

    this.logBuffer.push({
      level: 'info',
      source: 'admin',
      message: `Repeatable job added`,
      jobName: name,
    });

    return { ok: true };
  }

  @Delete('jobs/repeatable/:key')
  async removeRepeatableJob(@Param('key') key: string): Promise<{ ok: boolean }> {
    await this.queue.removeRepeatableByKey(key);
    this.logBuffer.push({
      level: 'warn',
      source: 'admin',
      message: `Repeatable job removed`,
    });
    return { ok: true };
  }

  @Get('logs')
  getLogs(@Query('limit') limit?: string) {
    const max = limit ? Math.max(parseInt(limit, 10) || 100, 1) : 100;
    return this.logBuffer.getLast(max);
  }

  @Delete('logs')
  clearLogs(): { ok: boolean } {
    this.logBuffer.clear();
    return { ok: true };
  }

  @Get('fragment/schedules')
  async getFragmentSchedules(): Promise<FragmentScheduleOut[]> {
    const schedulerEnabled = this.configService.get<string>('FRAGMENT_SCHEDULER_ENABLED', 'true') === 'true';
    const discoveryCron = this.configService.get<string>('FRAGMENT_DISCOVER_CRON', '0 0 * * *');
    const priceSyncCron = this.configService.get<string>('FRAGMENT_PRICE_SYNC_CRON', '0 * * * *');
    const timezone = this.configService.get<string>('FRAGMENT_TIMEZONE', process.env.TZ ?? 'UTC');
    const repeatables = await this.queue.getRepeatableJobs();
    const jobs = await this.queue.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed'], 0, 200, true);
    const mappedJobs = await Promise.all(jobs.map((job) => this.toGiftsJob(job)));

    const scheduleDefs = [
      {
        id: 'fragment-discovery',
        title: 'Fragment Discovery',
        description: 'Полный discovery-run каталога Telegram Gifts из Fragment.',
        mode: 'discover' as const,
        enabled: schedulerEnabled,
        job_type: 'fragment.catalog.discover',
        schedule_key: 'fragment_discovery',
        cron: discoveryCron ?? null,
        interval_ms: null,
        timezone,
      },
      {
        id: 'fragment-price-sync',
        title: 'Fragment Price Sync',
        description: 'Почасовая синхронизация цен Telegram Gifts из Fragment в каталог GGWP Gifts.',
        mode: 'price_sync' as const,
        enabled: schedulerEnabled,
        job_type: 'fragment.catalog.price_sync',
        schedule_key: 'fragment_price_sync',
        cron: priceSyncCron ?? null,
        interval_ms: null,
        timezone,
      },
    ];

    return scheduleDefs.map((definition) => {
      const repeatable = repeatables.find((job) => job.name === definition.job_type);
      const repeatableEvery = typeof repeatable?.every === 'string'
        ? parseInt(repeatable.every, 10)
        : repeatable?.every ?? null;
      const lastJob = mappedJobs.find((job) => job.job_type === definition.job_type);
      const nextRunAt = repeatable?.next ? new Date(repeatable.next).toISOString() : null;
      const nextRuns = repeatable
        ? this.getPreviewRuns({
            pattern: repeatable.pattern,
            every: repeatableEvery,
            timezone: repeatable.tz ?? definition.timezone,
          })
        : this.getPreviewRuns({
            pattern: definition.cron,
            every: definition.interval_ms,
            timezone: definition.timezone,
          });

      return {
        ...definition,
        next_run_at: nextRunAt,
        next_runs: nextRuns,
        last_job: lastJob ?? null,
      };
    });
  }

  private toRepeatableJob(job: {
    key: string;
    name: string;
    pattern?: string | null;
    every?: number | string | null;
    tz?: string | null;
    next?: number | null;
  }): RepeatableJobOut {
    const every = typeof job.every === 'string' ? parseInt(job.every, 10) : job.every ?? null;
    return {
      key: job.key,
      name: job.name,
      pattern: job.pattern,
      every,
      tz: job.tz,
      next: job.next,
      next_runs: this.getPreviewRuns({
        pattern: job.pattern,
        every,
        timezone: job.tz ?? process.env.TZ ?? 'UTC',
      }),
    };
  }

  private getPreviewRuns(options: {
    pattern?: string | null;
    every?: number | null;
    timezone?: string | null;
  }): string[] {
    try {
      return previewScheduleRuns({
        pattern: options.pattern,
        every: options.every,
        timezone: options.timezone,
        count: 5,
      });
    } catch {
      return [];
    }
  }

  private async toGiftsJob(job: Job<ScraperJobData>): Promise<GiftsJobOut> {
    const state = await job.getState();
    const status: GiftsJobOut['status'] =
      state === 'completed'
        ? 'completed'
        : state === 'failed'
          ? 'failed'
          : state === 'active'
            ? 'active'
            : state === 'delayed'
              ? 'delayed'
              : state === 'waiting' || state === 'waiting-children' || state === 'prioritized'
                ? 'queued'
                : 'cancelled';

    const updatedAtMs = Math.max(
      job.finishedOn ?? 0,
      job.processedOn ?? 0,
      job.timestamp ?? 0,
    );
    const delayMs = job.opts.delay ?? 0;
    const createdAt = toIsoOrNull(job.timestamp) ?? new Date().toISOString();
    const updatedAt = toIsoOrNull(updatedAtMs || job.timestamp) ?? createdAt;
    const runAt = typeof job.timestamp === 'number' && !Number.isNaN(job.timestamp)
      ? toIsoOrNull(job.timestamp + delayMs)
      : null;

    return {
      id: String(job.id),
      job_type: job.name,
      status,
      payload: (job.data ?? {}) as Record<string, unknown>,
      result: (job.returnvalue as Record<string, unknown> | null) ?? null,
      progress: job.progress ?? null,
      priority: job.opts.priority ?? 0,
      max_attempts: job.opts.attempts ?? 1,
      attempts_made: job.attemptsMade ?? 0,
      created_at: createdAt,
      updated_at: updatedAt,
      run_at: runAt,
      locked_at: toIsoOrNull(job.processedOn),
      finished_at: toIsoOrNull(job.finishedOn),
      delay_ms: delayMs,
      source_trigger: typeof job.data?.trigger === 'string' ? job.data.trigger : null,
      last_error: job.failedReason ?? null,
    };
  }
}
