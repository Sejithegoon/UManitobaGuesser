-- =====================================================================
-- UManitoba Guesser 2.0 - Phase 3: server-run game engine
--
-- The browser never sees an answer before it has guessed. All game state
-- changes go through five RPCs (public.game_*), which are SECURITY DEFINER
-- functions owned by the migration role, pinned to search_path = '', and
-- executable by signed-in sessions (registered or guest) only.
--
-- Timing policy v1 (docs/backend/design-decisions.md section 1):
--   issue:   deadline = issued_at + LOAD_ALLOWANCE + TIME_LIMIT + GRACE
--   start:   effective_start = least(now(), issued_at + LOAD_ALLOWANCE)
--            deadline = effective_start + TIME_LIMIT + GRACE   (once)
--   submit:  accepted only if it ARRIVES by deadline; otherwise timeout.
-- No client timestamp, distance or score is ever accepted.
-- =====================================================================

alter table public.game_rounds add column started_at timestamptz;
alter table public.game_rounds add constraint game_rounds_started_after_issue
  check (started_at is null or started_at >= issued_at);

-- ---------------------------------------------------------------------
-- Pure helpers (no privileges needed; not callable by clients)
-- ---------------------------------------------------------------------
create or replace function private.time_limit_s(p_difficulty text)
returns int language sql immutable set search_path = '' as $$
  select case p_difficulty when 'easy' then 30 when 'medium' then 20 when 'hard' then 8 end
$$;

create or replace function private.load_allowance() returns interval
language sql immutable set search_path = '' as $$ select interval '8 seconds' $$;

create or replace function private.network_grace() returns interval
language sql immutable set search_path = '' as $$ select interval '2 seconds' $$;

-- Haversine with R = 6,371,000 m: identical to Leaflet's map.distance()
-- (L.CRS.Earth, leaflet 1.9.4), so server scores match the classic game.
create or replace function private.distance_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable set search_path = '' as $$
  select 6371000 * 2 * atan2(sqrt(a), sqrt(1 - a))
  from (select least(1.0, greatest(0.0,
          power(sin(radians(lat2 - lat1) / 2), 2)
          + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))) as a) s
$$;

-- Same curve as static/game.js calcScore(): 5000 * e^(-max(0, d - 10) / 200).
-- floor(x + 0.5) reproduces JavaScript Math.round (Postgres round() on
-- float8 rounds half to even).
create or replace function private.score_for(p_distance float8)
returns int language sql immutable set search_path = '' as $$
  select floor(5000 * exp(-greatest(0, p_distance - 10) / 200) + 0.5)::int
$$;

-- The caller's active game, locked for the rest of the call (serializes
-- double-clicks / parallel requests). Same error whether it doesn't exist,
-- isn't theirs, or is over, so ids can't be probed.
create or replace function private.lock_active_game(p_game_id uuid)
returns public.games language plpgsql set search_path = '' as $$
declare g public.games;
begin
  select * into g from public.games
   where id = p_game_id and user_id = auth.uid() and status = 'active'
   for update;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  return g;
end;
$$;

create or replace function private.current_round(p_game_id uuid)
returns public.game_rounds language sql set search_path = '' as $$
  select * from public.game_rounds where game_id = p_game_id order by round_no desc limit 1
$$;

-- Issue the next round: a random active location not yet used in this game.
-- The provisional deadline assumes start never arrives (see policy above).
create or replace function private.issue_round(p_game public.games, p_round_no int)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_loc public.locations;
  v_limit int := private.time_limit_s(p_game.difficulty);
begin
  select l.* into v_loc
    from public.locations l
   where l.active
     and not exists (select 1 from public.game_rounds r where r.game_id = p_game.id and r.location_id = l.id)
   order by random()
   limit 1;
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

create or replace function private.round_summary(p_game_id uuid)
returns jsonb language sql set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'round_no', r.round_no, 'score', r.score, 'distance_m', r.distance_m, 'timed_out', r.timed_out)
           order by r.round_no), '[]'::jsonb)
    from public.game_rounds r
   where r.game_id = p_game_id and r.guessed_at is not null
$$;

-- ---------------------------------------------------------------------
-- RPC 1: start a game (abandons any active one)
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

  -- Rate limit: 30 game starts per user per rolling hour
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

  -- Ranked only for registered, non-moderated players in fixed-length modes.
  -- Decided once, here; nothing can change it later.
  v_ranked := p_rounds is not null
              and private.is_registered_user()
              and exists (select 1 from public.profiles p where p.id = v_uid and p.moderation_status = 'active');

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
-- RPC 2: the photo has loaded -> start the round clock (first call only)
-- ---------------------------------------------------------------------
create or replace function public.game_start_round(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games := private.lock_active_game(p_game_id);
  v_r public.game_rounds := private.current_round(p_game_id);
  v_start timestamptz;
begin
  if v_r.guessed_at is not null then
    raise exception 'round_already_resolved' using errcode = 'P0001';
  end if;

  if v_r.started_at is null then
    v_start := least(now(), v_r.issued_at + private.load_allowance());
    update public.game_rounds
       set started_at = v_start,
           deadline_at = v_start + make_interval(secs => private.time_limit_s(v_game.difficulty)) + private.network_grace()
     where game_id = v_r.game_id and round_no = v_r.round_no
     returning * into v_r;
  end if;

  return jsonb_build_object(
    'round_no', v_r.round_no,
    'time_limit_s', private.time_limit_s(v_game.difficulty),
    -- What the player's countdown should show (grace is not displayed)
    'remaining_ms', greatest(0, floor(extract(epoch from (v_r.deadline_at - private.network_grace() - now())) * 1000))::int
  );
end;
$$;

-- ---------------------------------------------------------------------
-- RPC 3: submit a guess (null lat/lng = player ran out of time)
-- ---------------------------------------------------------------------
create or replace function public.game_submit(p_game_id uuid, p_lat float8, p_lng float8)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games := private.lock_active_game(p_game_id);
  v_r public.game_rounds := private.current_round(p_game_id);
  v_loc public.locations;
  v_late boolean := now() > v_r.deadline_at;
  v_timeout boolean;
  v_dist float8;
  v_score int := 0;
  v_more boolean;
begin
  if v_r.guessed_at is not null then
    raise exception 'round_already_resolved' using errcode = 'P0001';
  end if;
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180
                                or p_lat = 'NaN'::float8 or p_lng = 'NaN'::float8)) then
    raise exception 'invalid_guess' using errcode = 'P0001';
  end if;

  select * into v_loc from public.locations where id = v_r.location_id;
  v_timeout := p_lat is null or v_late;

  if v_timeout then
    update public.game_rounds
       set guessed_at = now(), timed_out = true, score = 0
     where game_id = v_r.game_id and round_no = v_r.round_no;
  else
    v_dist := private.distance_m(p_lat, p_lng, v_loc.lat, v_loc.lng);
    v_score := private.score_for(v_dist);
    update public.game_rounds
       set guessed_at = now(), guess_lat = p_lat, guess_lng = p_lng, distance_m = v_dist, score = v_score
     where game_id = v_r.game_id and round_no = v_r.round_no;
  end if;

  update public.games
     set total_score = total_score + v_score,
         rounds_completed = rounds_completed + 1
   where id = v_game.id
   returning * into v_game;

  v_more := case
    when v_game.rounds_planned is not null then v_game.rounds_completed < v_game.rounds_planned
    else exists (select 1 from public.locations l
                  where l.active and not exists (select 1 from public.game_rounds r
                                                  where r.game_id = v_game.id and r.location_id = l.id))
  end;

  return jsonb_build_object(
    'round_no', v_r.round_no,
    'timed_out', v_timeout,
    'late', v_late and p_lat is not null,
    'distance_m', v_dist,
    'score', v_score,
    'answer', jsonb_build_object('lat', v_loc.lat, 'lng', v_loc.lng),
    'total_score', v_game.total_score,
    'rounds_completed', v_game.rounds_completed,
    'is_last', not v_more
  );
end;
$$;

-- ---------------------------------------------------------------------
-- RPC 4: next round (only after the current one is resolved)
-- ---------------------------------------------------------------------
create or replace function public.game_next_round(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games := private.lock_active_game(p_game_id);
  v_r public.game_rounds := private.current_round(p_game_id);
  v_round jsonb;
begin
  if v_r.guessed_at is null then
    raise exception 'round_in_progress' using errcode = 'P0001';
  end if;
  if v_game.rounds_planned is not null and v_game.rounds_completed >= v_game.rounds_planned then
    raise exception 'game_complete' using errcode = 'P0001';
  end if;
  v_round := private.issue_round(v_game, v_r.round_no + 1);
  if v_round is null then
    raise exception 'game_complete' using errcode = 'P0001';
  end if;
  return v_round;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC 5: finish. Complete fixed-length game -> finished; otherwise
-- abandoned. Unlimited: an unanswered current round is discarded (as in
-- the classic game's End Game) and the game finishes if >= 1 round counted.
-- ---------------------------------------------------------------------
create or replace function public.game_finish(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_game public.games := private.lock_active_game(p_game_id);
  v_status text;
begin
  delete from public.game_rounds where game_id = v_game.id and guessed_at is null;

  v_status := case
    when v_game.rounds_planned is not null and v_game.rounds_completed = v_game.rounds_planned then 'finished'
    when v_game.rounds_planned is null and v_game.rounds_completed >= 1 then 'finished'
    else 'abandoned'
  end;

  update public.games set status = v_status, finished_at = now() where id = v_game.id
  returning * into v_game;

  return jsonb_build_object(
    'game_id', v_game.id,
    'status', v_game.status,
    'is_ranked', v_game.is_ranked and v_game.status = 'finished',
    'total_score', v_game.total_score,
    'rounds_completed', v_game.rounds_completed,
    'rounds', private.round_summary(v_game.id)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges: helpers are owner-only; RPCs are for signed-in sessions only
-- ---------------------------------------------------------------------
revoke all on function private.time_limit_s(text)                       from public, anon, authenticated;
revoke all on function private.load_allowance()                         from public, anon, authenticated;
revoke all on function private.network_grace()                          from public, anon, authenticated;
revoke all on function private.distance_m(float8, float8, float8, float8) from public, anon, authenticated;
revoke all on function private.score_for(float8)                        from public, anon, authenticated;
revoke all on function private.lock_active_game(uuid)                   from public, anon, authenticated;
revoke all on function private.current_round(uuid)                      from public, anon, authenticated;
revoke all on function private.issue_round(public.games, int)           from public, anon, authenticated;
revoke all on function private.round_summary(uuid)                      from public, anon, authenticated;

revoke all on function public.game_start(text, int)                from public, anon;
revoke all on function public.game_start_round(uuid)               from public, anon;
revoke all on function public.game_submit(uuid, float8, float8)    from public, anon;
revoke all on function public.game_next_round(uuid)                from public, anon;
revoke all on function public.game_finish(uuid)                    from public, anon;

grant execute on function public.game_start(text, int)             to authenticated;
grant execute on function public.game_start_round(uuid)            to authenticated;
grant execute on function public.game_submit(uuid, float8, float8) to authenticated;
grant execute on function public.game_next_round(uuid)             to authenticated;
grant execute on function public.game_finish(uuid)                 to authenticated;
