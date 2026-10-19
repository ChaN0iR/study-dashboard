# study-dashboard

Mobile-first PWA dashboard (current slot, today's tasks, YPT/心得/重點, lessons, quick notes) with Notion as the data store.

- `docs/` — static frontend (vanilla JS, no build). Served by GitHub Pages. Demo: `/?demo=1`
- `worker/` — Cloudflare Worker that proxies the Notion API (secrets live only there)

The repo holds **no secrets**. `worker/config.js` has Notion database IDs and property names (useless without the token).

## Architecture
phone (PWA) --`X-App-Key`--> Cloudflare Worker --`NOTION_TOKEN`--> Notion API (version 2022-06-28, database query endpoints)

Endpoints: `GET /api/state`, `POST /api/task/:id {done|skip}`, `POST /api/record {hours,minutes,心得,重點,心情}`, `POST /api/lesson/:id {done|review}`, `POST /api/note {title,subject,points,chapter,lessonId}`.

## Deployment and operations

See [OPERATIONS.md](OPERATIONS.md) for the reviewed deployment sequence, environment isolation, D1/DO/Notion configuration, backup and restore limitations, rollback, and verification. Deployment and migrations require separate operator authorization. The checked-in configuration includes a production D1 ID and an active Cron trigger; do not use it for staging.

## Local checks

Run `npm ci` then `npm test` inside `worker/`. Run `node --test docs/*.test.mjs` at the repository root. External services are mocked in Worker tests. Frontend demo: serve `docs/` locally and open `/?demo=1`.

## Customising
Timetable and keyword matching for 現在 live in `docs/config.js` (`SCHEDULE`). Tasks are fetched by `日期 = today (Asia/Taipei)`; lessons by `預計週開始` within the current week plus unfinished earlier ones.
