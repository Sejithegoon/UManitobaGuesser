-- =====================================================================
-- UManitoba Guesser 2.0 - public site stats (counts only, no personal data)
-- =====================================================================
create or replace function public.site_stats()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'registered_players', (select count(*) from public.profiles where moderation_status = 'active'),
    'verified_players',   (select count(*) from public.profiles where moderation_status = 'active' and is_um_verified),
    'games_today',        (select count(*) from public.games
                            where status = 'finished' and finished_at >= date_trunc('day', now() at time zone 'America/Winnipeg') at time zone 'America/Winnipeg')
  )
$$;
revoke all on function public.site_stats() from public;
grant execute on function public.site_stats() to anon, authenticated;
