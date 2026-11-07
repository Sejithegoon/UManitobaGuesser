-- =====================================================================
-- UManitoba Guesser - Phase 5C: friend lobbies (live Party + Duels)
--
-- A host creates a lobby and shares its 6-letter code; up to 8 players join
-- with a nickname (guests too). Everyone gets the same photo at the same
-- moment. The server owns the clock, the answers and every score:
--   * a round ends when every connected player has guessed or time is up
--   * guesses and the answer are only revealed once the round has ended
--   * Party: highest total after N rounds wins
--   * Duels: everyone starts on 6,000 HP; each round you lose the gap to
--     the round's best score (x1, rising by 0.5 per round from round 5);
--     last player standing wins
-- There is no host-driven game loop: any member's lobby_state() call moves
-- the lobby along (resolve -> reveal -> next round), so nobody can stall it.
-- Clients poll lobby_state() and nudge each other over Realtime broadcast.
-- No table here is readable by clients; everything goes through the RPCs.
-- =====================================================================

create table public.lobbies (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  host_id         uuid not null references auth.users (id) on delete cascade,
  mode            text not null default 'party',
  difficulty      text not null default 'medium',
  rounds_planned  smallint not null default 5,     -- Party only; Duels runs until one player is left
  status          text not null default 'waiting',
  round_no        smallint not null default 0,
  next_seat       smallint not null default 1,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,

  -- No I, O, 0 or 1: easy to read out loud
  constraint lobbies_code_format check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  constraint lobbies_mode_valid check (mode in ('party', 'duels')),
  constraint lobbies_difficulty_valid check (difficulty in ('easy', 'medium', 'hard')),
  constraint lobbies_rounds_valid check (rounds_planned in (3, 5, 10)),
  constraint lobbies_status_valid check (status in ('waiting', 'playing', 'finished', 'closed'))
);

create table public.lobby_players (
  lobby_id     uuid not null references public.lobbies (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  seat         smallint not null,                 -- public id inside the lobby (user ids stay private)
  nickname     text not null,
  color        smallint not null,                 -- pin colour 0-7
  joined_at    timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  left_at      timestamptz,
  total_score  integer not null default 0,
  hp           integer not null default 6000,

  primary key (lobby_id, user_id),
  unique (lobby_id, seat),
  constraint lobby_players_nickname_format check (nickname ~ '^[A-Za-z0-9_][A-Za-z0-9_ ]{0,14}[A-Za-z0-9_]$'),
  constraint lobby_players_color_range check (color between 0 and 7),
  constraint lobby_players_hp_range check (hp between 0 and 6000),
  constraint lobby_players_score_nonnegative check (total_score >= 0)
);
create unique index lobby_players_nickname_key on public.lobby_players (lobby_id, lower(nickname));
create index lobby_players_user_idx on public.lobby_players (user_id);

create table public.lobby_rounds (
  lobby_id     uuid not null references public.lobbies (id) on delete cascade,
  round_no     smallint not null,
  location_id  uuid not null references public.locations (id) on delete restrict,
  starts_at    timestamptz not null,              -- after a short "get ready" countdown
  deadline_at  timestamptz not null,
  resolved_at  timestamptz,                       -- set when the answer is revealed
  multiplier   numeric(3, 1) not null default 1,  -- Duels damage multiplier

  primary key (lobby_id, round_no),
  unique (lobby_id, location_id),
  constraint lobby_rounds_deadline_after_start check (deadline_at > starts_at)
);

create table public.lobby_guesses (
  lobby_id    uuid not null,
  round_no    smallint not null,
  user_id     uuid not null,
  guess_lat   double precision,                   -- null = timed out
  guess_lng   double precision,
  distance_m  double precision,
  score       integer not null default 0,
  damage      integer not null default 0,
  guessed_at  timestamptz not null default now(),

  primary key (lobby_id, round_no, user_id),
  foreign key (lobby_id, round_no) references public.lobby_rounds (lobby_id, round_no) on delete cascade,
  foreign key (lobby_id, user_id) references public.lobby_players (lobby_id, user_id) on delete cascade,
  constraint lobby_guesses_pair check ((guess_lat is null) = (guess_lng is null)),
  constraint lobby_guesses_score_range check (score between 0 and 5000),
  constraint lobby_guesses_damage_nonnegative check (damage >= 0)
);

comment on table public.lobbies is 'Friend lobbies. No client access: lobby_* RPCs only.';
comment on table public.lobby_rounds is 'Lobby rounds, including which location (answer key). No client access.';

alter table public.lobbies       enable row level security;
alter table public.lobby_players enable row level security;
alter table public.lobby_rounds  enable row level security;
alter table public.lobby_guesses enable row level security;
revoke all on table public.lobbies       from anon, authenticated;
revoke all on table public.lobby_players from anon, authenticated;
revoke all on table public.lobby_rounds  from anon, authenticated;
revoke all on table public.lobby_guesses from anon, authenticated;

-- ---------------------------------------------------------------------
-- Helpers (not callable by clients)
-- ---------------------------------------------------------------------
create or replace function private.lobby_countdown() returns interval
language sql immutable set search_path = '' as $$ select interval '3 seconds' $$;

create or replace function private.lobby_reveal() returns interval
language sql immutable set search_path = '' as $$ select interval '9 seconds' $$;

-- A player counts as connected if their page polled recently
create or replace function private.lobby_connected_since() returns timestamptz
language sql stable set search_path = '' as $$ select now() - interval '15 seconds' $$;

create or replace function private.ms_until(p_at timestamptz) returns int
language sql stable set search_path = '' as $$
  select greatest(0, floor(extract(epoch from (p_at - now())) * 1000))::int
$$;

-- 6 characters from a 32-letter alphabet, using the crypto-random bytes of
-- gen_random_uuid() (bytes 0-5 are fully random; 256 % 32 = 0, so no bias)
create or replace function private.new_lobby_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  a constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea;
  c text;
begin
  loop
    b := uuid_send(gen_random_uuid());
    c := '';
    for i in 0..5 loop
      c := c || substr(a, 1 + (get_byte(b, i) % 32), 1);
    end loop;
    exit when not exists (select 1 from public.lobbies where code = c);
  end loop;
  return c;
end;
$$;

-- Trims and validates a nickname. Reserved names are refused, and so is a
-- registered player's username unless it's theirs (no impersonation).
create or replace function private.clean_nickname(p_nickname text, p_uid uuid)
returns text language plpgsql stable set search_path = '' as $$
declare v text := btrim(regexp_replace(coalesce(p_nickname, ''), '\s+', ' ', 'g'));
begin
  if v !~ '^[A-Za-z0-9_][A-Za-z0-9_ ]{0,14}[A-Za-z0-9_]$' then
    raise exception 'invalid_nickname' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.reserved_usernames r where r.name = lower(replace(v, ' ', ''))) then
    raise exception 'nickname_not_allowed' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles p where lower(p.username) = lower(v) and p.id <> p_uid) then
    raise exception 'nickname_taken' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

create or replace function private.check_lobby_settings(p_mode text, p_difficulty text, p_rounds int)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_mode is null or p_mode not in ('party', 'duels')
     or p_difficulty is null or p_difficulty not in ('easy', 'medium', 'hard')
     or p_rounds is null or p_rounds not in (3, 5, 10) then
    raise exception 'invalid_settings' using errcode = 'P0001';
  end if;
end;
$$;

-- A player is in one open lobby at a time
create or replace function private.leave_other_lobbies(p_uid uuid, p_keep uuid default null)
returns void language sql set search_path = '' as $$
  update public.lobby_players p set left_at = now()
    from public.lobbies l
   where l.id = p.lobby_id and p.user_id = p_uid and p.left_at is null
     and l.status in ('waiting', 'playing')
     and l.id is distinct from p_keep;
$$;

-- The lobby, locked, if the caller is a current member. Same error either
-- way, so lobby ids can't be probed.
create or replace function private.lobby_for_member(p_lobby uuid)
returns public.lobbies language plpgsql set search_path = '' as $$
declare l public.lobbies;
begin
  select * into l from public.lobbies where id = p_lobby for update;
  if not found or not exists (select 1 from public.lobby_players p
                               where p.lobby_id = p_lobby and p.user_id = auth.uid() and p.left_at is null) then
    raise exception 'lobby_not_found' using errcode = 'P0001';
  end if;
  return l;
end;
$$;

-- Next round: a random active location this lobby hasn't seen yet
create or replace function private.lobby_issue_round(p_lobby public.lobbies)
returns boolean language plpgsql set search_path = '' as $$
declare
  v_loc uuid;
  v_no smallint := p_lobby.round_no + 1;
  v_start timestamptz := now() + private.lobby_countdown();
begin
  select l.id into v_loc
    from public.locations l
   where l.active
     and not exists (select 1 from public.lobby_rounds r where r.lobby_id = p_lobby.id and r.location_id = l.id)
   order by random()
   limit 1;
  if not found then
    return false;
  end if;

  insert into public.lobby_rounds (lobby_id, round_no, location_id, starts_at, deadline_at, multiplier)
  values (p_lobby.id, v_no, v_loc, v_start,
          v_start + make_interval(secs => private.time_limit_s(p_lobby.difficulty)) + private.network_grace(),
          case when p_lobby.mode = 'duels' then greatest(1, 1 + 0.5 * (v_no - 4)) else 1 end);
  update public.lobbies set round_no = v_no where id = p_lobby.id;
  return true;
end;
$$;

-- End the current round: missing guesses score 0, totals and (Duels) HP update
create or replace function private.lobby_resolve(p_lobby public.lobbies)
returns void language plpgsql set search_path = '' as $$
declare
  v_r public.lobby_rounds;
  v_best int;
begin
  select * into v_r from public.lobby_rounds where lobby_id = p_lobby.id and round_no = p_lobby.round_no;

  insert into public.lobby_guesses (lobby_id, round_no, user_id, score)
  select p.lobby_id, v_r.round_no, p.user_id, 0
    from public.lobby_players p
   where p.lobby_id = p_lobby.id and p.left_at is null and (p_lobby.mode <> 'duels' or p.hp > 0)
  on conflict do nothing;

  update public.lobby_players p set total_score = p.total_score + g.score
    from public.lobby_guesses g
   where p.lobby_id = p_lobby.id and g.lobby_id = p.lobby_id and g.user_id = p.user_id and g.round_no = v_r.round_no;

  if p_lobby.mode = 'duels' then
    select max(g.score) into v_best from public.lobby_guesses g
     where g.lobby_id = p_lobby.id and g.round_no = v_r.round_no;
    update public.lobby_guesses g set damage = round((v_best - g.score) * v_r.multiplier)::int
     where g.lobby_id = p_lobby.id and g.round_no = v_r.round_no;
    update public.lobby_players p set hp = greatest(0, p.hp - g.damage)
      from public.lobby_guesses g
     where p.lobby_id = p_lobby.id and g.lobby_id = p.lobby_id and g.user_id = p.user_id and g.round_no = v_r.round_no;
  end if;

  update public.lobby_rounds set resolved_at = now()
   where lobby_id = p_lobby.id and round_no = v_r.round_no;
end;
$$;

create or replace function private.lobby_is_over(p_lobby public.lobbies)
returns boolean language sql stable set search_path = '' as $$
  select case
    when p_lobby.mode = 'party' then p_lobby.round_no >= p_lobby.rounds_planned
    else p_lobby.round_no >= 15
         or (select count(*) from public.lobby_players p
              where p.lobby_id = p_lobby.id and p.left_at is null and p.hp > 0) <= 1
  end
$$;

create or replace function private.lobby_finish(p_lobby public.lobbies)
returns void language plpgsql set search_path = '' as $$
begin
  update public.lobbies set status = 'finished', finished_at = now() where id = p_lobby.id;
  -- Each player who made at least one guess played a game
  perform private.bump_counter('games_played',
    (select count(*) from public.lobby_players p
      where p.lobby_id = p_lobby.id
        and exists (select 1 from public.lobby_guesses g
                     where g.lobby_id = p.lobby_id and g.user_id = p.user_id and g.guess_lat is not null)));
end;
$$;

-- Moves the lobby along. Called (with the lobby locked) by every member RPC.
create or replace function private.lobby_tick(p_lobby public.lobbies, p_skip boolean default false)
returns void language plpgsql set search_path = '' as $$
declare
  v_r public.lobby_rounds;
  v_host uuid;
begin
  if p_lobby.status not in ('waiting', 'playing') then
    return;
  end if;

  -- Everyone gone: close it
  if not exists (select 1 from public.lobby_players p where p.lobby_id = p_lobby.id and p.left_at is null) then
    update public.lobbies set status = 'closed', finished_at = now() where id = p_lobby.id;
    return;
  end if;

  -- Host left or went quiet: hand the role to the longest-standing connected player
  if not exists (select 1 from public.lobby_players p
                  where p.lobby_id = p_lobby.id and p.user_id = p_lobby.host_id
                    and p.left_at is null and p.last_seen > now() - interval '20 seconds') then
    select p.user_id into v_host from public.lobby_players p
     where p.lobby_id = p_lobby.id and p.left_at is null and p.last_seen > private.lobby_connected_since()
     order by p.joined_at
     limit 1;
    if v_host is not null then
      update public.lobbies set host_id = v_host where id = p_lobby.id;
    end if;
  end if;

  if p_lobby.status <> 'playing' then
    return;
  end if;

  select * into v_r from public.lobby_rounds where lobby_id = p_lobby.id and round_no = p_lobby.round_no;

  if v_r.resolved_at is null then
    if now() > v_r.deadline_at
       or (exists (select 1 from public.lobby_guesses g where g.lobby_id = p_lobby.id and g.round_no = v_r.round_no)
           and not exists (
             select 1 from public.lobby_players p
              where p.lobby_id = p_lobby.id and p.left_at is null
                and p.last_seen > private.lobby_connected_since()
                and (p_lobby.mode <> 'duels' or p.hp > 0)
                and not exists (select 1 from public.lobby_guesses g
                                 where g.lobby_id = p.lobby_id and g.round_no = v_r.round_no and g.user_id = p.user_id))) then
      perform private.lobby_resolve(p_lobby);
    end if;
    return;
  end if;

  -- Reveal shown long enough (or the host skipped it): next round, or done
  if p_skip or now() >= v_r.resolved_at + private.lobby_reveal() then
    if private.lobby_is_over(p_lobby) or not private.lobby_issue_round(p_lobby) then
      perform private.lobby_finish(p_lobby);
    end if;
  end if;
end;
$$;

-- Every guess of a resolved round (only ever called for resolved rounds)
create or replace function private.lobby_round_guesses(p_lobby uuid, p_round smallint)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'seat', p.seat, 'lat', g.guess_lat, 'lng', g.guess_lng,
           'distance_m', g.distance_m, 'score', g.score, 'damage', g.damage)
           order by g.score desc, p.seat), '[]'::jsonb)
    from public.lobby_guesses g
    join public.lobby_players p on p.lobby_id = g.lobby_id and p.user_id = g.user_id
   where g.lobby_id = p_lobby and g.round_no = p_round
$$;

-- What a member's screen needs. Times are sent as "ms from now" so client
-- clocks don't matter. Nothing about the answer until the round is resolved.
create or replace function private.lobby_state_json(p_lobby uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  l public.lobbies;
  r public.lobby_rounds;
  v_loc public.locations;
  v_round jsonb;
  v_history jsonb;
begin
  select * into l from public.lobbies where id = p_lobby;
  select * into r from public.lobby_rounds where lobby_id = p_lobby and round_no = l.round_no;

  if r.lobby_id is not null then
    select * into v_loc from public.locations where id = r.location_id;
    v_round := jsonb_build_object(
      'round_no', r.round_no,
      'photo', 'locations/p/' || v_loc.public_key || '.jpg',
      'multiplier', r.multiplier,
      'starts_in_ms', private.ms_until(r.starts_at),
      'remaining_ms', private.ms_until(r.deadline_at - private.network_grace()),
      'resolved', r.resolved_at is not null,
      'next_in_ms', case when r.resolved_at is not null then private.ms_until(r.resolved_at + private.lobby_reveal()) end,
      'my_guess', (select jsonb_build_object('lat', g.guess_lat, 'lng', g.guess_lng)
                     from public.lobby_guesses g
                    where g.lobby_id = p_lobby and g.round_no = r.round_no and g.user_id = v_me and g.guess_lat is not null),
      'answer', case when r.resolved_at is not null then jsonb_build_object('lat', v_loc.lat, 'lng', v_loc.lng) end,
      'guesses', case when r.resolved_at is not null then private.lobby_round_guesses(p_lobby, r.round_no) end
    );
  end if;

  if l.status = 'finished' then
    select jsonb_agg(jsonb_build_object(
             'round_no', lr.round_no,
             'answer', jsonb_build_object('lat', lo.lat, 'lng', lo.lng),
             'guesses', private.lobby_round_guesses(p_lobby, lr.round_no))
             order by lr.round_no)
      into v_history
      from public.lobby_rounds lr
      join public.locations lo on lo.id = lr.location_id
     where lr.lobby_id = p_lobby and lr.resolved_at is not null;
  end if;

  return jsonb_build_object(
    'lobby', jsonb_build_object(
      'id', l.id, 'code', l.code, 'mode', l.mode, 'difficulty', l.difficulty,
      'rounds_planned', l.rounds_planned, 'status', l.status, 'round_no', l.round_no,
      'time_limit_s', private.time_limit_s(l.difficulty), 'max_hp', 6000),
    'me', (select p.seat from public.lobby_players p where p.lobby_id = p_lobby and p.user_id = v_me),
    'is_host', l.host_id = v_me,
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'seat', p.seat, 'nickname', p.nickname, 'color', p.color,
                  'is_host', p.user_id = l.host_id,
                  'total_score', p.total_score, 'hp', p.hp,
                  'left', p.left_at is not null,
                  'away', p.left_at is null and p.last_seen <= private.lobby_connected_since(),
                  'guessed', exists (select 1 from public.lobby_guesses g
                                      where g.lobby_id = p_lobby and g.round_no = l.round_no and g.user_id = p.user_id))
                  order by p.seat), '[]'::jsonb)
                  from public.lobby_players p where p.lobby_id = p_lobby),
    'round', v_round,
    'history', v_history
  );
end;
$$;

-- ---------------------------------------------------------------------
-- RPCs (signed-in sessions, guests included)
-- ---------------------------------------------------------------------
create or replace function public.lobby_create(p_nickname text, p_mode text, p_difficulty text, p_rounds int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_nick text;
  v_lobby public.lobbies;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  v_nick := private.clean_nickname(p_nickname, v_uid);
  perform private.check_lobby_settings(p_mode, p_difficulty, p_rounds);
  if (select count(*) from public.lobby_players p
       where p.user_id = v_uid and p.seat = 1 and p.joined_at > now() - interval '1 hour') >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  perform private.leave_other_lobbies(v_uid);
  insert into public.lobbies (code, host_id, mode, difficulty, rounds_planned, next_seat)
  values (private.new_lobby_code(), v_uid, p_mode, p_difficulty, p_rounds, 2)
  returning * into v_lobby;
  insert into public.lobby_players (lobby_id, user_id, seat, nickname, color)
  values (v_lobby.id, v_uid, 1, v_nick, 0);

  return private.lobby_state_json(v_lobby.id);
end;
$$;

create or replace function public.lobby_join(p_code text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_lobby public.lobbies;
  v_me public.lobby_players;
  v_nick text;
  v_color smallint;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  select * into v_lobby from public.lobbies
   where code = upper(btrim(coalesce(p_code, ''))) and status in ('waiting', 'playing')
   for update;
  if not found then
    raise exception 'lobby_not_found' using errcode = 'P0001';
  end if;
  select * into v_me from public.lobby_players where lobby_id = v_lobby.id and user_id = v_uid;

  -- Already in (page refresh) or coming back to a game they were part of
  if v_me.user_id is not null and (v_me.left_at is null or v_lobby.status = 'playing') then
    perform private.leave_other_lobbies(v_uid, v_lobby.id);
    update public.lobby_players set left_at = null, last_seen = now()
     where lobby_id = v_lobby.id and user_id = v_uid;
    return private.lobby_state_json(v_lobby.id);
  end if;
  if v_lobby.status <> 'waiting' then
    raise exception 'lobby_started' using errcode = 'P0001';
  end if;

  v_nick := private.clean_nickname(p_nickname, v_uid);
  if (select count(*) from public.lobby_players where lobby_id = v_lobby.id and left_at is null) >= 8 then
    raise exception 'lobby_full' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.lobby_players
              where lobby_id = v_lobby.id and lower(nickname) = lower(v_nick) and user_id <> v_uid) then
    raise exception 'nickname_taken' using errcode = 'P0001';
  end if;
  select min(c.n) into v_color from generate_series(0, 7) as c(n)
   where not exists (select 1 from public.lobby_players p
                      where p.lobby_id = v_lobby.id and p.left_at is null and p.color = c.n);

  perform private.leave_other_lobbies(v_uid, v_lobby.id);
  if v_me.user_id is not null then
    update public.lobby_players set left_at = null, last_seen = now(), nickname = v_nick, color = v_color
     where lobby_id = v_lobby.id and user_id = v_uid;
  else
    insert into public.lobby_players (lobby_id, user_id, seat, nickname, color)
    values (v_lobby.id, v_uid, v_lobby.next_seat, v_nick, v_color);
    update public.lobbies set next_seat = next_seat + 1 where id = v_lobby.id;
  end if;
  return private.lobby_state_json(v_lobby.id);
end;
$$;

create or replace function public.lobby_state(p_lobby uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lobby public.lobbies := private.lobby_for_member(p_lobby);
begin
  update public.lobby_players set last_seen = now()
   where lobby_id = p_lobby and user_id = auth.uid();
  perform private.lobby_tick(v_lobby);
  return private.lobby_state_json(p_lobby);
end;
$$;

-- Host, while waiting
create or replace function public.lobby_settings(p_lobby uuid, p_mode text, p_difficulty text, p_rounds int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lobby public.lobbies := private.lobby_for_member(p_lobby);
begin
  if v_lobby.host_id <> auth.uid() then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_lobby.status <> 'waiting' then
    raise exception 'lobby_started' using errcode = 'P0001';
  end if;
  perform private.check_lobby_settings(p_mode, p_difficulty, p_rounds);
  update public.lobbies set mode = p_mode, difficulty = p_difficulty, rounds_planned = p_rounds
   where id = p_lobby;
  return private.lobby_state_json(p_lobby);
end;
$$;

create or replace function public.lobby_start(p_lobby uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lobby public.lobbies := private.lobby_for_member(p_lobby);
begin
  if v_lobby.host_id <> auth.uid() then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_lobby.status <> 'waiting' then
    raise exception 'lobby_started' using errcode = 'P0001';
  end if;
  if v_lobby.mode = 'duels'
     and (select count(*) from public.lobby_players where lobby_id = p_lobby and left_at is null) < 2 then
    raise exception 'need_two_players' using errcode = 'P0001';
  end if;

  update public.lobbies set status = 'playing', started_at = now(), round_no = 0
   where id = p_lobby
  returning * into v_lobby;
  if not private.lobby_issue_round(v_lobby) then
    raise exception 'not_enough_locations' using errcode = 'P0001';
  end if;
  return private.lobby_state_json(p_lobby);
end;
$$;

create or replace function public.lobby_guess(p_lobby uuid, p_lat float8, p_lng float8)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lobby public.lobbies := private.lobby_for_member(p_lobby);
  v_r public.lobby_rounds;
  v_me public.lobby_players;
  v_loc public.locations;
  v_dist float8;
begin
  if p_lat is null or p_lng is null
     or p_lat = 'NaN'::float8 or p_lng = 'NaN'::float8
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid_guess' using errcode = 'P0001';
  end if;

  -- An expired round is resolved first, so a late guess can't sneak in
  perform private.lobby_tick(v_lobby);
  select * into v_lobby from public.lobbies where id = p_lobby;
  select * into v_r from public.lobby_rounds where lobby_id = p_lobby and round_no = v_lobby.round_no;
  if v_lobby.status <> 'playing' or v_r.resolved_at is not null or now() > v_r.deadline_at then
    raise exception 'round_closed' using errcode = 'P0001';
  end if;
  if now() < v_r.starts_at then
    raise exception 'round_not_started' using errcode = 'P0001';
  end if;
  select * into v_me from public.lobby_players where lobby_id = p_lobby and user_id = auth.uid();
  if v_lobby.mode = 'duels' and v_me.hp <= 0 then
    raise exception 'eliminated' using errcode = 'P0001';
  end if;

  select * into v_loc from public.locations where id = v_r.location_id;
  v_dist := private.distance_m(p_lat, p_lng, v_loc.lat, v_loc.lng);
  insert into public.lobby_guesses (lobby_id, round_no, user_id, guess_lat, guess_lng, distance_m, score)
  values (p_lobby, v_r.round_no, auth.uid(), p_lat, p_lng, v_dist, private.score_for(v_dist))
  on conflict do nothing;
  if not found then
    raise exception 'already_guessed' using errcode = 'P0001';
  end if;

  update public.lobby_players set last_seen = now() where lobby_id = p_lobby and user_id = auth.uid();
  perform private.lobby_tick(v_lobby);   -- last one in? reveal now
  return private.lobby_state_json(p_lobby);
end;
$$;

-- Host: skip the rest of the reveal
create or replace function public.lobby_next(p_lobby uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lobby public.lobbies := private.lobby_for_member(p_lobby);
begin
  if v_lobby.host_id <> auth.uid() then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_lobby.status <> 'playing' or not exists (
       select 1 from public.lobby_rounds
        where lobby_id = p_lobby and round_no = v_lobby.round_no and resolved_at is not null) then
    raise exception 'round_in_progress' using errcode = 'P0001';
  end if;
  perform private.lobby_tick(v_lobby, true);
  return private.lobby_state_json(p_lobby);
end;
$$;

-- Host: back to the waiting room for another game with the same people
create or replace function public.lobby_reset(p_lobby uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lobby public.lobbies := private.lobby_for_member(p_lobby);
begin
  if v_lobby.host_id <> auth.uid() then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_lobby.status <> 'finished' then
    raise exception 'lobby_not_finished' using errcode = 'P0001';
  end if;
  delete from public.lobby_rounds where lobby_id = p_lobby;     -- guesses go with them
  delete from public.lobby_players where lobby_id = p_lobby and left_at is not null;
  update public.lobby_players set total_score = 0, hp = 6000 where lobby_id = p_lobby;
  update public.lobbies set status = 'waiting', round_no = 0, started_at = null, finished_at = null
   where id = p_lobby;
  return private.lobby_state_json(p_lobby);
end;
$$;

-- Host: remove a player (they can rejoin with the code)
create or replace function public.lobby_kick(p_lobby uuid, p_seat int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lobby public.lobbies := private.lobby_for_member(p_lobby);
begin
  if v_lobby.host_id <> auth.uid() then
    raise exception 'not_host' using errcode = 'P0001';
  end if;
  if v_lobby.status = 'waiting' then
    delete from public.lobby_players where lobby_id = p_lobby and seat = p_seat and user_id <> auth.uid();
  else
    update public.lobby_players set left_at = now()
     where lobby_id = p_lobby and seat = p_seat and user_id <> auth.uid() and left_at is null;
  end if;
  perform private.lobby_tick(v_lobby);
  return private.lobby_state_json(p_lobby);
end;
$$;

create or replace function public.lobby_leave(p_lobby uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lobby public.lobbies := private.lobby_for_member(p_lobby);
begin
  if v_lobby.status = 'waiting' then
    -- Free the seat, name and colour entirely
    delete from public.lobby_players where lobby_id = p_lobby and user_id = auth.uid();
  else
    update public.lobby_players set left_at = now() where lobby_id = p_lobby and user_id = auth.uid();
  end if;
  perform private.lobby_tick(v_lobby);
  return jsonb_build_object('left', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Retention: the daily guest purge also drops lobbies older than 2 days,
-- and a guest who played in a lobby recently counts as active.
-- Same function as 20261020000100 otherwise.
-- ---------------------------------------------------------------------
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

  delete from public.lobbies where created_at < now() - interval '2 days';

  with gone as (
    delete from auth.users u
     where u.is_anonymous
       and u.created_at < now() - make_interval(days => p_days)
       and not exists (
         select 1 from public.games g
          where g.user_id = u.id and g.started_at > now() - make_interval(days => p_days))
       and not exists (
         select 1 from public.lobby_players lp
          where lp.user_id = u.id and lp.last_seen > now() - make_interval(days => p_days))
    returning 1
  )
  select count(*) into n from gone;

  delete from private.deleted_accounts where deleted_at < now() - interval '35 days';
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke all on function private.lobby_countdown()                          from public, anon, authenticated;
revoke all on function private.lobby_reveal()                             from public, anon, authenticated;
revoke all on function private.lobby_connected_since()                    from public, anon, authenticated;
revoke all on function private.ms_until(timestamptz)                      from public, anon, authenticated;
revoke all on function private.new_lobby_code()                           from public, anon, authenticated;
revoke all on function private.clean_nickname(text, uuid)                 from public, anon, authenticated;
revoke all on function private.check_lobby_settings(text, text, int)      from public, anon, authenticated;
revoke all on function private.leave_other_lobbies(uuid, uuid)            from public, anon, authenticated;
revoke all on function private.lobby_for_member(uuid)                     from public, anon, authenticated;
revoke all on function private.lobby_issue_round(public.lobbies)          from public, anon, authenticated;
revoke all on function private.lobby_resolve(public.lobbies)              from public, anon, authenticated;
revoke all on function private.lobby_is_over(public.lobbies)              from public, anon, authenticated;
revoke all on function private.lobby_finish(public.lobbies)               from public, anon, authenticated;
revoke all on function private.lobby_tick(public.lobbies, boolean)        from public, anon, authenticated;
revoke all on function private.lobby_round_guesses(uuid, smallint)        from public, anon, authenticated;
revoke all on function private.lobby_state_json(uuid)                     from public, anon, authenticated;
revoke all on function private.purge_inactive_guests(int)                 from public, anon, authenticated;

revoke all on function public.lobby_create(text, text, text, int)         from public, anon;
revoke all on function public.lobby_join(text, text)                      from public, anon;
revoke all on function public.lobby_state(uuid)                           from public, anon;
revoke all on function public.lobby_settings(uuid, text, text, int)       from public, anon;
revoke all on function public.lobby_start(uuid)                           from public, anon;
revoke all on function public.lobby_guess(uuid, float8, float8)           from public, anon;
revoke all on function public.lobby_next(uuid)                            from public, anon;
revoke all on function public.lobby_reset(uuid)                           from public, anon;
revoke all on function public.lobby_kick(uuid, int)                       from public, anon;
revoke all on function public.lobby_leave(uuid)                           from public, anon;
grant execute on function public.lobby_create(text, text, text, int)      to authenticated;
grant execute on function public.lobby_join(text, text)                   to authenticated;
grant execute on function public.lobby_state(uuid)                        to authenticated;
grant execute on function public.lobby_settings(uuid, text, text, int)    to authenticated;
grant execute on function public.lobby_start(uuid)                        to authenticated;
grant execute on function public.lobby_guess(uuid, float8, float8)        to authenticated;
grant execute on function public.lobby_next(uuid)                         to authenticated;
grant execute on function public.lobby_reset(uuid)                        to authenticated;
grant execute on function public.lobby_kick(uuid, int)                    to authenticated;
grant execute on function public.lobby_leave(uuid)                        to authenticated;
