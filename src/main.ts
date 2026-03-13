import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  const port = process.env.PORT ?? 8050;
  await app.listen(port);
  Logger.log(`GGWP Queue listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
