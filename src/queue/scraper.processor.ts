import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import axios, { AxiosInstance } from 'axios';
import { FRAGMENT_QUEUE, ScraperJobData, ScraperJobResult } from './queue.types';
import { QueueLogBuffer } from '../shared/queue-log-buffer';

@Processor(FRAGMENT_QUEUE, { concurrency: 2 })
export class ScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ScraperProcessor.name);
  private readonly http: AxiosInstance;
  private readonly scraperUrl: string;

  constructor(cfg: ConfigService, private readonly logBuffer: QueueLogBuffer) {
    super();
    this.scraperUrl = cfg.get<string>('SCRAPER_SERVICE_URL', 'http://ggwp-scraper-fragment:8020').replace(/\/$/, '');
    this.http = axios.create({ timeout: 150_000, baseURL: this.scraperUrl });
  }

  async process(job: Job<ScraperJobData>): Promise<ScraperJobResult> {
    const { mode, trigger } = job.data;
    this.logger.log(`Processing job=${job.id} name=${job.name} mode=${mode} trigger=${trigger ?? 'unknown'} attempt=${job.attemptsMade + 1}`);
    this.logBuffer.push({ level: 'info', source: 'gifts', message: `Processing job=${job.id} name=${job.name} mode=${mode}`, jobId: job.id!, jobName: job.name });

    const runId = await this.startScraperRun(job, mode);
    const result = await this.waitForRun(job, runId);

    this.logger.log(`Job=${job.id} completed run_id=${runId} received=${result.result?.received ?? '?'}`);
    this.logBuffer.push({ level: 'info', source: 'gifts', message: `Job=${job.id} completed run_id=${runId} received=${result.result?.received ?? '?'}`, jobId: job.id!, jobName: job.name });
    return result;
  }

  private async startScraperRun(job: Job<ScraperJobData>, mode: string): Promise<string> {
    let resp;
    try {
      resp = await this.http.post<{ run_id: string; ok: boolean }>('/run-now', { mode });
    } catch (err: any) {
      if (err.response?.status === 409) {
        const detail = err.response.data?.detail;
        if (typeof detail === 'object' && detail?.run_id && detail?.mode === mode) {
          this.logger.log(`Scraper busy with same mode — latching onto run_id=${detail.run_id}`);
          return String(detail.run_id);
        }
        throw new Error(`Scraper busy with different mode: ${JSON.stringify(detail)}`);
      }
      if (err.response?.status === 409 && err.response?.data?.detail === 'Scraper is disabled') {
        throw new Error('Scraper is disabled');
      }
      throw new Error(`Scraper /run-now failed: ${err.message}`);
    }

    await job.updateProgress(5);
    return String(resp.data.run_id);
  }

  private async waitForRun(job: Job<ScraperJobData>, runId: string): Promise<ScraperJobResult> {
    const maxWait = 130 * 60 * 1000; // 130 min
    const pollInterval = 5000;
    const started = Date.now();

    while (Date.now() - started < maxWait) {
      const { data } = await this.http.get<{
        status: string;
        error?: string;
        result?: Record<string, unknown>;
        started_at?: string;
        finished_at?: string;
        mode?: string;
      }>(`/runs/${runId}`);

      if (data.status === 'running') {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        await job.updateProgress(Math.min(95, 5 + Math.floor(elapsed / 10)));
        await new Promise((r) => setTimeout(r, pollInterval));
        continue;
      }

      if (data.status === 'completed') {
        await job.updateProgress(100);
        return {
          status: 'completed',
          run_id: runId,
          mode: data.mode ?? job.data.mode,
          received: Number(data.result?.received ?? 0),
          degraded: Boolean(data.result?.degraded),
          started_at: data.started_at,
          finished_at: data.finished_at,
          result: data.result,
        };
      }

      throw new Error(data.error ?? `Scraper run ${runId} ended with status=${data.status}`);
    }

    throw new Error(`Scraper run ${runId} timed out after ${maxWait / 60000} minutes`);
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Worker active: job=${job.id} name=${job.name}`);
    this.logBuffer.push({ level: 'info', source: 'gifts', message: `Job active: ${job.name}`, jobId: job.id!, jobName: job.name });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    this.logger.error(`Worker failed: job=${job?.id} name=${job?.name} attempt=${job?.attemptsMade} error=${error.message}`);
    this.logBuffer.push({ level: 'error', source: 'gifts', message: `Job failed: ${job?.name} — ${error.message}`, jobId: job?.id, jobName: job?.name });
  }
}
