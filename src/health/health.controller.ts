import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { FRAGMENT_QUEUE, ScraperJobData } from '../queue/queue.types';

@Controller()
export class HealthController {
  constructor(
    @InjectQueue(FRAGMENT_QUEUE) private readonly queue: Queue<ScraperJobData>,
  ) {}

  @Get('healthz')
  async healthz() {
    try {
      await this.queue.getJobCounts('waiting', 'active');
      return { status: 'ok', queue: FRAGMENT_QUEUE };
    } catch {
      return { status: 'error', queue: FRAGMENT_QUEUE };
    }
  }
}
