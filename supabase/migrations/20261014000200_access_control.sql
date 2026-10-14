-- =====================================================================
-- UManitoba Guesser 2.0 - Phase 2: access control
--
-- Model: deny by default, then grant the minimum.
--   * Every table has RLS enabled.
--   * All privileges are first REVOKED from anon/authenticated, because
--     Supabase projects created before 2026-05-30 grant full table access
--     to those roles by default. Newer projects do not, so the REVOKEs are
--     a no-op there; keeping them makes behaviour identical on both.
--   * Column-level GRANTs decide *which fields* a role can touch;
--     RLS policies decide *which rows*. Both must allow an action.
--
-- Roles (Supabase):
--   anon           - no session (publishable key only)
--   authenticated  - signed in, including anonymous "guest" sessions
--                    (guests carry the JWT claim is_anonymous = true)
--   service_role   - server-side secret key; bypasses RLS. Never in the browser.
-- See docs/backend/schema-and-access.md for the full rule table.
-- =====================================================================

-- Helper: is the current session a real (non-guest) account?
-- Reads the caller's own JWT only; exposes nothing.
create or replace function private.is_registered_user()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;

grant usage on schema private to authenticated;
revoke all on function private.is_registered_user() from public, anon;
grant execute on function private.is_registered_user() to authenticated;

-- Trigger helpers are never called directly by clients.
revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.enforce_username_rules() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere, strip default privileges
-- ---------------------------------------------------------------------
alter table public.reserved_usernames enable row level security;
alter table public.profiles           enable row level security;
alter table public.locations          enable row level security;
alter table public.games              enable row level security;
alter table public.game_rounds        enable row level security;

revoke all on table public.reserved_usernames from anon, authenticated;
revoke all on table public.profiles           from anon, authenticated;
revoke all on table public.locations          from anon, authenticated;
revoke all on table public.games              from anon, authenticated;
revoke all on table public.game_rounds        from anon, authenticated;

-- ---------------------------------------------------------------------
-- reserved_usernames: no client access at all (admins use the dashboard
-- / service role). No policies => RLS denies every row.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- locations: THE ANSWER KEY. No grants, no policies => no client can read
-- or write it, even if a grant is added by mistake later (RLS still denies).
-- Phase 3 game functions will read it as their owner.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- profiles
--   Read : anyone may read the public columns of non-moderated profiles;
--          you may always read your own row.
--   Write: a registered user may create/rename their own profile, and may
--          only write `username` (+ `id` on insert). Affiliation, role and
--          moderation columns are not granted, so writes to them fail.
--   Delete: none from the client (account deletion removes the auth user,
--          which cascades; Phase 4 server function).
-- ---------------------------------------------------------------------
grant select (id, username, is_um_verified, created_at) on table public.profiles to anon, authenticated;
grant insert (id, username)                            on table public.profiles to authenticated;
grant update (username)                                on table public.profiles to authenticated;

create policy profiles_select_public
  on public.profiles for select
  to anon, authenticated
  using (moderation_status = 'active' or id = auth.uid());

create policy profiles_insert_own
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid() and private.is_registered_user());

create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = auth.uid() and private.is_registered_user())
  with check (id = auth.uid() and private.is_registered_user());

-- ---------------------------------------------------------------------
-- games / game_rounds
--   Read : owner only (guests included - they own their games).
--   Write: none from the client. Phase 3 SECURITY DEFINER functions
--          (owned by postgres, fixed search_path, explicit EXECUTE grants)
--          will be the only writers.
-- ---------------------------------------------------------------------
grant select on table public.games to authenticated;

create policy games_select_own
  on public.games for select
  to authenticated
  using (user_id = auth.uid());

grant select on table public.game_rounds to authenticated;

create policy game_rounds_select_own
  on public.game_rounds for select
  to authenticated
  using (exists (
    select 1 from public.games g
    where g.id = game_rounds.game_id and g.user_id = auth.uid()
  ));
