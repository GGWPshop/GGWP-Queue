export const FRAGMENT_QUEUE = 'fragment-scraper';

export const JOB_NAMES = {
  DISCOVER: 'fragment.catalog.discover',
  PRICE_SYNC: 'fragment.catalog.price_sync',
  SOLD_SCAN: 'fragment.catalog.sold_scan',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export interface ScraperJobData {
  mode: 'discover' | 'price_sync' | 'sold_scan';
  trigger?: 'scheduler' | 'api';
  [key: string]: unknown;
}

export interface ScraperJobResult {
  status: string;
  run_id: string;
  mode: string;
  received?: number;
  degraded?: boolean;
  started_at?: string;
  finished_at?: string;
  result?: Record<string, unknown>;
}

/** Normalised job shape returned by the REST API */
export interface JobView {
  id: string;
  name: string;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'unknown';
  data: ScraperJobData;
  result: ScraperJobResult | null;
  failedReason: string | null;
  attemptsMade: number;
  maxAttempts: number;
  progress: string | boolean | number | object;
  createdAt: number;
  processedAt: number | null;
  finishedAt: number | null;
  delay: number;
}
