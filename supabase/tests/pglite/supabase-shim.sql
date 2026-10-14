-- Minimal stand-in for the parts of a Supabase database the migrations rely on.
-- Used ONLY by the offline PGlite test harness; a real Supabase project
-- (or `supabase start`) already provides all of this.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

grant usage on schema public to anon, authenticated, service_role;

-- Simulate the LEGACY Supabase default (projects created before 2026-05-30):
-- every new table/function in public is fully granted to the API roles.
-- The migrations must still end up locked down under this worst case.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id            uuid primary key,
  email         text,
  is_anonymous  boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Same definitions Supabase ships (claims come from the request JWT)
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
