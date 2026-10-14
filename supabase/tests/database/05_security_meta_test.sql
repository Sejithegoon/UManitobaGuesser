-- Schema-wide security invariants (guards against future migrations
-- accidentally opening something up)
begin;
select plan(7);

select is(
  (select coalesce(string_agg(c.relname, ', '), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  '', 'every table in public has row-level security enabled');

select is(
  (select coalesce(string_agg(p.proname, ', '), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname in ('public', 'private')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')),
  '', 'every SECURITY DEFINER function pins its search_path');

select is(
  (select coalesce(string_agg(p.proname, ', '), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  '', 'no client role can execute a privileged (SECURITY DEFINER) helper');

select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'visitors cannot use the private schema');

select is(
  (select coalesce(string_agg(p.proname, ', '), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname not in ('leaderboard', 'username_available')),  -- read-only, public by design
  '', 'no privileged public function is callable without a session (except the public read-only ones)');

select is(
  (select coalesce(string_agg(table_name || '.' || privilege_type, ', '), '')
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      and table_name in ('games', 'game_rounds', 'locations', 'reserved_usernames')),
  '', 'no table-level write grants on game, answer or admin tables');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name ~* '(email|phone|password|address|birth)'),
  0, 'profiles stores no email or other private contact data');

select * from finish();
rollback;
