# GGWP Queue

Standalone BullMQ service — manages job queues for the GGWP ecosystem.

## Features

- **Fragment scraper orchestration** — discover / price_sync / sold_scan jobs
- **Currency sync** — triggers ggwp-currency updates on schedule
- **Admin REST API** — full job & schedule management (pause/resume/promote/logs)
- **Repeatable jobs** — cron or interval-based scheduling via BullMQ
- **Log buffer** — circular in-memory log for real-time monitoring

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| GET | `/admin/queue/stats` | Queue statistics |
| POST | `/admin/queue/pause` | Pause queue |
| POST | `/admin/queue/resume` | Resume queue |
| GET | `/admin/jobs` | List jobs (filter by status/type) |
| POST | `/admin/jobs/enqueue` | Enqueue a new job |
| POST | `/admin/jobs/:id/cancel` | Cancel a job |
| POST | `/admin/jobs/:id/requeue` | Requeue a failed job |
| POST | `/admin/jobs/:id/promote` | Promote a delayed job |
| DELETE | `/admin/jobs/failed` | Clear all failed jobs |
| GET | `/admin/jobs/repeatable` | List repeatable jobs |
| POST | `/admin/jobs/repeatable` | Add repeatable job |
| DELETE | `/admin/jobs/repeatable/:key` | Remove repeatable job |
| GET | `/admin/logs` | Get log buffer entries |
| DELETE | `/admin/logs` | Clear log buffer |

## Environment Variables

See `.env.example` for all required variables.

## Development

```bash
cp .env.example .env
npm install
npm run start:dev
```

## Production

```bash
cd infra
docker compose -f docker-compose.prod.yml up -d
```
