-- Phase 5: site counters, Daily Challenge, friend lobbies (Party + Duels).
-- One transaction, so now() is constant: timing cases move stored
-- timestamps relative to now(), as in 06_game_engine_test.sql.
begin;
select plan(55);

select tests.as_admin();
create temp table ids as
select tests.create_user('host@example.com')  as host,
       tests.create_user('ver@example.com')   as ver,
       tests.create_user(null, true)          as g1,
       tests.create_user(null, true)          as g2,
       tests.create_user(null, true)          as g3;
grant select on ids to anon, authenticated;
insert into public.profiles (id, username) values ((select host from ids), 'HostBison');
insert into public.profiles (id, username, is_um_verified, um_verified_at) values ((select ver from ids), 'DailyVerified', true, now());

insert into public.locations (legacy_name, lat, lng) values
  ('P5_A', 49.80850, -97.13404), ('P5_B', 49.80900, -97.13300), ('P5_C', 49.81000, -97.13500),
  ('P5_D', 49.80700, -97.13800), ('P5_E', 49.81100, -97.13100), ('P5_F', 49.80800, -97.13600);

create temp table kv (k text primary key, j jsonb);
grant all on kv to public;
create function pg_temp.lid(p_key text) returns uuid language sql as $$ select (j->'lobby'->>'id')::uuid from kv where k = p_key $$;
grant execute on function pg_temp.lid(text) to public;
-- Admin view: the answer for a lobby's current round
create function pg_temp.lobby_answer(p_lobby uuid) returns public.locations language sql as $$
  select l.* from public.locations l
    join public.lobby_rounds r on r.location_id = l.id
    join public.lobbies b on b.id = r.lobby_id and b.round_no = r.round_no
   where r.lobby_id = p_lobby $$;
-- Admin: remember the current answer in kv (players can't read locations)
create function pg_temp.stash_answer(p_lobby uuid) returns void language sql as $$
  insert into kv select 'ans', to_jsonb(a) from pg_temp.lobby_answer(p_lobby) a
  on conflict (k) do update set j = excluded.j $$;
create function pg_temp.ans(p text) returns float8 language sql as $$ select (j->>p)::float8 from kv where k = 'ans' $$;
grant execute on function pg_temp.ans(text) to public;
-- Admin: make the current round guessable now (skip the countdown)
create function pg_temp.open_round(p_lobby uuid) returns void language sql as $$
  update public.lobby_rounds r set starts_at = now() - interval '1 second'
    from public.lobbies b where b.id = r.lobby_id and b.round_no = r.round_no and r.lobby_id = p_lobby $$;
-- Admin: time's up on the current round
create function pg_temp.expire_round(p_lobby uuid) returns void language sql as $$
  update public.lobby_rounds r set starts_at = now() - interval '60 seconds', deadline_at = now() - interval '1 second'
    from public.lobbies b where b.id = r.lobby_id and b.round_no = r.round_no and r.lobby_id = p_lobby $$;

-- =====================================================================
-- Site counters
-- =====================================================================
create temp table c0 as select (select value from private.site_counters where key = 'visits') as visits,
                               (select value from private.site_counters where key = 'games_played') as played;
select tests.as_anon();
select lives_ok($$ select public.track_visit() $$, 'visitors can record a visit');
select tests.as_admin();
select is((select value from private.site_counters where key = 'visits'), (select visits + 1 from c0), 'a visit adds exactly one');
select ok((public.site_stats() ? 'total_visits') and (public.site_stats() ? 'games_played'), 'site stats include the all-time totals');
select tests.as_anon();
select throws_ok($$ select * from private.site_counters $$, '42501', null, 'visitors cannot read or change the counters directly');

-- =====================================================================
-- Daily Challenge
-- =====================================================================
select throws_ok($$ select public.daily_start() $$, '42501', null, 'visitors without a session cannot start the daily');
select ok((public.daily_status() ->> 'played')::boolean = false, 'visitors can see today''s daily status');

select tests.as_user((select g1 from ids), true);
insert into kv values ('d1', public.daily_start());
select is((select (j->>'daily_number')::int from kv where k = 'd1'), ((now() at time zone 'America/Winnipeg')::date - date '2026-11-06') + 1, 'the daily is numbered from launch day');
select is((select (j->>'rounds_planned')::int from kv where k = 'd1'), 5, 'a daily has 5 rounds');
select is((select j->>'is_ranked' from kv where k = 'd1'), 'false', 'daily games are never ranked');
select throws_ok($$ select public.daily_start() $$, 'P0001', 'daily_already_played', 'one daily attempt per player per day');

select tests.as_user((select ver from ids));
insert into kv values ('d2', public.daily_start());
select is((select j->'round'->>'photo' from kv where k = 'd2'), (select j->'round'->>'photo' from kv where k = 'd1'),
          'everyone gets the same first photo');
select is((select j->>'is_ranked' from kv where k = 'd2'), 'false', 'a UM-verified player''s daily is still unranked');

-- Play the verified player's daily to the end (as admin: answer each round perfectly)
select tests.as_admin();
do $$
declare v_game uuid := (select (j->>'game_id')::uuid from kv where k = 'd2'); v_loc public.locations; i int;
begin
  for i in 1..5 loop
    select l.* into v_loc from public.locations l join public.game_rounds r on r.location_id = l.id
     where r.game_id = v_game order by r.round_no desc limit 1;
    perform set_config('request.jwt.claims', json_build_object('sub', (select ver from ids), 'role', 'authenticated')::text, true);
    perform public.game_submit(v_game, v_loc.lat, v_loc.lng);
    if i < 5 then perform public.game_next_round(v_game); end if;
  end loop;
  perform public.game_finish(v_game);
end $$;
select is((select status from public.games where id = (select (j->>'game_id')::uuid from kv where k = 'd2')), 'finished', 'a daily plays through like a normal game');
select is((select value from private.site_counters where key = 'games_played'), (select played + 1 from c0), 'a finished game adds one to games played');

select tests.as_user((select ver from ids));
select is((public.daily_status() ->> 'my_score')::int, 25000, 'daily status shows my score');
select is((select count(*)::int from public.daily_leaderboard() where username = 'DailyVerified'), 1, 'registered players appear on the daily board');
select is((select count(*)::int from public.my_bests()), 0, 'daily games do not count as solo personal bests');
select throws_ok($$ select * from public.daily_challenges $$, '42501', null, 'clients cannot read the daily answer list');

-- =====================================================================
-- Lobbies: access + validation
-- =====================================================================
select tests.as_anon();
select throws_ok($$ select public.lobby_create('Anon', 'party', 'easy', 3) $$, '42501', null, 'visitors without a session cannot create a lobby');

select tests.as_user((select g1 from ids), true);
select throws_ok($$ select public.lobby_create('x', 'party', 'easy', 3) $$, 'P0001', 'invalid_nickname', 'too-short nickname is rejected');
select throws_ok($$ select public.lobby_create('<script>', 'party', 'easy', 3) $$, 'P0001', 'invalid_nickname', 'nicknames are letters, digits, _ and spaces');
select throws_ok($$ select public.lobby_create('hostbison', 'party', 'easy', 3) $$, 'P0001', 'nickname_taken', 'a guest cannot use a registered player''s username');
select throws_ok($$ select public.lobby_create('Guesty', 'battle', 'easy', 3) $$, 'P0001', 'invalid_settings', 'unknown mode is rejected');

-- =====================================================================
-- Party: create, join, play
-- =====================================================================
select tests.as_user((select host from ids));
insert into kv values ('p', public.lobby_create('HostBison', 'party', 'easy', 3));
select ok((select j->'lobby'->>'code' from kv where k = 'p') ~ '^[A-HJ-NP-Z2-9]{6}$', 'lobby code is 6 easy-to-read characters');
select is((select (j->>'is_host')::boolean from kv where k = 'p'), true, 'creator is the host');

select tests.as_user((select g1 from ids), true);
insert into kv values ('pj', public.lobby_join(lower((select j->'lobby'->>'code' from kv where k = 'p')), '  Guest   One '));
select is((select (j->>'me')::int from kv where k = 'pj'), 2, 'joining by code (any case) takes the next seat');
select is((select p->>'nickname' from kv, jsonb_array_elements(j->'players') p where k = 'pj' and (p->>'seat')::int = 2), 'Guest One', 'nickname spaces are tidied');
select is((select (p->>'color')::int from kv, jsonb_array_elements(j->'players') p where k = 'pj' and (p->>'seat')::int = 2), 1, 'each player gets their own pin colour');

select tests.as_user((select g2 from ids), true);
select throws_ok(format($$ select public.lobby_join(%L, 'guest one') $$, (select j->'lobby'->>'code' from kv where k = 'p')),
                 'P0001', 'nickname_taken', 'two players cannot share a nickname in a lobby');
select throws_ok(format($$ select public.lobby_state(%L) $$, pg_temp.lid('p')), 'P0001', 'lobby_not_found', 'non-members cannot see a lobby');
select throws_ok($$ select * from public.lobbies $$, '42501', null, 'clients cannot read lobby tables directly');
select throws_ok($$ select * from public.lobby_rounds $$, '42501', null, 'clients cannot read lobby rounds (answer key)');

select tests.as_user((select g1 from ids), true);
select throws_ok(format($$ select public.lobby_start(%L) $$, pg_temp.lid('p')), 'P0001', 'not_host', 'only the host can start');

select tests.as_user((select host from ids));
insert into kv values ('ps', public.lobby_start(pg_temp.lid('p')));
select is((select j->'lobby'->>'status' from kv where k = 'ps'), 'playing', 'host starts the game');
select ok((select (j->'round'->>'starts_in_ms')::int from kv where k = 'ps') > 0, 'rounds open after a short get-ready countdown');
select throws_ok(format($$ select public.lobby_guess(%L, 49.8, -97.13) $$, pg_temp.lid('p')), 'P0001', 'round_not_started', 'no guessing during the countdown');

select tests.as_admin();
select pg_temp.open_round(pg_temp.lid('p'));
select pg_temp.stash_answer(pg_temp.lid('p'));
select tests.as_user((select host from ids));
insert into kv values ('pg1', public.lobby_guess(pg_temp.lid('p'), pg_temp.ans('lat'), pg_temp.ans('lng')));
select ok((select j->'round'->'answer' = 'null'::jsonb and j->'round'->'guesses' = 'null'::jsonb from kv where k = 'pg1'),
          'answer and other guesses stay hidden until the round ends');
select is((select (p->>'total_score')::int from kv, jsonb_array_elements(j->'players') p where k = 'pg1' and (p->>'seat')::int = 1), 0,
          'scores are not shown mid-round');
select throws_ok(format($$ select public.lobby_guess(%L, 49.8, -97.13) $$, pg_temp.lid('p')), 'P0001', 'already_guessed', 'one guess per round');

select tests.as_user((select g1 from ids), true);
insert into kv values ('pg2', public.lobby_guess(pg_temp.lid('p'), 49.8000, -97.1400));
select is((select (j->'round'->>'resolved')::boolean from kv where k = 'pg2'), true, 'the round ends as soon as everyone has guessed');
select is((select jsonb_array_length(j->'round'->'guesses') from kv where k = 'pg2'), 2, 'then everyone''s guess is revealed');
select is((select (p->>'total_score')::int from kv, jsonb_array_elements(j->'players') p where k = 'pg2' and (p->>'seat')::int = 1), 5000,
          'a perfect guess scores 5,000');
select throws_ok(format($$ select public.lobby_next(%L) $$, pg_temp.lid('p')), 'P0001', 'not_host', 'only the host can skip the reveal');

select tests.as_user((select host from ids));
insert into kv values ('pn', public.lobby_next(pg_temp.lid('p')));
select is((select (j->'round'->>'round_no')::int from kv where k = 'pn'), 2, 'host skips ahead to round 2');

-- Round 2 times out for everyone; round 3 too; then the game is over
select tests.as_admin();
select pg_temp.expire_round(pg_temp.lid('p'));
select tests.as_user((select host from ids));
insert into kv values ('pt', public.lobby_state(pg_temp.lid('p')));
select ok((select (j->'round'->>'resolved')::boolean and (select bool_and((g->>'score')::int = 0) from jsonb_array_elements(j->'round'->'guesses') g) from kv where k = 'pt'),
          'when time runs out, missing guesses score 0');
select tests.as_admin();
create temp table c1 as select (select value from private.site_counters where key = 'games_played') as played;
select tests.as_user((select host from ids));
select public.lobby_next(pg_temp.lid('p'));
select tests.as_admin();
select pg_temp.expire_round(pg_temp.lid('p'));
select tests.as_user((select host from ids));
select public.lobby_state(pg_temp.lid('p'));
insert into kv values ('pf', public.lobby_next(pg_temp.lid('p')));
select is((select j->'lobby'->>'status' from kv where k = 'pf'), 'finished', 'party ends after the planned rounds');
select is((select jsonb_array_length(j->'history') from kv where k = 'pf'), 3, 'the final screen gets every round for the results map');
select tests.as_admin();
select is((select value from private.site_counters where key = 'games_played'), (select played + 2 from c1), 'each player who guessed counts as a game played');

select tests.as_user((select host from ids));
insert into kv values ('pr', public.lobby_reset(pg_temp.lid('p')));
select is((select j->'lobby'->>'status' from kv where k = 'pr'), 'waiting', 'host can bring everyone back for a rematch');

-- =====================================================================
-- Duels
-- =====================================================================
select tests.as_user((select g2 from ids), true);
insert into kv values ('d', public.lobby_create('Duelist', 'duels', 'easy', 5));
select throws_ok(format($$ select public.lobby_start(%L) $$, pg_temp.lid('d')), 'P0001', 'need_two_players', 'duels need at least two players');
select tests.as_user((select g3 from ids), true);
select public.lobby_join((select j->'lobby'->>'code' from kv where k = 'd'), 'Rival');
select tests.as_user((select g2 from ids), true);
select public.lobby_start(pg_temp.lid('d'));
select tests.as_admin();
select pg_temp.open_round(pg_temp.lid('d'));
select pg_temp.stash_answer(pg_temp.lid('d'));
select tests.as_user((select g2 from ids), true);
select public.lobby_guess(pg_temp.lid('d'), pg_temp.ans('lat'), pg_temp.ans('lng'));
select tests.as_admin();
select pg_temp.expire_round(pg_temp.lid('d'));
select tests.as_user((select g2 from ids), true);
insert into kv values ('dr', public.lobby_state(pg_temp.lid('d')));
select is((select (p->>'hp')::int from kv, jsonb_array_elements(j->'players') p where k = 'dr' and p->>'nickname' = 'Rival'), 1000,
          'the loser of a duel round loses the score gap as HP');
select is((select (p->>'hp')::int from kv, jsonb_array_elements(j->'players') p where k = 'dr' and p->>'nickname' = 'Duelist'), 6000,
          'the round winner keeps full HP');
select public.lobby_next(pg_temp.lid('d'));
select tests.as_admin();
select pg_temp.open_round(pg_temp.lid('d'));
select pg_temp.stash_answer(pg_temp.lid('d'));
select tests.as_user((select g2 from ids), true);
select public.lobby_guess(pg_temp.lid('d'), pg_temp.ans('lat'), pg_temp.ans('lng'));
select tests.as_admin();
select pg_temp.expire_round(pg_temp.lid('d'));
select tests.as_user((select g2 from ids), true);
select public.lobby_state(pg_temp.lid('d'));
insert into kv values ('df', public.lobby_next(pg_temp.lid('d')));
select is((select j->'lobby'->>'status' from kv where k = 'df'), 'finished', 'a duel ends when only one player has HP left');

-- Leaving hands over the host role
select tests.as_user((select g2 from ids), true);
insert into kv values ('h', public.lobby_create('HostTwo', 'party', 'easy', 5));
select tests.as_user((select g3 from ids), true);
select public.lobby_join((select j->'lobby'->>'code' from kv where k = 'h'), 'NextHost');
select tests.as_user((select g2 from ids), true);
select public.lobby_leave(pg_temp.lid('h'));
select tests.as_user((select g3 from ids), true);
select is((select (public.lobby_state(pg_temp.lid('h')) ->> 'is_host')::boolean), true, 'when the host leaves, another player becomes host');

-- Nothing in any lobby response names a location
select ok((select bool_and(j::text !~ 'P5_[A-F]|location_id|legacy_name') from kv where k <> 'ans'), 'lobby and daily responses never name a location');

select * from finish();
rollback;
