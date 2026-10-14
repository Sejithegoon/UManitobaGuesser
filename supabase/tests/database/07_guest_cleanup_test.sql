-- Guest retention: only old, inactive guests are removed; registered users never
begin;
select plan(7);

select tests.as_admin();
create temp table ids as
select tests.create_user(null, true)            as old_idle_guest,
       tests.create_user(null, true)            as old_active_guest,
       tests.create_user(null, true)            as new_guest,
       tests.create_user('old@example.com')     as old_registered;
update auth.users set created_at = now() - interval '60 days'
 where id in ((select old_idle_guest from ids), (select old_active_guest from ids), (select old_registered from ids));

insert into public.games (user_id, difficulty, rounds_planned, status, finished_at, started_at)
values ((select old_idle_guest from ids),   'easy', 5, 'finished', now() - interval '45 days', now() - interval '45 days'),
       ((select old_active_guest from ids), 'easy', 5, 'finished', now() - interval '2 days',  now() - interval '2 days'),
       ((select old_registered from ids),   'easy', 5, 'finished', now() - interval '45 days', now() - interval '45 days');

select is(private.purge_inactive_guests(30), 1, 'exactly one guest is purged');
select is((select count(*)::int from auth.users where id = (select old_idle_guest from ids)), 0, 'an old guest with no recent games is deleted');
select is((select count(*)::int from public.games where user_id = (select old_idle_guest from ids)), 0, '...along with their games');
select is((select count(*)::int from auth.users where id = (select old_active_guest from ids)), 1, 'an old guest who played recently is kept');
select is((select count(*)::int from auth.users where id = (select new_guest from ids)), 1, 'a new guest is kept');
select is((select count(*)::int from auth.users where id = (select old_registered from ids)), 1, 'registered users are never purged');

select tests.as_user((select new_guest from ids), true);
select throws_ok($$ select private.purge_inactive_guests(30) $$, '42501', null, 'clients cannot run the purge');

select * from finish();
rollback;
