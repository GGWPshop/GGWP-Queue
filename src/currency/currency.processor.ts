import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import axios from 'axios';
import { CURRENCY_QUEUE } from './currency-scheduler.service';

const CURRENCY_API_URL = process.env.CURRENCY_API_URL || 'http://ggwp-currency-api:9000';
const CURRENCY_ADMIN_KEY = process.env.CURRENCY_ADMIN_KEY || '';

/**
 * BullMQ Worker that triggers ggwp-currency job endpoints on schedule.
 * Replaces APScheduler (which stays in Python but is no longer the scheduler).
 */
@Processor(CURRENCY_QUEUE, { concurrency: 1 })
export class CurrencyProcessor extends WorkerHost {
  private readonly logger = new Logger(CurrencyProcessor.name);

  async process(job: Job): Promise<{ status: string; message?: string }> {
    const jobName = job.name;
    this.logger.log(`Triggering currency job: ${jobName}`);

    const res = await axios.post(
      `${CURRENCY_API_URL}/internal/jobs/${jobName}`,
      {},
      {
        headers: { 'X-API-Key': CURRENCY_ADMIN_KEY },
        timeout: 30_000,
      },
    );

    const result = res.data as { status: string; message?: string };
    if (result.status !== 'ok') {
      throw new Error(`Currency job ${jobName} failed: ${result.message}`);
    }

    this.logger.log(`Currency job ${jobName} completed`);
    return result;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    this.logger.error(`Currency job failed: ${job?.name} — ${error.message}`);
  }
}
