-- games / game_rounds: no client writes, owner-only reads, integrity constraints
begin;
select plan(22);

select tests.as_admin();
create temp table ids as
select tests.create_user('a@example.com') as a,
       tests.create_user('b@example.com') as b,
       tests.create_user(null, true)      as guest;
grant select on ids to anon, authenticated;

insert into public.locations (legacy_name, lat, lng) values
  ('TEST_L1', 49.8090, -97.1330), ('TEST_L2', 49.8100, -97.1340);

create temp table fx as
with g as (
  insert into public.games (user_id, difficulty, rounds_planned, is_ranked)
  values ((select a from ids), 'easy', 5, true) returning id
)
select (select id from g) as game_a;
grant select on fx to anon, authenticated;

insert into public.game_rounds (game_id, round_no, location_id, deadline_at)
values ((select game_a from fx), 1, (select id from public.locations where legacy_name = 'TEST_L1'),
        now() + interval '40 seconds');

-- ---------- No direct writes from clients ----------
select tests.as_user((select a from ids));
select throws_ok($$ insert into public.games (user_id, difficulty, rounds_planned) values ((select a from ids), 'easy', 5) $$,
  '42501', null, 'clients cannot create games directly');
select throws_ok($$ update public.games set total_score = 25000 where id = (select game_a from fx) $$,
  '42501', null, 'clients cannot change a game score');
select throws_ok($$ update public.games set is_ranked = true, status = 'finished', finished_at = now() where id = (select game_a from fx) $$,
  '42501', null, 'clients cannot finish or rank a game');
select throws_ok($$ delete from public.games where id = (select game_a from fx) $$,
  '42501', null, 'clients cannot delete games');
select throws_ok($$ insert into public.game_rounds (game_id, round_no, location_id, deadline_at)
                    values ((select game_a from fx), 2, (select location_id from public.game_rounds limit 1), now() + interval '1 hour') $$,
  '42501', null, 'clients cannot create rounds');
select throws_ok($$ update public.game_rounds set score = 5000, distance_m = 0, guess_lat = 0, guess_lng = 0, guessed_at = now()
                    where game_id = (select game_a from fx) $$,
  '42501', null, 'clients cannot write a round result');
select throws_ok($$ update public.game_rounds set deadline_at = now() + interval '1 day' where game_id = (select game_a from fx) $$,
  '42501', null, 'clients cannot extend a deadline');

select tests.as_user((select guest from ids), true);
select throws_ok($$ insert into public.games (user_id, difficulty, rounds_planned) values ((select guest from ids), 'hard', 5) $$,
  '42501', null, 'guests cannot create games directly');

select tests.as_anon();
select throws_ok($$ select * from public.games $$, '42501', null, 'visitors without a session cannot read games');

-- ---------- Owner-only reads ----------
select tests.as_user((select a from ids));
select is((select count(*)::int from public.games), 1, 'a user sees their own game');
select is((select count(*)::int from public.game_rounds), 1, 'a user sees their own rounds');
select tests.as_user((select b from ids));
select is((select count(*)::int from public.games), 0, 'another user cannot see it');
select is((select count(*)::int from public.game_rounds), 0, 'another user cannot see its rounds');

-- ---------- One active game per user ----------
select tests.as_admin();
select throws_ok($$ insert into public.games (user_id, difficulty, rounds_planned) values ((select a from ids), 'hard', 10) $$,
  '23505', null, 'a second active game for the same user is rejected');
select lives_ok($$ insert into public.games (user_id, difficulty, rounds_planned) values ((select b from ids), 'hard', 10) $$,
  'other users can have their own active game');
update public.games set status = 'finished', finished_at = now() where id = (select game_a from fx);
select lives_ok($$ insert into public.games (user_id, difficulty, rounds_planned) values ((select a from ids), 'hard', 10) $$,
  'after finishing, the user can start a new game');

-- ---------- Integrity constraints ----------
select throws_ok($$ insert into public.games (user_id, difficulty, rounds_planned, status, finished_at, total_score, rounds_completed)
                    values ((select guest from ids), 'easy', 5, 'finished', now(), 5001, 1) $$,
  '23514', null, 'a score above 5,000 per completed round is impossible');
select throws_ok($$ insert into public.games (user_id, difficulty, rounds_planned, is_ranked) values ((select guest from ids), 'easy', null, true) $$,
  '23514', null, 'unlimited games can never be ranked');
select throws_ok($$ insert into public.games (user_id, difficulty, rounds_planned) values ((select guest from ids), 'expert', 5) $$,
  '23514', null, 'unknown difficulty is rejected');
select throws_ok($$ insert into public.game_rounds (game_id, round_no, location_id, issued_at, deadline_at)
                    values ((select game_a from fx), 2, (select id from public.locations where legacy_name = 'TEST_L2'), now(), now() - interval '1 second') $$,
  '23514', null, 'a deadline before the round was issued is rejected');
select throws_ok($$ insert into public.game_rounds (game_id, round_no, location_id, deadline_at)
                    values ((select game_a from fx), 2, (select id from public.locations where legacy_name = 'TEST_L1'), now() + interval '1 minute') $$,
  '23505', null, 'the same photo cannot appear twice in one game');
select throws_ok($$ update public.game_rounds set score = 4000 where game_id = (select game_a from fx) and round_no = 1 $$,
  '23514', null, 'a score without a guess, distance and time is rejected');

select * from finish();
rollback;
