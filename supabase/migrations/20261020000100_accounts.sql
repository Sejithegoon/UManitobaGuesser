-- =====================================================================
-- UManitoba Guesser 2.0 - Phase 4A: accounts
--   * Ranking now requires current UM verification (Phase 4B sets it)
--   * username_available() for the sign-up form
--   * deletion log (re-apply deletions after a backup restore), 35-day retention
-- =====================================================================

-- ---------------------------------------------------------------------
-- Ranked = registered + active profile + UM-verified + 5/10/20 rounds.
-- Same function as 20261015000100, only the v_ranked rule changed.
-- ---------------------------------------------------------------------
create or replace function public.game_start(p_difficulty text, p_rounds int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_recent int;
  v_pool int;
  v_ranked boolean;
  v_game public.games;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if p_difficulty is null or p_difficulty not in ('easy', 'medium', 'hard') then
    raise exception 'invalid_difficulty' using errcode = 'P0001';
  end if;
  if p_rounds is not null and p_rounds not in (5, 10, 20) then
    raise exception 'invalid_rounds' using errcode = 'P0001';
  end if;

  select count(*) into v_recent
    from public.games where user_id = v_uid and started_at > now() - interval '1 hour';
  if v_recent >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  select count(*) into v_pool from public.locations where active;
  if v_pool = 0 or (p_rounds is not null and v_pool < p_rounds) then
    raise exception 'not_enough_locations' using errcode = 'P0001';
  end if;

  update public.games set status = 'abandoned', finished_at = now()
   where user_id = v_uid and status = 'active';

  v_ranked := p_rounds is not null
              and private.is_registered_user()
              and exists (select 1 from public.profiles p
                           where p.id = v_uid and p.moderation_status = 'active' and p.is_um_verified);

  insert into public.games (user_id, difficulty, rounds_planned, is_ranked)
  values (v_uid, p_difficulty, p_rounds, v_ranked)
  returning * into v_game;

  return jsonb_build_object(
    'game_id', v_game.id,
    'difficulty', v_game.difficulty,
    'rounds_planned', v_game.rounds_planned,
    'pool_size', v_pool,
    'is_ranked', v_game.is_ranked,
    'timing_policy_version', v_game.timing_policy_version,
    'round', private.issue_round(v_game, 1)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Username availability (for the form; the table constraints still decide)
-- ---------------------------------------------------------------------
create or replace function public.username_available(p_username text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if p_username is null or p_username !~ '^[A-Za-z0-9_]{3,20}$' then
    return 'invalid';
  end if;
  if exists (select 1 from public.reserved_usernames r where r.name = lower(p_username)) then
    return 'reserved';
  end if;
  if exists (select 1 from public.profiles p where lower(p.username) = lower(p_username)
              and p.id is distinct from auth.uid()) then
    return 'taken';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Deletion log: user id + time only. Used to re-apply deletions if a
-- backup is ever restored; kept 35 days (backups are kept <= 7-14 days).
-- ---------------------------------------------------------------------
create table private.deleted_accounts (
  user_id     uuid primary key,
  deleted_at  timestamptz not null default now()
);
revoke all on table private.deleted_accounts from public, anon, authenticated;

-- Called by the delete-account Edge Function (server secret key only)
create or replace function public.account_log_deletion(p_user uuid)
returns void language sql security definer set search_path = '' as $$
  insert into private.deleted_accounts (user_id) values (p_user)
  on conflict (user_id) do update set deleted_at = now();
$$;
revoke all on function public.account_log_deletion(uuid) from public, anon, authenticated;
grant execute on function public.account_log_deletion(uuid) to service_role;

-- The daily guest purge also trims the deletion log
create or replace function private.purge_inactive_guests(p_days int default 30)
returns int
language plpgsql
set search_path = ''
as $$
declare n int;
begin
  if p_days is null or p_days < 1 then
    raise exception 'p_days must be >= 1';
  end if;

  with gone as (
    delete from auth.users u
     where u.is_anonymous
       and u.created_at < now() - make_interval(days => p_days)
       and not exists (
         select 1 from public.games g
          where g.user_id = u.id and g.started_at > now() - make_interval(days => p_days))
    returning 1
  )
  select count(*) into n from gone;

  delete from private.deleted_accounts where deleted_at < now() - interval '35 days';
  return n;
end;
$$;
revoke all on function private.purge_inactive_guests(int) from public, anon, authenticated;
