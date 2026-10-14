# Design decisions to settle before Phase 3

These are proposals for approval. None is implemented yet; Phase 2 only built the tables and constraints they'll use (`game_rounds.issued_at`, `deadline_at`, `games.timing_policy_version`, `is_ranked`).

---

## 1. Timer fairness

### What the server can and cannot know

| Can verify (server clock) | Cannot verify from a browser |
|---|---|
| When it issued a round | When the photo actually finished loading or appeared on screen |
| When each request arrived | The player's clock: any client timestamp is just a number they chose |
| Whether a round was already answered | One-way network delay (only that a request arrived) |
| Whether a request arrived before the stored deadline | Whether the photo was fetched early (devtools, prefetch) and studied |

So **no client-supplied timestamp is trusted**. The browser's countdown is only a display.

### Proposed policy (`timing_policy_version = 1`)

Per round:

1. **Issue.** `issue_round` records `issued_at = now()` and returns the photo's opaque URL, plus the time limit and the allowances below.
2. **Start.** The browser loads the photo, then calls `start_round`. The server takes **effective start = min(arrival time, `issued_at` + LOAD_ALLOWANCE)**.
   - A slow connection gets up to LOAD_ALLOWANCE before the clock starts.
   - Nobody can stall longer than that to study the photo.
3. **Deadline.** `deadline_at = effective start + TIME_LIMIT (30/20/8 s) + NETWORK_GRACE`.
   - The server stores it and returns the remaining milliseconds, and the browser counts down from that.
   - If `start_round` never arrives, the deadline is computed from `issued_at` + LOAD_ALLOWANCE.
4. **Submit.** `submit_guess` is accepted only if it **arrives by `deadline_at`**, for the current round, at most once.
   - A late or missing guess becomes a timeout scoring 0.
   - The server computes distance and score. The client never sends them.

Proposed constants:

| Constant | Value | Why |
|---|---|---|
| `LOAD_ALLOWANCE` | 8 s | Covers the photo download on a weak connection (see the prerequisite below) |
| `NETWORK_GRACE` | 2 s | Absorbs submit latency, so a guess sent at 0.1 s left isn't lost |

They're the same for all difficulties, ranked and unranked, so practice matches ranked play. Changing them means bumping `timing_policy_version`, so old games stay comparable.

**Known trade-off.** A cheater can pre-fetch the photo and delay `start_round`, gaining up to LOAD_ALLOWANCE of extra viewing time. That's 8 s on top of Hard's 8 s, which is significant. The server can't detect it. Options if this proves a problem:
- a separate leaderboard per difficulty (already planned)
- a lower allowance for ranked Hard
- flagging unusually fast-accurate games for review

**Prerequisite.** Photos average 524 KB, but the largest is **5.3 MB**. That takes about 40 s on a 1 Mbit/s connection, far past any sensible allowance. Phase 3 should re-encode photos to about 1600 px and 250 KB or less **before** ranked play opens.

### Tests to add in Phase 3

The tests don't sleep: they set `issued_at` and `deadline_at` in the past as the database owner, then call the functions as a client.

- On time → accepted and scored.
- Arrives inside NETWORK_GRACE after the displayed 0 → accepted.
- Arrives after `deadline_at` → timeout, score 0.
- `start_round` arrives after LOAD_ALLOWANCE → the deadline is still based on `issued_at` + allowance (no extra time).
- `start_round` never called → the deadline is based on `issued_at` + allowance.
- A second submit for the same round → rejected, with no change to the score.
- A submit for a round that isn't current, or after the game finished → rejected.
- A client sends its own timestamp, score or distance → ignored or rejected (the function has no such parameters).
- Browser end-to-end tests on throttled "Slow 3G": a completed round still records a valid guess.

---

## 2. Guest abuse

- **Guests are Supabase anonymous users.** Their JWT carries `is_anonymous = true` [verified in Supabase docs]. Supabase limits anonymous sign-ins to **30 per hour per IP** by default [verified].
  - Supabase "strongly recommends" CAPTCHA for anonymous sign-ins [verified].
  - **Plan:** enable Cloudflare Turnstile on sign-up and anonymous sign-in.
- **Authorization:**
  - The game RPCs will be executable by `authenticated` only (not `anon`), so playing needs a session.
  - Each RPC derives the player from `auth.uid()`.
  - A player can only act on their own active game.
- **Server-side limits:**
  - One active game per user (already a constraint).
  - At most N game starts per user per hour (proposed 30).
  - One submission per round (primary key plus a state check).
  - Starting a new game auto-abandons an active game older than 2 hours.
- **Ranking:** the server sets `is_ranked` when the game starts, and it can't change later. It's true only for a non-anonymous user with an `active` profile in a 5/10/20-round mode. Guest games are always `is_ranked = false`, and the leaderboard reads only ranked games.
- **Cleanup:** Supabase has no automatic cleanup of anonymous users [verified]. A scheduled SQL job (Phase 6) deletes anonymous users older than 30 days, and their games cascade with them.
- **Honest limits:**
  - Anonymous auth doesn't stop bots. A bot can open sessions, within the IP limit and CAPTCHA, and play unranked games. That's acceptable since they're unranked.
  - A determined person can also register several real email accounts. Further mitigations:
    - email confirmation and CAPTCHA at sign-up
    - per-account rate limits
    - moderation (`moderation_status`)
    - reviewing statistically implausible games (e.g. a median error under 5 m across many games)

---

## 3. Answer-key migration (removing public coordinates safely)

1. **Phase 3, alongside today's game.**
   - Build the server-run game behind a switch in a new `static/config.js` (`online: false`).
   - Copy the photos to opaque names (`locations/p/<public_key>.jpg`). These are **copies**: `locations.json` and `locations/IMG/` stay untouched.
2. **Test.** Run the SQL tests plus browser tests against a staging Supabase project, including throttled networks and the timing tests above.
3. **Switch on.**
   - Set `online: true` on the live site.
   - If Supabase can't be reached, the page falls back to today's local, unranked game. That fallback still uses the public file, which is acceptable during the transition.
4. **Stabilize** for a few weeks. Rollback is to flip the switch back, a one-line commit with no data loss.
5. **Remove the public answers.**
   - Delete `locations/locations.json` and the building-named photos from the site.
   - Replace the offline fallback with a friendly "game unavailable" message.
   - Rollback is `git revert` of that commit, which restores the files.
6. **Limit the historical exposure.**
   - Mark new photos added after step 5 as ranked-eligible first, since they've never been public.
   - Gradually retire or re-shoot the oldest locations for ranked play.

Throughout: no DNS change, no hosting change, and the Class Calendar is untouched.

---

## 4. Account deletion (design; implemented in Phase 4)

**Flow:**
1. On the account page, the user confirms with a fresh email code.
2. An Edge Function `delete-account` verifies their JWT.
3. It calls `auth.admin.deleteUser(uid)` with the secret key, which exists only inside Supabase.

**Database consequences** (already enforced and tested in `04_deletion_test.sql`):

- `auth.users` → `profiles`: cascade.
- `auth.users` → `games` → `game_rounds`: cascade.
- Shared `locations` rows are kept, and other users' data is untouched.
- The leaderboard is computed from `games`, so the user's entries disappear immediately.
- The Phase 4 `um_verifications` rows will cascade the same way.

**Backups:**
- The Free plan has no automatic backups [verified]. On Pro, daily backups are kept 7 days [verified], so deleted data can persist in backups for up to 7 days.
- The privacy policy will say so.
- If a backup is ever restored, re-apply deletions from a minimal `private.deleted_accounts` log (user id and time, no personal data), added in Phase 4.

**Logs:** Supabase keeps request and auth logs, which include IP addresses, for a limited period that depends on the plan.
- **Not verified:** the exact retention periods.
- These logs can't be edited per user. The privacy policy will describe them.

**Guests:** guest data is removed by the 30-day anonymous cleanup above.
