-- =====================================================================
-- UManitoba Guesser - Phase 5B: Daily Challenge
-- The same 5 photos for everyone each day (Winnipeg time), medium timer,
-- one attempt per player per day. Daily games are never ranked on the
-- main leaderboard; they get their own daily board.
-- =====================================================================

alter table public.games
  add column mode      text not null default 'solo',
  add column daily_day date;

alter table public.games
  add constraint games_mode_valid check (mode in ('solo', 'daily')),
  add constraint games_daily_consistent check ((mode = 'daily') = (daily_day is not null)),
  add constraint games_daily_shape check (mode <> 'daily' or (rounds_planned = 5 and difficulty = 'medium' and not is_ranked));

-- One attempt per player per day (an abandoned attempt still counts)
create unique index games_one_daily_per_user on public.games (user_id, daily_day) where mode = 'daily';
create index games_daily_board_idx on public.games (daily_day, total_score desc)
  where mode = 'daily' and status = 'finished';

-- ---------------------------------------------------------------------
-- daily_challenges: the day's 5 locations. Server-only, like locations.
-- ---------------------------------------------------------------------
create table public.daily_challenges (
  day           date primary key,
  location_ids  uuid[] not null,
  created_at    timestamptz not null default now(),
  constraint daily_challenges_five check (cardinality(location_ids) = 5)
);
comment on table public.daily_challenges is
  'Each day''s Daily Challenge photos. Part of the answer key: no client access.';
alter table public.daily_challenges enable row level security;
revoke all on table public.daily_challenges from anon, authenticated;

create or replace function private.daily_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Winnipeg')::date
$$;

-- Daily #1 is launch day
create or replace function private.daily_number(p_day date) returns int
language sql immutable set search_path = '' as $$
  select (p_day - date '2026-11-06') + 1
$$;

-- The day's challenge, created on first use. Prefers photos that weren't
-- in the last two weeks of dailies.
create or replace function private.daily_challenge(p_day date)
returns public.daily_challenges language plpgsql set search_path = '' as $$
declare d public.daily_challenges;
begin
  select * into d from public.daily_challenges where day = p_day;
  if found then
    return d;
  end if;

  insert into public.daily_challenges (day, location_ids)
  select p_day, array_agg(s.id)
    from (select l.id from public.locations l
           where l.active
           order by exists (select 1 from public.daily_challenges c
                             where c.day > p_day - 14 and l.id = any (c.location_ids)),
                    random()
           limit 5) s
  having count(*) = 5
  on conflict (day) do nothing;

  select * into d from public.daily_challenges where day = p_day;
  if not found then
    raise exception 'not_enough_locations' using errcode = 'P0001';
  end if;
  return d;
end;
$$;

-- ---------------------------------------------------------------------
-- Same as 20261015000100, plus: a daily game takes the day's photos in order
-- ---------------------------------------------------------------------
create or replace function private.issue_round(p_game public.games, p_round_no int)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_loc public.locations;
  v_limit int := private.time_limit_s(p_game.difficulty);
begin
  if p_game.mode = 'daily' then
    select l.* into v_loc
      from public.daily_challenges d
      join public.locations l on l.id = d.location_ids[p_round_no]
     where d.day = p_game.daily_day;
  else
    select l.* into v_loc
      from public.locations l
     where l.active
       and not exists (select 1 from public.game_rounds r where r.game_id = p_game.id and r.location_id = l.id)
     order by random()
     limit 1;
  end if;
  if not found then
    return null;
  end if;

  insert into public.game_rounds (game_id, round_no, location_id, issued_at, deadline_at)
  values (p_game.id, p_round_no, v_loc.id, now(),
          now() + private.load_allowance() + make_interval(secs => v_limit) + private.network_grace());

  return jsonb_build_object(
    'round_no', p_round_no,
    'photo', 'locations/p/' || v_loc.public_key || '.jpg',
    'time_limit_s', v_limit,
    'load_allowance_s', extract(epoch from private.load_allowance())::int
  );
end;
$$;

-- ---------------------------------------------------------------------
-- RPC: start today's Daily Challenge (abandons any active game). The rest
-- of the game uses the normal game_start_round / game_submit / ... RPCs.
-- ---------------------------------------------------------------------
create or replace function public.daily_start()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_day date := private.daily_today();
  v_game public.games;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  perform private.daily_challenge(v_day);
  if exists (select 1 from public.games where user_id = v_uid and mode = 'daily' and daily_day = v_day) then
    raise exception 'daily_already_played' using errcode = 'P0001';
  end if;

  update public.games set status = 'abandoned', finished_at = now()
   where user_id = v_uid and status = 'active';

  insert into public.games (user_id, difficulty, rounds_planned, is_ranked, mode, daily_day)
  values (v_uid, 'medium', 5, false, 'daily', v_day)
  returning * into v_game;

  return jsonb_build_object(
    'game_id', v_game.id,
    'difficulty', v_game.difficulty,
    'rounds_planned', v_game.rounds_planned,
    'pool_size', 5,
    'is_ranked', false,
    'daily_number', private.daily_number(v_day),
    'timing_policy_version', v_game.timing_policy_version,
    'round', private.issue_round(v_game, 1)
  );
end;
$$;

-- Today's numbers, and the caller's result if they've played. Visitors too.
create or replace function public.daily_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_day date := private.daily_today();
  v_mine public.games;
  v_players int;
  v_below int;
begin
  select * into v_mine from public.games
   where user_id = auth.uid() and mode = 'daily' and daily_day = v_day;
  select count(*) into v_players from public.games
   where mode = 'daily' and daily_day = v_day and status = 'finished';
  if v_mine.status = 'finished' then
    select count(*) into v_below from public.games
     where mode = 'daily' and daily_day = v_day and status = 'finished' and total_score < v_mine.total_score;
  end if;

  return jsonb_build_object(
    'day', v_day,
    'number', private.daily_number(v_day),
    'players', v_players,
    'played', v_mine.id is not null,
    'my_status', v_mine.status,
    'my_score', case when v_mine.status = 'finished' then v_mine.total_score end,
    -- "You beat N% of today's players"
    'beat_pct', case when v_mine.status = 'finished' and v_players > 1
                     then round(100.0 * v_below / (v_players - 1))::int end,
    'resets_in_s', greatest(0, extract(epoch from (((v_day + 1)::timestamp at time zone 'America/Winnipeg') - now()))::int)
  );
end;
$$;

-- The day's board: registered players with a username (guests can play but
-- aren't listed). Same visibility rule as the main board for hidden/banned.
create or replace function public.daily_leaderboard(p_day date default null)
returns table (rank bigint, username text, score int, is_verified boolean, is_me boolean)
language sql stable security definer set search_path = '' as $$
  select rank() over (order by g.total_score desc, g.finished_at asc),
         p.username, g.total_score, p.is_um_verified, g.user_id = auth.uid()
    from public.games g
    join public.profiles p on p.id = g.user_id
   where g.mode = 'daily' and g.status = 'finished'
     and g.daily_day = least(coalesce(p_day, private.daily_today()), private.daily_today())
     and p.moderation_status = 'active'
   order by g.total_score desc, g.finished_at asc
   limit 50
$$;

-- Same as 20261020000300, but daily games don't mix into the solo bests
create or replace function public.my_bests()
returns table (difficulty text, rounds_planned smallint, best_score int, ranked_best int, games_played bigint)
language sql stable security definer set search_path = '' as $$
  select g.difficulty, g.rounds_planned, max(g.total_score),
         max(g.total_score) filter (where g.is_ranked), count(*)
    from public.games g
   where g.user_id = auth.uid() and g.status = 'finished' and g.mode = 'solo'
   group by g.difficulty, g.rounds_planned
   order by g.rounds_planned nulls last, g.difficulty
$$;

revoke all on function private.daily_today()                 from public, anon, authenticated;
revoke all on function private.daily_number(date)            from public, anon, authenticated;
revoke all on function private.daily_challenge(date)         from public, anon, authenticated;
revoke all on function private.issue_round(public.games, int) from public, anon, authenticated;
revoke all on function public.daily_start()                  from public, anon;
revoke all on function public.daily_status()                 from public;
revoke all on function public.daily_leaderboard(date)        from public;
revoke all on function public.my_bests()                     from public, anon;
grant execute on function public.daily_start()           to authenticated;
grant execute on function public.daily_status()          to anon, authenticated;
grant execute on function public.daily_leaderboard(date) to anon, authenticated;
grant execute on function public.my_bests()              to authenticated;
