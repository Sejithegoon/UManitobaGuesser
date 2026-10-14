-- Account deletion: removing the auth user removes everything they own,
-- and nothing else. Locations used in history cannot be hard-deleted.
begin;
select plan(9);

select tests.as_admin();
create temp table ids as
select tests.create_user('a@example.com') as a, tests.create_user('b@example.com') as b;

insert into public.profiles (id, username) values ((select a from ids), 'LeavingSoon'), ((select b from ids), 'Staying');
insert into public.locations (legacy_name, lat, lng) values ('TEST_DEL', 49.8090, -97.1330);

create temp table fx as
with g as (
  insert into public.games (user_id, difficulty, rounds_planned, status, finished_at, rounds_completed, total_score)
  values ((select a from ids), 'easy', 5, 'finished', now(), 1, 4000) returning id
)
select (select id from g) as game_a;

insert into public.game_rounds (game_id, round_no, location_id, deadline_at, guess_lat, guess_lng, distance_m, score, guessed_at)
values ((select game_a from fx), 1, (select id from public.locations where legacy_name = 'TEST_DEL'),
        now() + interval '40 seconds', 49.8091, -97.1331, 13.4, 4000, now());

insert into public.games (user_id, difficulty, rounds_planned) values ((select b from ids), 'hard', 5);

-- A location that appears in someone's history cannot be deleted (deactivate instead)
select throws_ok($$ delete from public.locations where legacy_name = 'TEST_DEL' $$,
  '23001', null, 'a location used in game history cannot be hard-deleted (RESTRICT)');

-- Delete user A the way the Phase 4 deletion function will (auth admin delete)
delete from auth.users where id = (select a from ids);

select is((select count(*)::int from public.profiles where id = (select a from ids)), 0, 'profile removed with the account');
select is((select count(*)::int from public.games where user_id = (select a from ids)), 0, 'games removed with the account');
select is((select count(*)::int from public.game_rounds where game_id = (select game_a from fx)), 0, 'rounds removed with the account');
select is((select count(*)::int from public.locations where legacy_name = 'TEST_DEL'), 1, 'shared locations are kept');
select is((select count(*)::int from public.profiles where id = (select b from ids)), 1, 'other users'' profiles are untouched');
select is((select count(*)::int from public.games where user_id = (select b from ids)), 1, 'other users'' games are untouched');
select lives_ok($$ delete from public.locations where legacy_name = 'TEST_DEL' $$,
  'once no history references it, the location can be removed');

-- A profile cannot exist without an auth user
select throws_ok($$ insert into public.profiles (id, username) values (gen_random_uuid(), 'Orphan') $$,
  '23503', null, 'a profile must belong to a real auth user');

select * from finish();
rollback;
