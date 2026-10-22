# Persistent authentication limit (Draft; not deployed)

Login and enabled registration share one IP budget: twelve attempts in a one-hour window starting with the first admitted request. The thirteenth returns 429 `AUTH_RATE_LIMIT`. Rejected attempts do not extend expiry. A single SQL upsert increments and returns the count, shared through the existing D1 binding instead of a module-local Map. Counters saturate at thirteen.

Both routes first enforce method, same-origin and the 8000-byte JSON boundary. Invalid/oversized JSON is rejected before database writes. Disabled registration still returns `REGISTRATION_DISABLED` without account or limiter storage access. Every otherwise parsed login and enabled-registration attempt consumes the same budget before invitation validation, password verification or user creation.

## Required setup before a separately approved release

- Review the additive `0002_auth_attempt_windows.sql` migration. It creates only a limiter table and expiry index; no existing account, session or progress row is modified. This PR does not apply it to any remote database.
- Configure a private, high-entropy `AUTH_RATE_LIMIT_KEY` of 32–512 characters. It must be identical across all instances sharing the account database. No real key is included or configured here. Changing it creates new subject digests and resets effective per-IP budgets, so rotation requires a deliberate release plan.
- Missing/invalid key, missing table, invalid storage result, failed upsert or failed cleanup returns 503 `AUTH_STORAGE_ERROR`. There is no in-memory fallback. **Existing-account login will also be unavailable until both prerequisites are ready.** Account lookup/me/logout/progress routes do not need this new key.
- Do not deploy first and treat missing setup as a harmless warning. Migration application, remote verification, production key setup and deployment remain separate owner-approved operations.

## Privacy, costs and limits

Only an HMAC-SHA256 digest of the IP subject is persisted, using a versioned domain prefix. The raw IP, email and invitation secret are not stored in the limiter table or logged by this code. Missing connecting-IP headers share a conservative `unknown` budget. The trustworthiness of the connecting-IP header depends on the hosting ingress and must be checked before another deployment path is used.

Upsert updates expiry only when starting a new window. On the first admitted request in a window, cleanup deletes at most 100 expired rows using the expiry index. Expired rows may remain during inactivity; cleanup is not a strict deletion deadline. No Cron or background service was added.

This adds database operations to parsed authentication attempts. It does not claim free/unlimited hosting or prevent distributed-IP abuse, quota exhaustion, denial of service or lockouts for users behind a shared NAT. Per-account policy, IP canonicalization for alternate ingress, total/global budgets and cost limits require separate design decisions.

## Verification

`recall.rate-limit.test.mjs` uses actual workerd local D1 and on-disk persistence. It checks 24 concurrent attempts across independent module instances, exact 12-admission budget, persisted restart, expiry boundary, independent IPs, route sharing, missing configuration, unavailable storage, missing actual table, bounded cleanup and absence of raw IP storage. All outbound network access is blocked.

The complete Worker suite also keeps existing origin, byte-limit, invite, password, PBKDF2, session, progress and disabled-grading regressions. Tests use dummy keys and isolated local databases only.

Implementation references: [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) and [local Miniflare D1 bindings](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/). Local runtime tests, rather than those documents alone, establish the SQL behavior exercised by this change.
