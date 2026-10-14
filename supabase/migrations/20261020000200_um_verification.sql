-- =====================================================================
-- UManitoba Guesser 2.0 - Phase 4B: University of Manitoba verification
--
-- The Edge Function `um-verify` does the crypto and email; these functions
-- hold every rule and are callable ONLY with the server secret key
-- (service_role). No UM email address is ever stored: only a keyed hash
-- (HMAC with a secret that lives in Edge Function secrets), so one
-- university address can verify one account, and the address itself
-- can't be read back from the database.
-- =====================================================================

create table public.um_affiliations (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  email_hmac        text not null unique,
  hmac_key_version  smallint not null default 1,
  domain            text not null,
  verified_at       timestamptz not null default now(),
  constraint um_affiliations_domain_valid check (domain in ('myumanitoba.ca', 'umanitoba.ca'))
);
comment on table public.um_affiliations is
  'Which account a UM email (keyed hash only) verified. No client access.';

create table public.um_verification_requests (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  email_hmac        text not null,
  hmac_key_version  smallint not null default 1,
  domain            text not null,
  code_hmac         text not null,
  expires_at        timestamptz not null,
  attempts          smallint not null default 0,
  sends_in_hour     smallint not null default 0,
  hour_started_at   timestamptz not null default now(),
  sends_in_day      smallint not null default 0,
  day_started_at    timestamptz not null default now(),
  constraint um_requests_domain_valid check (domain in ('myumanitoba.ca', 'umanitoba.ca'))
);
comment on table public.um_verification_requests is
  'Pending UM codes (keyed hash only), 15-minute expiry, 5 attempts. No client access.';

alter table public.um_affiliations          enable row level security;
alter table public.um_verification_requests enable row level security;
revoke all on table public.um_affiliations          from anon, authenticated;
revoke all on table public.um_verification_requests from anon, authenticated;

-- ---------------------------------------------------------------------
-- um_start: record a new code (limits: 3 sends/hour, 10/day)
-- returns { ok, reason }   reason: already_verified | not_eligible | rate_limited
-- ---------------------------------------------------------------------
create or replace function public.um_start(p_user uuid, p_email_hmac text, p_domain text,
                                           p_code_hmac text, p_key_version int default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.um_verification_requests;
begin
  if not exists (select 1 from auth.users u where u.id = p_user and not u.is_anonymous)
     or not exists (select 1 from public.profiles p where p.id = p_user and p.moderation_status <> 'banned') then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;
  if p_domain not in ('myumanitoba.ca', 'umanitoba.ca') then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;
  if exists (select 1 from public.profiles p where p.id = p_user and p.is_um_verified) then
    return jsonb_build_object('ok', false, 'reason', 'already_verified');
  end if;

  select * into r from public.um_verification_requests where user_id = p_user for update;
  if found then
    if r.hour_started_at < now() - interval '1 hour' then r.sends_in_hour := 0; r.hour_started_at := now(); end if;
    if r.day_started_at  < now() - interval '1 day'  then r.sends_in_day  := 0; r.day_started_at  := now(); end if;
    if r.sends_in_hour >= 3 or r.sends_in_day >= 10 then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited');
    end if;
    update public.um_verification_requests
       set email_hmac = p_email_hmac, hmac_key_version = p_key_version, domain = p_domain,
           code_hmac = p_code_hmac, expires_at = now() + interval '15 minutes', attempts = 0,
           sends_in_hour = r.sends_in_hour + 1, hour_started_at = r.hour_started_at,
           sends_in_day = r.sends_in_day + 1, day_started_at = r.day_started_at
     where user_id = p_user;
  else
    insert into public.um_verification_requests
      (user_id, email_hmac, hmac_key_version, domain, code_hmac, expires_at, sends_in_hour, sends_in_day)
    values (p_user, p_email_hmac, p_key_version, p_domain, p_code_hmac, now() + interval '15 minutes', 1, 1);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- um_confirm: check a code (5 attempts, 15 minutes); on success link the
-- UM email to this account and mark the profile verified.
-- reason: no_request | expired | too_many_attempts | wrong_code | email_in_use
-- ---------------------------------------------------------------------
create or replace function public.um_confirm(p_user uuid, p_code_hmac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.um_verification_requests;
begin
  select * into r from public.um_verification_requests where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_request');
  end if;
  if r.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if r.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;

  update public.um_verification_requests set attempts = attempts + 1 where user_id = p_user;
  if r.code_hmac <> p_code_hmac then
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 4 - r.attempts);
  end if;

  -- The mailbox is proven; only now reveal whether it's already linked elsewhere
  if exists (select 1 from public.um_affiliations a where a.email_hmac = r.email_hmac and a.user_id <> p_user) then
    -- Expire the code but keep the row, so the send limits still apply
    update public.um_verification_requests set expires_at = now() where user_id = p_user;
    return jsonb_build_object('ok', false, 'reason', 'email_in_use');
  end if;

  insert into public.um_affiliations (user_id, email_hmac, hmac_key_version, domain, verified_at)
  values (p_user, r.email_hmac, r.hmac_key_version, r.domain, now())
  on conflict (user_id) do update
    set email_hmac = excluded.email_hmac, hmac_key_version = excluded.hmac_key_version,
        domain = excluded.domain, verified_at = excluded.verified_at;

  update public.profiles set is_um_verified = true, um_verified_at = now() where id = p_user;
  delete from public.um_verification_requests where user_id = p_user;
  return jsonb_build_object('ok', true, 'domain', r.domain);
end;
$$;

revoke all on function public.um_start(uuid, text, text, text, int) from public, anon, authenticated;
revoke all on function public.um_confirm(uuid, text)                 from public, anon, authenticated;
grant execute on function public.um_start(uuid, text, text, text, int) to service_role;
grant execute on function public.um_confirm(uuid, text)                 to service_role;
