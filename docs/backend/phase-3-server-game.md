# Phase 3: server-run game

Status: **applied to Supabase `notsgakxgnkgcrlvnduw` and tested end to end (2026-10-15). Still switched off on the live site (`serverGame: false`).**

Live results, from a local browser with `?server=1` against the real project:
- Full 5-round guest game: the screen total (12,875) equals the database total. The game is `finished` and unranked, and the guest can't read `locations` (`42501`).
- A triple-click on Next only advances one round. A client timeout scores 0 and reveals the answer.
- Timing: a 12 s photo load gives 25.9 s remaining (30 s − 4 s beyond the allowance). A guess arriving at 11 s on Hard is a timeout. A guess at 8.5 s on Hard is accepted (grace).
- Fallback: with guest sign-ins blocked, the page switches to the classic game.

Auth settings this needs: "Allow new users to sign up" **on** (Supabase counts guests as sign-ups), anonymous sign-ins **on**, Email provider **off** until Phase 4.

## What changed

| Piece | File | Notes |
|---|---|---|
| Game engine | `supabase/migrations/20261015000100_game_engine.sql` | 5 RPCs: `game_start`, `game_start_round`, `game_submit`, `game_next_round`, `game_finish`. They're `SECURITY DEFINER`, use `search_path = ''`, and can be executed by signed-in sessions only. Adds `game_rounds.started_at`. |
| Engine tests | `supabase/tests/database/06_game_engine_test.sql` | 40 assertions. The full suite is 118. |
| Photo copies | `locations/p/<random key>.jpg` | 86 photos at ≤1600 px, about 267 KB each, with metadata stripped. The originals in `locations/IMG/` are untouched. |
| Photo key script | `supabase/scripts/build_photos.py` | Writes `supabase/seed/photo_keys.local.{sql,json}`, both **git-ignored**: the mapping would reveal the answers. |
| Browser client | `static/config.js`, `static/api.js` | Supabase is only contacted when `serverGame: true` or the page URL has `?server=1`. The SDK is pinned and SRI-checked. |
| Game | `static/game.js`, `play.html` | Each step has a server branch, and the classic path is unchanged. |

## Timing policy v1 (approved)

1. The server issues a round with a provisional deadline: issue time + **8 s** load allowance + time limit + **2 s** grace.
2. When the photo has loaded, the browser calls `game_start_round`. The clock starts at `min(arrival, issue + 8 s)`, at most once.
3. A guess counts only if it **arrives** by the deadline. Otherwise it's a timeout worth 0.
4. The countdown shown to the player is the server's remaining time, minus the grace.

In server mode, round 1 is issued only **after the rules popup is closed**, so reading the rules never uses round time. The next photo isn't preloaded, so nobody can study it early.

## Behaviour when the server is unavailable

If the guest sign-in or `game_start` fails, the page falls back to the classic game. Players are never blocked. Tested: with guest sign-ins disabled, `?server=1` falls back and the classic game runs.

## Steps to finish testing (dashboard / CLI, by the project owner)

1. `npx supabase@latest db push --dry-run`, then `npx supabase@latest db push`. Applies the engine migration.
2. **SQL Editor**: run `supabase/seed/photo_keys.local.sql`. It points each location at its photo copy and ends by verifying all 86.
3. **Authentication → Sign In / Providers**: allow new sign-ups **and** anonymous sign-ins, and turn the Email provider **off**.
   - Supabase limits these to 30 per hour per IP.
   - Until CAPTCHA is added, anyone with the public key can open guest sessions and play unranked server games. This can be switched off again after testing.
4. Then run a browser test locally with `?server=1`.

## Before switching it on for everyone (launch checklist)

- [ ] Browser end-to-end test passes, including throttled "Slow 3G".
- [ ] CAPTCHA (Cloudflare Turnstile) enabled for anonymous sign-ins.
- [ ] `privacy.html` updated. Guests get a session token stored in the browser, and game rounds are stored on the server.
- [ ] `serverGame: true` in `static/config.js`, merged and deployed.
- [ ] After a stable period: remove `locations/locations.json` and the building-named photos (see `design-decisions.md` § 3).

## Known limits

- The original photos and answers remain in public git history, so ranked integrity is best-effort (see `schema-and-access.md`).
- Repo size grows by about 23 MB until the originals are removed in the clean-up step.
