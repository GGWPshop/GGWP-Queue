import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const CURRENCY_QUEUE = 'currency-jobs';

const JOBS = [
  { name: 'refresh_crypto',   every: 60_000,                         attempts: 2 },
  { name: 'refresh_fiat',     every: 300_000,                        attempts: 2 },
  // cleanup_history runs daily at 3AM Moscow — use cron pattern
  { name: 'cleanup_history',  pattern: '0 0 3 * * *' /* 3:00 AM */,  attempts: 1, timezone: 'Europe/Moscow' },
] as const;

/**
 * Registers repeatable BullMQ jobs that call ggwp-currency HTTP triggers.
 */
@Injectable()
export class CurrencySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(CurrencySchedulerService.name);

  constructor(@InjectQueue(CURRENCY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    const existing = await this.queue.getRepeatableJobs();
    const existingNames = new Set(existing.map((j) => j.name));

    for (const job of JOBS) {
      if (!existingNames.has(job.name)) {
        const opts: any = {
          attempts: job.attempts,
          backoff: { type: 'fixed', delay: 10_000 },
          removeOnComplete: { count: 50, age: 3600 },
          removeOnFail: { count: 50, age: 7200 },
        };

        if ('every' in job) {
          opts.repeat = { every: job.every };
        } else {
          opts.repeat = { pattern: job.pattern, tz: job.timezone };
        }

        await this.queue.add(job.name, {}, opts);
        this.logger.log(`Registered currency job: ${job.name}`);
      }
    }
    this.logger.log('Currency scheduler initialized');
  }
}
