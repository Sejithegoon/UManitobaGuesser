# Schema and access control (Phase 2)

Status: **applied to Supabase project `notsgakxgnkgcrlvnduw` (ca-central-1) on 2026-10-14 via `supabase db push`. Offline tests: 77/77 (PGlite). Live checks with the publishable key: 11/11 (visitor reads of answers/games/private columns and all visitor writes denied; public profile fields readable). Signed-in and guest rules are not yet tested live (sign-ups are off). Locations not yet imported.**

Migrations, applied in order:

| File | Contents |
|---|---|
| `supabase/migrations/20261014000100_core_schema.sql` | Tables, constraints, indexes, triggers |
| `supabase/migrations/20261014000200_access_control.sql` | RLS, grants, policies |
| `supabase/migrations/20261014000300_reserved_usernames.sql` | Reserved-name list |

## Tables

| Table | Why it exists | Owned by | Deleted when |
|---|---|---|---|
| `profiles` | Public identity (username) for **registered** users. Holds affiliation + moderation flags. No email: that stays in `auth.users`. | `auth.users.id` (1:1) | The auth user is deleted (cascade) |
| `locations` | The answer key: photo -> coordinates. `legacy_name` maps to today's photo names; `public_key` is the opaque name photos will use from Phase 3. | System | Never hard-deleted while used in history (`RESTRICT`); set `active = false` instead |
| `games` | One played game, including guests'. `total_score` and `is_ranked` are authoritative and server-written only. | `auth.users.id` | The auth user is deleted (cascade) |
| `game_rounds` | One round: which location, the **server-set deadline**, the guess and its score. | its game | Its game is deleted (cascade) |
| `reserved_usernames` | Names nobody may register (staff, "UManitoba", system words). | System | Admin only |

Deliberately **not** created yet:

- `um_verifications`: the Phase 4 UM-email flow needs somewhere to keep a hashed one-time code, an expiry and an attempt counter. Nothing uses it before then, so it'll arrive with that flow in a Phase 4 migration, with the same no-client-access rules as `locations`.
- Stats tables: totals and bests are derived from `games`, so there is nothing for a user to tamper with.

### Key constraints

- **Usernames**: `^[A-Za-z0-9_]{3,20}$`. Unique on `lower(username)`, so "Bison" and "bison" collide. Checked against `reserved_usernames` (case-insensitive) by a trigger.
- **Affiliation**: `is_um_verified` must agree with `um_verified_at`, and clients have no write grant on either.
- **One active game per user**: a partial unique index on `games(user_id) where status = 'active'`.
- **Score sanity**: `0 <= total_score <= rounds_completed * 5000`. Unlimited games (`rounds_planned is null`) can never be ranked.
- **Rounds**:
  - The deadline must come after the issue time.
  - A score of 0–5000.
  - A resolved round is either a timeout or a guess with distance and score, never half-filled.
  - The same location can't appear twice in one game.

## Access rules

Roles:

- `anon`: no session.
- `authenticated`: signed in. Guests are `authenticated` too, with the JWT claim `is_anonymous = true`.
- `service_role`: server secret key. It bypasses RLS and never reaches the browser.

**Deny by default**:

- Every table has RLS on.
- Every privilege is first **revoked** from `anon` and `authenticated`. Projects created before 2026-05-30 grant those roles full access by default.
- Then the minimum is granted per column.
- An action needs **both** a column grant and an RLS policy.

| Table | anon (visitor) | authenticated (incl. guests) | Notes |
|---|---|---|---|
| `profiles` | SELECT `id, username, is_um_verified, created_at` of `active` profiles | Same, plus their own row even if moderated. INSERT `(id, username)` and UPDATE `(username)` of **their own** row, **registered users only** | No client DELETE. `role`, `moderation_status`, `is_um_verified`, `um_verified_at` and timestamps aren't writable, and `role`/`moderation_status` aren't readable. |
| `games` | none | SELECT their own rows | No INSERT/UPDATE/DELETE: Phase 3 game functions are the only writers |
| `game_rounds` | none | SELECT rounds of their own games | Same. Readable fields: `location_id` (an opaque UUID), timing, their guess, score |
| `locations` | none | none | RLS on, **no policies, no grants**. Even a mistaken future grant reveals no rows. |
| `reserved_usernames` | none | none | Admin only |

### Privileged functions (current)

| Function | Security | Why | Who can execute |
|---|---|---|---|
| `private.enforce_username_rules()` | `SECURITY DEFINER`, `search_path = ''` | A trigger must read `reserved_usernames`, which clients can't. It only raises or passes and returns nothing usable. | Trigger only; EXECUTE revoked from `public`, `anon` and `authenticated` |
| `private.set_updated_at()` | invoker | Trigger | EXECUTE revoked from client roles |
| `private.is_registered_user()` | invoker | Reads the caller's own JWT for RLS | `authenticated` |

The `private` schema isn't exposed by the Data API.

### Rules for Phase 3+ functions

The `05_security_meta_test.sql` test enforces the first two of these on every future migration:

1. Every `SECURITY DEFINER` function pins `search_path` (usually `''`) and fully qualifies names.
2. EXECUTE is revoked from `public`, then granted explicitly to the narrowest role. For example, game RPCs go to `authenticated` only, never `anon`.
3. Functions derive the user from `auth.uid()` and the JWT. They never take a user id or a timestamp from the client.
4. Functions return only what the caller is entitled to see. For example, a location's coordinates are returned only after that round is resolved.

## Old answers remain public in git history

`locations/locations.json` (with coordinates) and the building-named photo files are in this repository's public git history.

- Moving the answer key into the database **does not erase that exposure**.
- Renaming the photos doesn't either: an old copy can be matched by content.
- Rewriting git history would need a force push, and still wouldn't remove forks, clones or archives.

So ranked integrity for the existing 86 locations is **best-effort**. The plan in `design-decisions.md` § 3 limits the damage.
