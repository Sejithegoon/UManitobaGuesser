-- =====================================================================
-- UManitoba Guesser 2.0 - Phase 2: core schema
--
-- Tables only. Access control (RLS, grants) is in the next migration so
-- the security rules can be reviewed on their own.
--
-- Identity: every user-owned row points at auth.users (Supabase Auth).
-- Guests are Supabase *anonymous* users, so they can own games too, but
-- they never get a profile and never appear on a leaderboard.
-- =====================================================================

-- Internal schema for helpers that must never be reachable through the
-- Data API (only `public` / `graphql_public` are exposed by Supabase).
create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- Shared trigger: keep updated_at current
-- ---------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- reserved_usernames: names nobody can register (checked case-insensitively)
-- ---------------------------------------------------------------------
create table public.reserved_usernames (
  name        text primary key,
  reason      text not null default 'reserved',
  created_at  timestamptz not null default now(),
  constraint reserved_usernames_lowercase check (name = lower(name))
);

comment on table public.reserved_usernames is
  'Usernames that cannot be registered (staff/official/system words). Managed by admins only.';

-- ---------------------------------------------------------------------
-- profiles: public identity for registered (non-guest) users
-- ---------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  username           text not null,
  -- University affiliation. Only trusted server code may change these.
  is_um_verified     boolean not null default false,
  um_verified_at     timestamptz,
  -- Moderation. Only trusted server code / admins may change these.
  role               text not null default 'player',
  moderation_status  text not null default 'active',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 3-20 characters: letters, digits, underscore
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  constraint profiles_role_valid check (role in ('player', 'moderator', 'admin')),
  constraint profiles_moderation_valid check (moderation_status in ('active', 'hidden', 'banned')),
  constraint profiles_verified_consistent check (is_um_verified = (um_verified_at is not null))
);

-- Case-insensitive uniqueness ("Bison" and "bison" are the same name)
create unique index profiles_username_lower_key on public.profiles (lower(username));

comment on table public.profiles is
  'One row per registered user. No email or other private data: that stays in auth.users.';
comment on column public.profiles.is_um_verified is
  'Set only by the trusted UM-email verification flow (Phase 4). Clients cannot write it.';
comment on column public.profiles.moderation_status is
  'active = normal, hidden = removed from public lists, banned = hidden and excluded from ranking.';

-- Reserved-name check. SECURITY DEFINER so it can read reserved_usernames,
-- which ordinary clients have no access to. It only ever raises or passes;
-- it cannot be called directly (trigger functions are not callable via SQL).
create or replace function private.enforce_username_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.reserved_usernames r where r.name = lower(new.username)) then
    raise exception 'username "%" is reserved', new.username
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger profiles_username_rules
  before insert or update of username on public.profiles
  for each row execute function private.enforce_username_rules();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- locations: the answer key. Never readable by ordinary clients.
-- ---------------------------------------------------------------------
create table public.locations (
  id           uuid primary key default gen_random_uuid(),
  -- Name used in the current public game (e.g. 'GYM1'). Server-only; used
  -- for idempotent imports and to map photos during the Phase 3 switch.
  legacy_name  text not null unique,
  -- Opaque key that will become the public photo filename in Phase 3, so
  -- the photo URL no longer names the building.
  public_key   text not null unique default replace(gen_random_uuid()::text, '-', ''),
  lat          double precision not null,
  lng          double precision not null,
  campus       text not null default 'fort_garry',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint locations_legacy_name_format check (legacy_name ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint locations_lat_range check (lat between -90 and 90),
  constraint locations_lng_range check (lng between -180 and 180),
  constraint locations_campus_valid check (campus in ('fort_garry', 'bannatyne'))
);

comment on table public.locations is
  'Answer key (photo -> coordinates). RLS on, no policies, no grants: only trusted DB functions read it.';

create index locations_active_idx on public.locations (active) where active;

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- games: one played game. Written only by trusted game functions (Phase 3).
-- ---------------------------------------------------------------------
create table public.games (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  difficulty             text not null,
  rounds_planned         smallint,             -- 5 / 10 / 20, null = unlimited
  is_ranked              boolean not null default false,
  status                 text not null default 'active',
  total_score            integer not null default 0,
  rounds_completed       smallint not null default 0,
  timing_policy_version  smallint not null default 1,
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,

  constraint games_difficulty_valid check (difficulty in ('easy', 'medium', 'hard')),
  constraint games_rounds_valid check (rounds_planned is null or rounds_planned in (5, 10, 20)),
  constraint games_status_valid check (status in ('active', 'finished', 'abandoned')),
  constraint games_finished_consistent check ((status = 'active') = (finished_at is null)),
  constraint games_score_nonnegative check (total_score >= 0),
  constraint games_score_ceiling check (total_score <= rounds_completed * 5000),
  constraint games_rounds_completed_valid check (
    rounds_completed >= 0 and (rounds_planned is null or rounds_completed <= rounds_planned)
  ),
  -- Unlimited games are never ranked
  constraint games_unlimited_unranked check (rounds_planned is not null or not is_ranked)
);

comment on table public.games is
  'One row per game. Scores are authoritative: only trusted game functions write them.';

-- At most one active game per user (guest or registered)
create unique index games_one_active_per_user on public.games (user_id) where status = 'active';
-- "My recent games"
create index games_user_started_idx on public.games (user_id, started_at desc);
-- Future leaderboard lookups
create index games_leaderboard_idx on public.games (difficulty, rounds_planned, total_score desc)
  where status = 'finished' and is_ranked;

-- ---------------------------------------------------------------------
-- game_rounds: one round of a game. Written only by trusted game functions.
-- ---------------------------------------------------------------------
create table public.game_rounds (
  game_id      uuid not null references public.games (id) on delete cascade,
  round_no     smallint not null,
  -- RESTRICT: a location used in history cannot be deleted; deactivate it instead.
  location_id  uuid not null references public.locations (id) on delete restrict,
  issued_at    timestamptz not null default now(),
  deadline_at  timestamptz not null,
  guess_lat    double precision,
  guess_lng    double precision,
  distance_m   double precision,
  score        integer,
  guessed_at   timestamptz,
  timed_out    boolean not null default false,

  primary key (game_id, round_no),
  constraint game_rounds_round_no_valid check (round_no >= 1),
  constraint game_rounds_deadline_after_issue check (deadline_at > issued_at),
  constraint game_rounds_score_range check (score is null or score between 0 and 5000),
  constraint game_rounds_distance_valid check (distance_m is null or distance_m >= 0),
  constraint game_rounds_guess_pair check ((guess_lat is null) = (guess_lng is null)),
  -- A resolved round is either a timeout (no guess) or a guess with distance + score
  constraint game_rounds_resolution_consistent check (
    (guessed_at is null and score is null and not timed_out and guess_lat is null)
    or (guessed_at is not null and timed_out and guess_lat is null and score = 0)
    or (guessed_at is not null and not timed_out and guess_lat is not null
        and distance_m is not null and score is not null)
  ),
  -- The same photo never appears twice in one game
  constraint game_rounds_unique_location unique (game_id, location_id)
);

comment on table public.game_rounds is
  'Rounds of a game, including the server-set deadline. Clients may read their own rows, never write.';

create index game_rounds_location_idx on public.game_rounds (location_id);
