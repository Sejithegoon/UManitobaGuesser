# Phase 4: accounts, UM verification, leaderboard

Status (2026-10-14): **deployed to `notsgakxgnkgcrlvnduw`.** Migrations `20261020000100`–`300` are applied, and the Edge Functions `um-verify` and `delete-account` are deployed. 149/149 offline tests pass.

Email delivery isn't set up yet, so sign-in codes only reach project team members, and UM verification emails are off.

## What's built

| Piece | Where |
|---|---|
| Ranking requires current UM verification (5/10/20 rounds) | `game_start` in `20261020000100_accounts.sql` |
| Username check, deletion log (35 days) | `username_available`, `account_log_deletion`, `private.deleted_accounts` |
| UM verification rules: 15 min expiry, 5 attempts, 3 sends/hour and 10/day, one UM email per account | `um_start` / `um_confirm` (server key only), `um_affiliations`, `um_verification_requests` |
| Leaderboard (week/30 days/all, best per verified active player), personal bests | `leaderboard()`, `my_bests()` |
| Email the UM code; store only keyed hashes | `supabase/functions/um-verify` |
| Delete account (fresh code within 10 min; guests anytime) | `supabase/functions/delete-account` |
| Pages | `account.html` + `static/account.js`, `leaderboard.html` + `static/leaderboard.js`, `static/account.css` |
| Switches | `accounts`, `leaderboard` in `static/config.js` |

Edge Function secrets set: `UM_EMAIL_HMAC_KEY` (random, generated and never shown) and `UM_HMAC_KEY_VERSION=1`.

## Remaining setup (project owner, in the dashboard)

1. **Resend.** Create an account, add the domain `umanitobaguesser.ca`, and add the DNS records Resend shows at GoDaddy. Then create an API key.
2. **Supabase → Authentication → Emails → SMTP settings.** Turn on custom SMTP with Resend's details:
   - host `smtp.resend.com`
   - port `465`
   - user `resend`
   - password = the API key
   - sender, e.g. `login@umanitobaguesser.ca`
3. **Supabase → Authentication → Emails → templates.** In **Magic Link** and **Change Email Address**, include the code: `Your code is {{ .Token }}`.
4. **Supabase → Authentication → Sign In / Providers.**
   - Email **on**, Confirm email **on**.
   - Turn on **"Allow manual linking"**, so guests keep their games when they add an email.
5. **Supabase → Authentication → URL Configuration.**
   - Site URL `https://umanitobaguesser.ca`.
   - Redirect URLs `https://umanitobaguesser.ca/**` and `http://localhost:8000/**`.
6. **Supabase → Edge Functions → Secrets.** Add `RESEND_API_KEY` and `RESEND_FROM`, e.g. `UManitoba Guesser <verify@umanitobaguesser.ca>`.

Until then:
- Signing in only works for team members' emails (Supabase's built-in mailer).
- The account page says sign-in isn't open to everyone yet.
- UM verification replies "not switched on yet".

## Not yet verified

- A guest who adds an email keeps their games: the same user ID via `updateUser({ email })`. Needs manual linking turned on, and a real test.
- Whether UM's Microsoft 365 mail delivers or quarantines the codes.
- No browser end-to-end test of sign-in, verification or deletion yet, because that needs working email.
