-- Phase 4: ranking needs UM verification, UM verification rules, leaderboard, permissions
begin;
select plan(24);

select tests.as_admin();
create temp table ids as
select tests.create_user('ana@example.com') as ana,
       tests.create_user('ben@example.com') as ben,
       tests.create_user(null, true)        as guest;
grant select on ids to anon, authenticated;
insert into public.profiles (id, username) values ((select ana from ids), 'AnaBison'), ((select ben from ids), 'BenBison');
insert into public.locations (legacy_name, lat, lng) select 'P4_' || i, 49.808 + i * 0.0001, -97.133 from generate_series(1, 6) i;
create temp table kv (k text primary key, j jsonb);
grant all on kv to public;

-- ---------- Permissions ----------
select ok(not has_function_privilege('authenticated', 'public.um_start(uuid,text,text,text,int)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.um_start(uuid,text,text,text,int)', 'EXECUTE'),
  'browsers cannot call um_start (server secret key only)');
select ok(not has_function_privilege('authenticated', 'public.um_confirm(uuid,text)', 'EXECUTE'),
  'browsers cannot call um_confirm');
select ok(not has_function_privilege('authenticated', 'public.account_log_deletion(uuid)', 'EXECUTE'),
  'browsers cannot write the deletion log');
select tests.as_user((select ana from ids));
select throws_ok($$ select * from public.um_affiliations $$, '42501', null, 'users cannot read UM affiliations');
select throws_ok($$ select * from public.um_verification_requests $$, '42501', null, 'users cannot read pending UM codes');
select throws_ok($$ update public.profiles set is_um_verified = true, um_verified_at = now() where id = (select ana from ids) $$,
  '42501', null, 'users still cannot mark themselves verified');

-- ---------- Ranking requires UM verification ----------
insert into kv values ('g1', public.game_start('easy', 5));
select is((select (j->>'is_ranked')::boolean from kv where k = 'g1'), false, 'registered but unverified: not ranked');

-- ---------- Username availability ----------
select is(public.username_available('ab'), 'invalid', 'too-short name is invalid');
select is(public.username_available('Admin'), 'reserved', 'reserved names are reported');
select is(public.username_available('benbison'), 'taken', 'taken names are reported (any capitalization)');
select is(public.username_available('AnaBison'), 'ok', 'your own current name counts as available');

-- ---------- UM verification (as the server) ----------
select tests.as_admin();
select is(public.um_start((select guest from ids), 'h_guest', 'myumanitoba.ca', 'c', 1)->>'reason', 'not_eligible', 'guests cannot verify');
select is(public.um_start((select ana from ids), 'h_ana', 'gmail.com', 'c', 1)->>'reason', 'not_eligible', 'only UM domains');
select is(public.um_start((select ana from ids), 'h_ana', 'myumanitoba.ca', 'code_ok', 1)->>'ok', 'true', 'a code can be requested');
select is(public.um_confirm((select ana from ids), 'wrong')->>'reason', 'wrong_code', 'a wrong code is refused');
select is(public.um_confirm((select ana from ids), 'code_ok')->>'ok', 'true', 'the right code verifies');
select is((select is_um_verified from public.profiles where id = (select ana from ids)), true, 'profile is now UM-verified');

-- Same UM email on a second account
select is(public.um_start((select ben from ids), 'h_ana', 'myumanitoba.ca', 'code_b', 1)->>'ok', 'true', 'ben requests a code for the same address');
select is(public.um_confirm((select ben from ids), 'code_b')->>'reason', 'email_in_use', 'one UM email cannot verify two accounts');

-- Limits: 5 attempts, 15 minutes, 3 sends per hour
select public.um_start((select ben from ids), 'h_ben', 'umanitoba.ca', 'code_x', 1);  -- 2nd send this hour
select public.um_start((select ben from ids), 'h_ben', 'umanitoba.ca', 'code_c', 1);  -- 3rd send this hour
select public.um_confirm((select ben from ids), 'x') from generate_series(1, 5);
select is(public.um_confirm((select ben from ids), 'code_c')->>'reason', 'too_many_attempts', 'locked after 5 wrong attempts');
select is(public.um_start((select ben from ids), 'h_ben', 'umanitoba.ca', 'code_d', 1)->>'reason', 'rate_limited', 'at most 3 codes per hour');

-- ---------- Leaderboard ----------
select tests.as_user((select ana from ids));
insert into kv values ('g2', public.game_start('easy', 5));
select is((select (j->>'is_ranked')::boolean from kv where k = 'g2'), true, 'verified player: ranked');
select tests.as_admin();
update public.games set status = 'finished', finished_at = now(), rounds_completed = 5, total_score = 20000
 where id = (select (j->>'game_id')::uuid from kv where k = 'g2');
select tests.as_anon();
select is((select string_agg(username || ':' || score, ',') from public.leaderboard('easy', 5, 'week')), 'AnaBison:20000',
  'visitors see verified ranked players on the leaderboard');
select tests.as_admin();
update public.profiles set moderation_status = 'hidden' where id = (select ana from ids);
select tests.as_anon();
select is((select count(*)::int from public.leaderboard('easy', 5, 'all')), 0, 'hidden players disappear from the leaderboard');

select * from finish();
rollback;
