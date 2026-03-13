const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type CronField = {
  wildcard: boolean;
  values: Set<number>;
};

type ParsedCron = {
  second: CronField | null;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const MINUTE_MS = 60_000;
const EVERY_PREVIEW_LIMIT = 20;
const CRON_PREVIEW_SCAN_LIMIT = 366 * 24 * 60;

function normalizeValue(value: number, max: number, isDayOfWeek: boolean): number {
  if (isDayOfWeek && value === 7) return 0;
  if (value < 0 || value > max) {
    throw new Error(`Value ${value} is out of range`);
  }
  return value;
}

function addRange(values: Set<number>, start: number, end: number, step: number, max: number, isDayOfWeek: boolean) {
  const from = normalizeValue(start, max, isDayOfWeek);
  const to = normalizeValue(end, max, isDayOfWeek);
  if (from > to) {
    throw new Error(`Invalid range ${start}-${end}`);
  }

  for (let current = from; current <= to; current += step) {
    values.add(normalizeValue(current, max, isDayOfWeek));
  }
}

function parseCronField(field: string, min: number, max: number, isDayOfWeek = false): CronField {
  if (field === '*') {
    const values = new Set<number>();
    for (let current = min; current <= max; current += 1) {
      values.add(normalizeValue(current, max, isDayOfWeek));
    }
    return { wildcard: true, values };
  }

  const values = new Set<number>();
  for (const token of field.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    const [basePart, stepPart] = trimmed.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid step in cron field: ${trimmed}`);
    }

    if (basePart === '*') {
      addRange(values, min, max, step, max, isDayOfWeek);
      continue;
    }

    if (basePart.includes('-')) {
      const [start, end] = basePart.split('-').map((part) => parseInt(part, 10));
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`Invalid range in cron field: ${trimmed}`);
      }
      addRange(values, start, end, step, max, isDayOfWeek);
      continue;
    }

    const value = parseInt(basePart, 10);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid value in cron field: ${trimmed}`);
    }
    values.add(normalizeValue(value, max, isDayOfWeek));
  }

  return { wildcard: false, values };
}

function parseCron(pattern: string): ParsedCron {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error('Cron expression must contain 5 or 6 fields');
  }

  const hasSeconds = parts.length === 6;
  const offset = hasSeconds ? 1 : 0;

  return {
    second: hasSeconds ? parseCronField(parts[0], 0, 59) : null,
    minute: parseCronField(parts[offset + 0], 0, 59),
    hour: parseCronField(parts[offset + 1], 0, 23),
    dayOfMonth: parseCronField(parts[offset + 2], 1, 31),
    month: parseCronField(parts[offset + 3], 1, 12),
    dayOfWeek: parseCronField(parts[offset + 4], 0, 7, true),
  };
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
}

function getTimeZoneParts(date: Date, timezone: string) {
  const parts = getFormatter(timezone).formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayLabel = map.get('weekday') ?? '';
  const weekday = WEEKDAY_MAP[weekdayLabel];
  if (weekday === undefined) {
    throw new Error(`Unsupported weekday "${weekdayLabel}" for timezone ${timezone}`);
  }

  return {
    year: Number(map.get('year')),
    month: Number(map.get('month')),
    day: Number(map.get('day')),
    hour: Number(map.get('hour')),
    minute: Number(map.get('minute')),
    second: Number(map.get('second')),
    weekday,
  };
}

function matchesCron(parsed: ParsedCron, date: Date, timezone: string): boolean {
  const zoned = getTimeZoneParts(date, timezone);
  const domMatches = parsed.dayOfMonth.values.has(zoned.day);
  const dowMatches = parsed.dayOfWeek.values.has(zoned.weekday);

  let dayMatches = false;
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) {
    dayMatches = true;
  } else if (parsed.dayOfMonth.wildcard) {
    dayMatches = dowMatches;
  } else if (parsed.dayOfWeek.wildcard) {
    dayMatches = domMatches;
  } else {
    dayMatches = domMatches || dowMatches;
  }

  return (
    (!parsed.second || parsed.second.values.has(zoned.second))
    && parsed.minute.values.has(zoned.minute)
    && parsed.hour.values.has(zoned.hour)
    && parsed.month.values.has(zoned.month)
    && dayMatches
  );
}

export function previewScheduleRuns(options: {
  pattern?: string | null;
  every?: number | null;
  timezone?: string | null;
  count?: number;
  startAt?: Date;
}): string[] {
  const count = Math.min(Math.max(options.count ?? 5, 1), 10);
  const startAt = options.startAt ?? new Date();

  if (options.every) {
    const every = Math.min(Math.max(options.every, MINUTE_MS), EVERY_PREVIEW_LIMIT * 24 * 60 * MINUTE_MS);
    const first = Math.ceil(startAt.getTime() / every) * every;
    return Array.from({ length: count }, (_, index) => new Date(first + (index * every)).toISOString());
  }

  const pattern = options.pattern?.trim();
  if (!pattern) {
    throw new Error('Schedule preview requires cron pattern or interval');
  }

  const timezone = options.timezone?.trim() || 'UTC';
  getFormatter(timezone);
  const parsed = parseCron(pattern);

  const results: string[] = [];
  const minuteCursor = new Date(startAt.getTime());
  minuteCursor.setUTCSeconds(0, 0);

  for (let scanned = 0; scanned < CRON_PREVIEW_SCAN_LIMIT && results.length < count; scanned += 1) {
    const seconds = parsed.second ? Array.from(parsed.second.values).sort((left, right) => left - right) : [0];
    for (const second of seconds) {
      const candidate = new Date(minuteCursor.getTime() + (second * 1000));
      if (candidate.getTime() <= startAt.getTime()) continue;
      if (matchesCron(parsed, candidate, timezone)) {
        results.push(candidate.toISOString());
        if (results.length >= count) break;
      }
    }
    minuteCursor.setTime(minuteCursor.getTime() + MINUTE_MS);
  }

  if (results.length === 0) {
    throw new Error('Не удалось построить preview для указанного расписания');
  }

  return results;
}
