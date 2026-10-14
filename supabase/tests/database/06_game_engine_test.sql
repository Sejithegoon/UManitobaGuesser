-- Server-run game engine: authorization, ranking, timing policy v1,
-- answer secrecy, scoring parity with the browser, lifecycle, limits.
-- All of this runs inside one transaction, so now() is constant: timing
-- cases are built by moving stored timestamps relative to now().
begin;
select plan(40);

select tests.as_admin();
create temp table ids as
select tests.create_user('reg@example.com')   as reg,
       tests.create_user('noprof@example.com') as noprof,
       tests.create_user(null, true)           as guest;
grant select on ids to anon, authenticated;
insert into public.profiles (id, username, is_um_verified, um_verified_at) values ((select reg from ids), 'RankedBison', true, now());  -- ranked play needs UM verification (Phase 4)

insert into public.locations (legacy_name, lat, lng) values
  ('T_A', 49.80850, -97.13404), ('T_B', 49.80900, -97.13300), ('T_C', 49.81000, -97.13500),
  ('T_D', 49.80700, -97.13800), ('T_E', 49.81100, -97.13100), ('T_F', 49.80800, -97.13600);

-- Scratch space for RPC results (shared across role switches)
create temp table kv (k text primary key, j jsonb);
grant all on kv to public;

-- Admin view of "the answer for the current round of game X"
create function pg_temp.answer(p_game uuid) returns public.locations language sql as $$
  select l.* from public.locations l
  join public.game_rounds r on r.location_id = l.id
  where r.game_id = p_game order by r.round_no desc limit 1 $$;
create function pg_temp.gid(p_key text) returns uuid language sql as $$ select (j->>'game_id')::uuid from kv where k = p_key $$;
grant execute on function pg_temp.gid(text) to public;

-- ---------- Authorization & input validation ----------
select tests.as_anon();
select throws_ok($$ select public.game_start('easy', 5) $$, '42501', null, 'visitors without a session cannot start a game');
select throws_ok($$ select public.game_submit(gen_random_uuid(), 49.8, -97.1) $$, '42501', null, 'visitors cannot submit guesses');

select tests.as_user((select guest from ids), true);
select throws_ok($$ select public.game_start('expert', 5) $$, 'P0001', 'invalid_difficulty', 'unknown difficulty is rejected');
select throws_ok($$ select public.game_start('easy', 7) $$, 'P0001', 'invalid_rounds', 'unsupported round count is rejected');

-- ---------- Starting games, ranking ----------
insert into kv values ('guest', public.game_start('easy', 5));
select is((select (j->>'is_ranked')::boolean from kv where k = 'guest'), false, 'guest games are never ranked');
select ok((select j->'round'->>'photo' like 'locations/p/%.jpg' from kv where k = 'guest'), 'round 1 comes with an opaque photo path');
select ok((select j::text !~ '"(lat|lng|legacy_name)"' from kv where k = 'guest'), 'starting a game reveals no coordinates or location names');

select tests.as_user((select noprof from ids));
insert into kv values ('noprof', public.game_start('easy', 5));
select is((select (j->>'is_ranked')::boolean from kv where k = 'noprof'), false, 'registered users without a profile are not ranked');

select tests.as_user((select reg from ids));
insert into kv values ('reg_unl', public.game_start('easy', null));
select is((select (j->>'is_ranked')::boolean from kv where k = 'reg_unl'), false, 'unlimited games are never ranked');
insert into kv values ('reg', public.game_start('easy', 5));
select is((select (j->>'is_ranked')::boolean from kv where k = 'reg'), true, 'a registered, UM-verified player with a profile gets a ranked game');

select tests.as_admin();
select is((select status from public.games where id = pg_temp.gid('reg_unl')), 'abandoned',
  'starting a new game abandons the previous active one');
select is((select count(*)::int from public.games where user_id = (select reg from ids) and status = 'active'), 1,
  'still exactly one active game');

-- ---------- Ownership ----------
select tests.as_user((select guest from ids), true);
select throws_ok($$ select public.game_start_round(pg_temp.gid('reg')) $$, 'P0001', 'game_not_found', 'cannot touch another player''s game');
select throws_ok($$ select public.game_submit(pg_temp.gid('reg'), 49.8085, -97.13404) $$, 'P0001', 'game_not_found', 'cannot guess in another player''s game');

-- ---------- Timing policy v1 ----------
select tests.as_admin();
select is((select deadline_at - issued_at from public.game_rounds where game_id = pg_temp.gid('reg') and round_no = 1),
  interval '40 seconds', 'provisional deadline = issue + 8 s load allowance + 30 s + 2 s grace');

select tests.as_user((select reg from ids));
insert into kv values ('s1', public.game_start_round(pg_temp.gid('reg')));
select is((select (j->>'remaining_ms')::int from kv where k = 's1'), 30000, 'photo loaded promptly: the full 30 s is shown');
select tests.as_admin();
select is((select deadline_at - now() from public.game_rounds where game_id = pg_temp.gid('reg') and round_no = 1),
  interval '32 seconds', 'server deadline = start + 30 s + 2 s grace');
select tests.as_user((select reg from ids));
select public.game_start_round(pg_temp.gid('reg'));
select tests.as_admin();
select is((select deadline_at - now() from public.game_rounds where game_id = pg_temp.gid('reg') and round_no = 1),
  interval '32 seconds', 'calling start again does not extend the deadline');

-- Exact guess -> 5000, answer revealed only now (the admin looks it up;
-- the player could not - see 03_locations_test.sql)
select tests.as_admin();
insert into kv select 'ans1', to_jsonb(pg_temp.answer(pg_temp.gid('reg')));
select tests.as_user((select reg from ids));
insert into kv values ('sub1', public.game_submit(pg_temp.gid('reg'),
  (select (j->>'lat')::float8 from kv where k = 'ans1'), (select (j->>'lng')::float8 from kv where k = 'ans1')));
select is((select (j->>'score')::int from kv where k = 'sub1'), 5000, 'an exact guess scores 5,000');
select ok((select (s.j->'answer'->>'lat')::float8 = (a.j->>'lat')::float8 and (s.j->'answer'->>'lng')::float8 = (a.j->>'lng')::float8
             from kv s, kv a where s.k = 'sub1' and a.k = 'ans1'), 'the true answer is revealed after guessing');
select throws_ok($$ select public.game_submit(pg_temp.gid('reg'), 49.8, -97.1) $$, 'P0001', 'round_already_resolved',
  'a second guess for the same round is rejected');
select tests.as_admin();
select is((select total_score from public.games where id = pg_temp.gid('reg')),
  (select (j->>'score')::int from kv where k = 'sub1'), 'the stored total equals the server-computed score');

-- Round 2: photo loaded slowly (20 s after issue) -> clock started at issue + 8 s
select tests.as_user((select reg from ids));
select public.game_next_round(pg_temp.gid('reg'));
select throws_ok($$ select public.game_next_round(pg_temp.gid('reg')) $$, 'P0001', 'round_in_progress',
  'cannot skip ahead while a round is open');
select tests.as_admin();
update public.game_rounds set issued_at = now() - interval '20 seconds', deadline_at = now() + interval '20 seconds'
 where game_id = pg_temp.gid('reg') and round_no = 2;
select tests.as_user((select reg from ids));
insert into kv values ('s2', public.game_start_round(pg_temp.gid('reg')));
select is((select (j->>'remaining_ms')::int from kv where k = 's2'), 18000,
  'slow load: the clock started at issue + 8 s, so 30 - 12 = 18 s remain (no free study time)');

-- Late arrival (1 ms past the deadline) -> timeout, 0 points
select tests.as_admin();
update public.game_rounds set deadline_at = now() - interval '1 millisecond'
 where game_id = pg_temp.gid('reg') and round_no = 2;
insert into kv select 'ans2', to_jsonb(pg_temp.answer(pg_temp.gid('reg')));
select tests.as_user((select reg from ids));
insert into kv values ('sub2', public.game_submit(pg_temp.gid('reg'),
  (select (j->>'lat')::float8 from kv where k = 'ans2'), (select (j->>'lng')::float8 from kv where k = 'ans2')));
select ok((select (j->>'timed_out')::boolean and (j->>'late')::boolean and (j->>'score')::int = 0 from kv where k = 'sub2'),
  'a guess arriving after the deadline is a timeout worth 0, even if it was perfect');

-- Round 3: arrives 1 s after the displayed 0 (inside the 2 s grace) -> accepted
select public.game_next_round(pg_temp.gid('reg'));
select tests.as_admin();
update public.game_rounds set issued_at = now() - interval '40 seconds', started_at = now() - interval '31 seconds',
       deadline_at = now() + interval '1 second'
 where game_id = pg_temp.gid('reg') and round_no = 3;
select tests.as_user((select reg from ids));
insert into kv values ('sub3', public.game_submit(pg_temp.gid('reg'), 49.8095, -97.1335));
select is((select (j->>'timed_out')::boolean from kv where k = 'sub3'), false, 'a guess inside the network grace is accepted');

-- Round 4: no guess (timer ran out on the client)
select public.game_next_round(pg_temp.gid('reg'));
insert into kv values ('sub4', public.game_submit(pg_temp.gid('reg'), null, null));
select ok((select (j->>'timed_out')::boolean and (j->>'score')::int = 0 and j->'answer' is not null from kv where k = 'sub4'),
  'running out of time scores 0 and reveals the answer');

-- Round 5: bad input
select public.game_next_round(pg_temp.gid('reg'));
select throws_ok($$ select public.game_submit(pg_temp.gid('reg'), 200, -97.1) $$, 'P0001', 'invalid_guess', 'out-of-range coordinates are rejected');
select throws_ok($$ select public.game_submit(pg_temp.gid('reg'), 49.8, null) $$, 'P0001', 'invalid_guess', 'half a coordinate is rejected');
insert into kv values ('sub5', public.game_submit(pg_temp.gid('reg'), 49.8090, -97.1330));
select is((select (j->>'is_last')::boolean from kv where k = 'sub5'), true, 'the 5th round is flagged as the last');
select throws_ok($$ select public.game_next_round(pg_temp.gid('reg')) $$, 'P0001', 'game_complete', 'no 6th round in a 5-round game');

-- Finish
insert into kv values ('fin', public.game_finish(pg_temp.gid('reg')));
select ok((select j->>'status' = 'finished' and (j->>'is_ranked')::boolean and jsonb_array_length(j->'rounds') = 5 from kv where k = 'fin'),
  'a complete game finishes ranked with 5 rounds');
select tests.as_admin();
select is((select total_score from public.games where id = pg_temp.gid('reg')),
  (select sum(score)::int from public.game_rounds where game_id = pg_temp.gid('reg')), 'final total = sum of round scores');
select tests.as_user((select reg from ids));
select throws_ok($$ select public.game_submit(pg_temp.gid('reg'), 49.8, -97.1) $$, 'P0001', 'game_not_found', 'a finished game accepts nothing');

-- Unlimited: End Game discards the open round
select tests.as_user((select guest from ids), true);
insert into kv values ('g_unl', public.game_start('hard', null));
select public.game_submit(pg_temp.gid('g_unl'), 49.8, -97.13);
select public.game_next_round(pg_temp.gid('g_unl'));
insert into kv values ('g_unl_fin', public.game_finish(pg_temp.gid('g_unl')));
select ok((select j->>'status' = 'finished' and (j->>'rounds_completed')::int = 1 from kv where k = 'g_unl_fin'),
  'ending an unlimited game keeps answered rounds and drops the open one');

-- A fixed-length game ended early is abandoned (never ranked)
insert into kv values ('g_early', public.game_start('easy', 5));
insert into kv values ('g_early_fin', public.game_finish(pg_temp.gid('g_early')));
select is((select j->>'status' from kv where k = 'g_early_fin'), 'abandoned', 'quitting a 5-round game early abandons it');

-- ---------- Rate limit ----------
select tests.as_admin();
insert into public.games (user_id, difficulty, rounds_planned, status, finished_at)
select (select guest from ids), 'easy', 5, 'abandoned', now() from generate_series(1, 30);
select tests.as_user((select guest from ids), true);
select throws_ok($$ select public.game_start('easy', 5) $$, 'P0001', 'rate_limited', 'more than 30 game starts per hour is refused');

-- ---------- Scoring parity with the browser (values from static/game.js + Leaflet) ----------
select tests.as_admin();
select is(
  (select array_agg(private.score_for(d) order by ord)
     from unnest(array[0, 10, 30, 100, 123.456, 200, 600, 1000, 2500]::float8[]) with ordinality as t(d, ord)),
  array[5000, 5000, 4524, 3188, 2835, 1934, 262, 35, 0],
  'score curve matches the browser exactly (including Math.round behaviour)');
select ok(abs(private.distance_m(49.8085, -97.13404, 49.8090, -97.1330) - 93.062156) < 1e-5
      and abs(private.distance_m(49.80685, -97.13856, 49.8117, -97.13017) - 808.270970) < 1e-5,
  'distance matches Leaflet map.distance() to the micrometre');

-- ---------- Interface hygiene ----------
select is((select pronargs::int from pg_proc where oid = 'public.game_submit(uuid, float8, float8)'::regprocedure), 3,
  'game_submit takes only the game and a guess: no client time, distance or score');

select * from finish();
rollback;
