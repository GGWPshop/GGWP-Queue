import { Global, Module } from '@nestjs/common';
import { QueueLogBuffer } from './queue-log-buffer';

@Global()
@Module({
  providers: [QueueLogBuffer],
  exports: [QueueLogBuffer],
})
export class SharedModule {}
