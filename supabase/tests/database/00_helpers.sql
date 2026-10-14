-- Shared test helpers (loaded first; each test file still runs in its own
-- transaction and rolls back). Run with:  supabase test db
--
-- tests.as_user(uuid, is_anonymous) / tests.as_anon() / tests.as_admin()
-- switch the current role and JWT claims exactly the way PostgREST does,
-- so RLS and column grants are exercised as a real client would hit them.
begin;
select plan(1);

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

create or replace function tests.create_user(p_email text, p_anonymous boolean default false)
returns uuid
language plpgsql
as $$
declare uid uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, is_anonymous)
  values (uid, case when p_anonymous then null else p_email end, p_anonymous);
  return uid;
end;
$$;

create or replace function tests.as_user(p_uid uuid, p_anonymous boolean default false)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anonymous)::text, true);
  execute 'set local role authenticated';
end;
$$;

create or replace function tests.as_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;

create or replace function tests.as_admin()
returns void
language plpgsql
as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

grant execute on all functions in schema tests to anon, authenticated;

select pass('test helpers installed');
select * from finish();
commit;  -- helpers persist for the following files (test database only)
