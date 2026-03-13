import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FRAGMENT_QUEUE } from './queue.types';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import { ScraperProcessor } from './scraper.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: FRAGMENT_QUEUE }),
  ],
  controllers: [QueueController],
  providers: [QueueService, ScraperProcessor],
  exports: [QueueService],
})
export class QueueModule {}
