# study-dashboard

Mobile-first PWA dashboard (current slot, today's tasks, YPT/心得/重點, lessons, quick notes) with Notion as the data store.

- `docs/` — static frontend (vanilla JS, no build). Served by GitHub Pages. Demo: `/?demo=1`
- `worker/` — Cloudflare Worker that proxies the Notion API (secrets live only there)

The repo holds **no secrets**. `worker/config.js` has Notion database IDs and property names (useless without the token).

## Architecture
phone (PWA) --`X-App-Key`--> Cloudflare Worker --`NOTION_TOKEN`--> Notion API (version 2022-06-28, database query endpoints)

Endpoints: `GET /api/state`, `POST /api/task/:id {done|skip}`, `POST /api/record {hours,minutes,心得,重點,心情}`, `POST /api/lesson/:id {done|review}`, `POST /api/note {title,subject,points,chapter,lessonId}`.

## Deploy steps
1. **Notion integration**: notion.so/profile/integrations > New integration (internal) > copy the secret. Then, for each of 今日任務, 每日紀錄, 課程進度(我的課程), 筆記: open the DB as a full page > `…` > Connections > add the integration.
2. **Check `worker/config.js`**: DB IDs were taken from the DB page URLs. If you get "Could not find database", copy the 32-char ID from the DB's own URL and replace it.
3. **Cloudflare**:
   ```
   cd worker && npm i
   npx wrangler login
   npx wrangler secret put NOTION_TOKEN     # paste Notion secret
   npx wrangler secret put APP_KEY          # any long random string you choose
   npx wrangler deploy                      # prints https://study-dashboard-api.<you>.workers.dev
   ```
   Set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages origin (default `https://chan0ir.github.io`).
4. **Point the frontend at the Worker**: open `https://<user>.github.io/study-dashboard/?api=https://study-dashboard-api.<you>.workers.dev` once (stored in localStorage), or set `API_BASE` in `docs/config.js`. The app asks for `APP_KEY` once.
5. Add to Home Screen (iOS Safari: Share > Add to Home Screen; Android Chrome: Install).

## Local checks
`cd worker && node test.mjs` (mocked Notion). Frontend: `cd docs && python3 -m http.server` then open `/?demo=1`.

## Customising
Timetable and keyword matching for 現在 live in `docs/config.js` (`SCHEDULE`). Tasks are fetched by `日期 = today (Asia/Taipei)`; lessons by `預計週開始` within the current week plus unfinished earlier ones.
