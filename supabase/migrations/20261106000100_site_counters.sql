-- =====================================================================
-- UManitoba Guesser - Phase 5A: all-time site counters
--   * visits: one per browser session (the page calls track_visit() once)
--   * games_played: every finished game, solo/daily (trigger) or lobby
-- Running totals only: no IPs, no user ids, nothing per visitor. They live
-- in their own table so they never shrink when old guests are purged.
-- =====================================================================

create table private.site_counters (
  key    text primary key,
  value  bigint not null default 0,
  constraint site_counters_nonnegative check (value >= 0)
);
revoke all on table private.site_counters from public, anon, authenticated;

-- Start games_played from the finished games still in the database
insert into private.site_counters (key, value)
select 'visits', 0
union all
select 'games_played', count(*) from public.games where status = 'finished';

create or replace function private.bump_counter(p_key text, p_by bigint default 1)
returns void language sql set search_path = '' as $$
  update private.site_counters set value = value + p_by where key = p_key;
$$;

-- Callable by any visitor. It can only ever add one.
create or replace function public.track_visit()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.bump_counter('visits');
end;
$$;

create or replace function private.count_finished_game()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'finished' and old.status is distinct from 'finished' then
    perform private.bump_counter('games_played');
  end if;
  return new;
end;
$$;

create trigger games_count_finished
  after update of status on public.games
  for each row execute function private.count_finished_game();

-- Same as 20261021000100 plus the all-time totals
create or replace function public.site_stats()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'registered_players', (select count(*) from public.profiles where moderation_status = 'active'),
    'verified_players',   (select count(*) from public.profiles where moderation_status = 'active' and is_um_verified),
    'games_today',        (select count(*) from public.games
                            where status = 'finished' and finished_at >= date_trunc('day', now() at time zone 'America/Winnipeg') at time zone 'America/Winnipeg'),
    'total_visits',       (select value from private.site_counters where key = 'visits'),
    'games_played',       (select value from private.site_counters where key = 'games_played')
  )
$$;

revoke all on function private.bump_counter(text, bigint)  from public, anon, authenticated;
revoke all on function private.count_finished_game()       from public, anon, authenticated;
revoke all on function public.track_visit()                from public;
revoke all on function public.site_stats()                 from public;
grant execute on function public.track_visit() to anon, authenticated;
grant execute on function public.site_stats()  to anon, authenticated;
