# Launch: switching the server game on for everyone

Order matters: every step before 6 is invisible to players, because the live site keeps `serverGame: false` until then.

| # | Who | Step | Status |
|---|---|---|---|
| 1 | Owner | **Cloudflare Turnstile widget**: dash.cloudflare.com → Turnstile → *Add widget*. Name: UManitoba Guesser. Hostnames: `umanitobaguesser.ca` and `localhost`. Mode: **Managed**. You get a **site key** (public) and a **secret key** (private). | |
| 2 | Owner | **Supabase → Authentication → Bot and Abuse Protection**: enable CAPTCHA protection, provider **Turnstile**, paste the **secret key**, then save. Never put the secret key in the repo or in chat. | |
| 3 | Owner | **Supabase → Authentication → Sign In / Providers → Email**: **off** (until Phase 4 accounts). | |
| 4 | Owner | `npx supabase@latest db push`. Applies `20261016000100_guest_cleanup.sql`. | |
| 5 | Owner | **Schedule the daily guest clean-up** (SQL Editor, once). See below. | |
| 6 | Claude | Put the **site key** in `static/config.js`, test locally with the real bot check, set `serverGame: true`, then merge to `main` and push. | |
| 7 | Both | Watch for a few days. If anything is wrong, set `serverGame: false` and push: the site falls back to the classic game. | |
| 8 | Later (a few weeks) | Remove `locations/locations.json` and `locations/IMG/` (the public answers). See `design-decisions.md` § 3. | |

## Step 5: schedule the clean-up

Supabase → Integrations → **Cron**: enable it. Or run the `create extension` line below, which does the same. Then, in the SQL Editor:

```sql
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'purge-inactive-guests',
  '17 9 * * *',   -- daily at 09:17 UTC (about 4 a.m. in Winnipeg)
  $$ select private.purge_inactive_guests(30) $$
);
```

Check that it's scheduled: `select jobname, schedule, active from cron.job;`

What it deletes: guest users created more than 30 days ago with no game started in the last 30 days, plus their games (cascade). Registered users are never touched. This is tested in `07_guest_cleanup_test.sql`.

## Rollback

| Problem | Fix |
|---|---|
| Server game misbehaving | `serverGame: false` in `static/config.js`, then push. Players get the classic game straight away. |
| Bot check blocking real people | Supabase → Bot and Abuse Protection → disable. Guests can sign in again without a token. |
| Anything in the database | Migrations are only additive. Nothing removes the classic game until step 8. |
