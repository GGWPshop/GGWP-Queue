import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './admin/admin.module';
import { CurrencyModule } from './currency/currency.module';
import { SharedModule } from './shared/shared.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        connection: {
          url: cfg.get<string>('REDIS_URL', 'redis://localhost:6379'),
        },
      }),
    }),
    SharedModule,
    QueueModule,
    HealthModule,
    AdminModule,
    CurrencyModule,
  ],
})
export class AppModule {}
