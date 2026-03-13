import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import axios from 'axios';
import { CURRENCY_QUEUE } from './currency-scheduler.service';

const CURRENCY_API_URL = process.env.CURRENCY_API_URL || 'http://ggwp-currency-api:9000';
const CURRENCY_ADMIN_KEY = process.env.CURRENCY_ADMIN_KEY || '';

/** Maps BullMQ job names to ggwp-currency admin REST endpoints. */
const JOB_ENDPOINTS: Record<string, string> = {
  refresh_crypto: '/api/v1/admin/refresh/crypto',
  refresh_fiat: '/api/v1/admin/refresh/fiat',
  // cleanup_history is handled internally by ggwp-currency scheduler
};

/**
 * BullMQ Worker that triggers ggwp-currency admin endpoints on schedule.
 */
@Processor(CURRENCY_QUEUE, { concurrency: 1 })
export class CurrencyProcessor extends WorkerHost {
  private readonly logger = new Logger(CurrencyProcessor.name);

  async process(job: Job): Promise<{ triggered?: string; status?: string; message?: string }> {
    const jobName = job.name;
    const endpoint = JOB_ENDPOINTS[jobName];

    if (!endpoint) {
      this.logger.log(`Currency job ${jobName} has no HTTP endpoint — skipping`);
      return { status: 'skipped' };
    }

    this.logger.log(`Triggering currency job: ${jobName} → ${endpoint}`);

    const res = await axios.post(
      `${CURRENCY_API_URL}${endpoint}`,
      {},
      {
        headers: { 'X-API-Key': CURRENCY_ADMIN_KEY },
        timeout: 30_000,
      },
    );

    const result = res.data as { triggered?: string; status?: string; message?: string };
    this.logger.log(`Currency job ${jobName} completed`);
    return result;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    this.logger.error(`Currency job failed: ${job?.name} — ${error.message}`);
  }
}
