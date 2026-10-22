# Single-use, email-bound invitations (Draft; not deployed)

Registration requires `REGISTRATION_ENABLED` to be exactly the string `true`, the persistent limiter prerequisites, and an unexpired/unrevoked invitation bound to the normalized email. `REGISTRATION_INVITE_CODE` is obsolete and never enables registration or serves as a fallback.

The raw invite is 32 cryptographically random bytes encoded as a 43-character base64url token. Only its SHA256/base64url digest is stored. The account email is trimmed/lowercased as in login. A different email, invalid code, redeemed code, expiry or revocation returns the same `INVALID_INVITE_CODE` response. Registration stays disabled when the flag is absent or invalid. Existing-account login does not need the registration flag or invitation tables; it still requires the limiter table/key.

## Atomic redemption

The API first checks invitation eligibility, then derives the password hash. The authoritative write is one D1 batch: user insert, redemption insert, session insert. The redemption primary key allows only one use. A database trigger rechecks email binding, revocation and expiry inside the batch, including database time, so a change after the initial lookup cannot bypass those checks. A failed statement rolls back the entire batch. Concurrent same-email requests can return 403 or 409 for losers; only one complete account/session/redemption may commit.

The presence of the validation trigger is required by the eligibility query. A partial migration without the trigger cannot register; missing tables produce service-unavailable errors. No automatic schema creation occurs in a request.

Rate-limit attempts remain charged on rejected/failed registration, while failed transaction writes do not consume the invitation. If a database operation commits but a response is lost, the owner must verify state instead of blindly reissuing tokens; an existing account can use login. This is not a claim that transport failures can undo a committed transaction.

## Separate owner workflow before release

No steps below were executed against a remote service by this PR. Migration, production configuration, invitation issuance/delivery/revocation and deployment each remain outside the development task and require separate approval.

1. Review additive migrations `0002_auth_attempt_windows.sql` and `0003_single_use_invites.sql` in an isolated database. Existing users, sessions and progress are not rewritten by those migrations. Confirm all three invitation schema objects exist (two tables and the validation trigger).
2. Configure the existing persistent limiter key consistently. Keep registration disabled while preparing and checking the invitation data. Do not retain a release path that automatically falls back to a shared secret.
3. The offline `createInviteRecord(email, expiresAt)` helper in `invite-record.js` prepares one high-entropy invitation with an explicit future expiry. It performs no database/network writes and does not log. Treat the returned `inviteCode` as private; do not paste it into PRs, CI output or application logs. This helper has only been exercised with local test fixtures here.
4. Under separately approved issuance, insert **only** `tokenHash`, `allowedEmail`, `createdAt`, `expiresAt` and NULL `revoked_at` into `registration_invites`, using a prepared statement. Never persist the raw code in that table. Deliver the raw code once through an approved private channel to the named recipient. No issuance/delivery endpoint or admin UI is added in this PR.
5. To revoke an unused invitation under separate approval, set a non-null `revoked_at` on its hash row. Prepare a fresh independent token for replacement; never delete redemption history to reuse an old token. Registration can be disabled immediately by removing or changing `REGISTRATION_ENABLED` while existing login remains available if its own prerequisites are ready.
6. Review retention of invitation email bindings and redemption history, database quotas, monitoring and release tests before enabling registration. Email addresses are intentionally stored for binding; this is not anonymous invitation storage. There is no cleanup Cron or automatic expiry deletion in this change.

For rollback, prefer disabling registration in the current code and retaining additive tables and existing account/session records. Reverting to older shared-invite code may re-enable reusable registration if an old secret is still configured; do not perform an automatic code/schema downgrade as a recovery step. Any later rollback must be separately reviewed.

## Verification

The full Worker suite includes `recall.invites.test.mjs`, which uses real local workerd D1. It verifies offline preparation without persistence, absent/wrong/expired/revoked codes, wrong email, password rejection without consumption, one successful redemption, restart persistence, existing login, an eight-request race across independent handlers, injected account/session failures and retry, duplicate-email rollback, revocation/expiry between lookup and batch, and partial/missing schema. All outbound network calls are forbidden; all tokens are isolated test fixtures.

The test validates real D1 batch rollback and SQLite trigger behavior; it is not live, multi-region or deployment proof. See the [D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) for the API contract used by the implementation.
