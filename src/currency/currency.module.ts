import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CurrencyProcessor } from './currency.processor';
import { CurrencySchedulerService } from './currency-scheduler.service';
import { CURRENCY_QUEUE } from './currency-scheduler.service';

@Module({
  imports: [BullModule.registerQueue({ name: CURRENCY_QUEUE })],
  providers: [CurrencyProcessor, CurrencySchedulerService],
})
export class CurrencyModule {}
