-- =====================================================================
-- UManitoba Guesser 2.0 - Phase 4C: leaderboard + personal bests
-- Only finished, ranked games of players who are UM-verified *now* and
-- not hidden/banned. Best game per player; ties go to who got there first.
-- =====================================================================

create index games_ranked_period_idx on public.games (difficulty, rounds_planned, finished_at)
  where status = 'finished' and is_ranked;

create or replace function public.leaderboard(p_difficulty text, p_rounds int, p_period text default 'all')
returns table (rank bigint, username text, score int, achieved_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_since timestamptz;
begin
  if p_difficulty not in ('easy', 'medium', 'hard') or p_rounds not in (5, 10, 20) then
    raise exception 'invalid_filter' using errcode = 'P0001';
  end if;
  v_since := case coalesce(p_period, 'all')
               when 'week'  then now() - interval '7 days'
               when 'month' then now() - interval '30 days'
               when 'all'   then '-infinity'::timestamptz
             end;
  if v_since is null then
    raise exception 'invalid_filter' using errcode = 'P0001';
  end if;

  return query
  with best as (
    select distinct on (g.user_id) g.user_id, g.total_score, g.finished_at
      from public.games g
      join public.profiles p on p.id = g.user_id
     where g.status = 'finished' and g.is_ranked
       and g.difficulty = p_difficulty and g.rounds_planned = p_rounds
       and g.finished_at >= v_since
       and p.is_um_verified and p.moderation_status = 'active'
     order by g.user_id, g.total_score desc, g.finished_at asc
  )
  select rank() over (order by b.total_score desc, b.finished_at asc),
         p.username, b.total_score, b.finished_at, b.user_id = auth.uid()
    from best b join public.profiles p on p.id = b.user_id
   order by 1, b.finished_at
   limit 50;
end;
$$;

-- Your best finished game per mode (ranked or not), signed-in players only
create or replace function public.my_bests()
returns table (difficulty text, rounds_planned smallint, best_score int, ranked_best int, games_played bigint)
language sql stable security definer set search_path = '' as $$
  select g.difficulty, g.rounds_planned, max(g.total_score),
         max(g.total_score) filter (where g.is_ranked), count(*)
    from public.games g
   where g.user_id = auth.uid() and g.status = 'finished'
   group by g.difficulty, g.rounds_planned
   order by g.rounds_planned nulls last, g.difficulty
$$;

-- Moderation aid: implausibly accurate finished ranked games (admins / SQL Editor only)
create or replace view private.suspicious_games as
select g.id, g.user_id, p.username, g.difficulty, g.rounds_planned, g.total_score,
       avg(r.distance_m) as avg_distance_m, g.finished_at
  from public.games g
  join public.game_rounds r on r.game_id = g.id
  left join public.profiles p on p.id = g.user_id
 where g.status = 'finished' and g.is_ranked
 group by g.id, p.username
having avg(r.distance_m) < 5;

revoke all on function public.leaderboard(text, int, text) from public;
revoke all on function public.my_bests()                   from public, anon;
grant execute on function public.leaderboard(text, int, text) to anon, authenticated;
grant execute on function public.my_bests()                   to authenticated;
revoke all on table private.suspicious_games from public, anon, authenticated;
