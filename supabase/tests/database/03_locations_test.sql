-- locations (answer key) and other admin-only tables are unreachable by clients
begin;
select plan(13);

select tests.as_admin();
insert into public.locations (legacy_name, lat, lng) values ('TEST_SECRET', 49.8090, -97.1330);
create temp table ids as
select tests.create_user('a@example.com') as a, tests.create_user(null, true) as guest;
grant select on ids to anon, authenticated;

-- Structural checks
select ok((select relrowsecurity from pg_class where oid = 'public.locations'::regclass),
  'RLS is enabled on locations');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'locations'), 0,
  'locations has no RLS policies (so no row is ever visible to clients)');
select ok(not has_table_privilege('anon', 'public.locations', 'SELECT'), 'anon has no SELECT grant on locations');
select ok(not has_table_privilege('authenticated', 'public.locations', 'SELECT'), 'authenticated has no SELECT grant on locations');
select ok(not has_column_privilege('authenticated', 'public.locations', 'lat', 'SELECT'), 'no column-level grant on coordinates either');

-- Behaviour as real clients
select tests.as_anon();
select throws_ok($$ select lat, lng from public.locations $$, '42501', null, 'visitors cannot read coordinates');

select tests.as_user((select a from ids));
select throws_ok($$ select lat, lng from public.locations $$, '42501', null, 'signed-in users cannot read coordinates');
select throws_ok($$ select count(*) from public.locations $$, '42501', null, 'signed-in users cannot even count locations');
select throws_ok($$ update public.locations set lat = 0 $$, '42501', null, 'signed-in users cannot edit locations');
select throws_ok($$ insert into public.locations (legacy_name, lat, lng) values ('X', 1, 1) $$, '42501', null, 'signed-in users cannot add locations');

select tests.as_user((select guest from ids), true);
select throws_ok($$ select lat, lng from public.locations $$, '42501', null, 'guests cannot read coordinates');

-- Reserved-name list is admin-only too
select tests.as_anon();
select throws_ok($$ select * from public.reserved_usernames $$, '42501', null, 'visitors cannot read the reserved-name list');
select tests.as_user((select a from ids));
select throws_ok($$ insert into public.reserved_usernames (name) values ('mine') $$, '42501', null, 'users cannot edit the reserved-name list');

select * from finish();
rollback;
