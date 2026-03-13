import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FRAGMENT_QUEUE } from '../queue/queue.types';
import { HealthController } from './health.controller';

@Module({
  imports: [BullModule.registerQueue({ name: FRAGMENT_QUEUE })],
  controllers: [HealthController],
})
export class HealthModule {}
