import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AdminController } from './admin.controller';
import { FRAGMENT_QUEUE } from '../queue/queue.types';

@Module({
  imports: [BullModule.registerQueue({ name: FRAGMENT_QUEUE })],
  controllers: [AdminController],
})
export class AdminModule {}
