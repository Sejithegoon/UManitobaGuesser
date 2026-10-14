-- Public stats are counts only and readable by visitors
begin;
select plan(3);
select tests.as_admin();
create temp table ids as select tests.create_user('s1@example.com') as a, tests.create_user('s2@example.com') as b;
insert into public.profiles (id, username, is_um_verified, um_verified_at) values ((select a from ids), 'StatsOne', true, now());
insert into public.profiles (id, username) values ((select b from ids), 'StatsTwo');
update public.profiles set moderation_status = 'banned' where id = (select b from ids);
select tests.as_anon();
select ok((public.site_stats() ? 'registered_players') and (public.site_stats() ? 'games_today'), 'visitors can read site stats');
select is((public.site_stats()->>'verified_players')::int >= 1, true, 'verified players are counted');
select ok(public.site_stats()::text !~ '(StatsOne|@)', 'stats reveal no names or emails');
select * from finish();
rollback;
