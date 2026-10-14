-- =====================================================================
-- UManitoba Guesser 2.0 - guest data retention
--
-- Deletes anonymous (guest) users who were created more than p_days ago and
-- have not started a game in the last p_days. Their games and rounds go
-- with them (ON DELETE CASCADE). Registered users are never touched.
-- Supabase documents deleting anonymous users from auth.users this way.
--
-- Scheduled daily with pg_cron (enabled in the dashboard; see
-- docs/backend/launch.md). Not callable by clients.
-- =====================================================================
create or replace function private.purge_inactive_guests(p_days int default 30)
returns int
language plpgsql
set search_path = ''
as $$
declare n int;
begin
  if p_days is null or p_days < 1 then
    raise exception 'p_days must be >= 1';
  end if;

  with gone as (
    delete from auth.users u
     where u.is_anonymous
       and u.created_at < now() - make_interval(days => p_days)
       and not exists (
         select 1 from public.games g
          where g.user_id = u.id and g.started_at > now() - make_interval(days => p_days))
    returning 1
  )
  select count(*) into n from gone;
  return n;
end;
$$;

revoke all on function private.purge_inactive_guests(int) from public, anon, authenticated;
