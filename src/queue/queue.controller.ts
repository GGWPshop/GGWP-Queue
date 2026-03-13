import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  NotFoundException,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { QueueService } from './queue.service';
import { JOB_NAMES, JobName, JobView } from './queue.types';

class EnqueueJobDto {
  name!: JobName;
  priority?: number;
  delay?: number;
}

class UpsertScheduleDto {
  cron!: string;
  timezone?: string;
}

@Controller('queue')
export class QueueController {
  constructor(private readonly qs: QueueService) {}

  // ─── Health / Stats ───────────────────────────────────────────────────────

  @Get('stats')
  getStats() {
    return this.qs.getStats();
  }

  @Post('pause')
  @HttpCode(HttpStatus.NO_CONTENT)
  pauseQueue() {
    return this.qs.pauseQueue();
  }

  @Post('resume')
  @HttpCode(HttpStatus.NO_CONTENT)
  resumeQueue() {
    return this.qs.resumeQueue();
  }

  @Post('clean')
  @HttpCode(HttpStatus.OK)
  async cleanJobs(
    @Query('state') state: 'completed' | 'failed' = 'completed',
    @Query('grace', new DefaultValuePipe(3600000), ParseIntPipe) grace: number,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    const ids = await this.qs.cleanJobs(grace, limit, state);
    return { removed: ids.length, ids };
  }

  // ─── Jobs ─────────────────────────────────────────────────────────────────

  @Get('jobs')
  getJobs(
    @Query('state') state?: string,
    @Query('name') name?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    const states = state ? state.split(',') : undefined;
    return this.qs.getJobs({ states, name, page, limit });
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string): Promise<JobView> {
    const job = await this.qs.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  @Post('jobs')
  async enqueueJob(@Body() dto: EnqueueJobDto): Promise<JobView> {
    const modeMap: Record<JobName, 'discover' | 'price_sync' | 'sold_scan'> = {
      [JOB_NAMES.DISCOVER]: 'discover',
      [JOB_NAMES.PRICE_SYNC]: 'price_sync',
      [JOB_NAMES.SOLD_SCAN]: 'sold_scan',
    };
    return this.qs.enqueueJob(dto.name, { mode: modeMap[dto.name], trigger: 'api' }, {
      priority: dto.priority,
      delay: dto.delay,
    });
  }

  @Post('jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelJob(@Param('id') id: string) {
    const ok = await this.qs.cancelJob(id);
    if (!ok) throw new NotFoundException(`Job ${id} not found`);
    return { ok: true, id };
  }

  @Post('jobs/:id/retry')
  async retryJob(@Param('id') id: string): Promise<JobView> {
    const job = await this.qs.retryJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  @Get('schedules')
  getSchedules() {
    return this.qs.getSchedules();
  }

  @Post('schedules/:name')
  upsertSchedule(@Param('name') name: JobName, @Body() dto: UpsertScheduleDto) {
    return this.qs.upsertSchedule(name, dto.cron, dto.timezone);
  }

  @Delete('schedules/:key')
  @HttpCode(HttpStatus.OK)
  async removeSchedule(@Param('key') key: string) {
    const ok = await this.qs.removeSchedule(key);
    if (!ok) throw new NotFoundException(`Schedule ${key} not found`);
    return { ok: true, key };
  }
}
