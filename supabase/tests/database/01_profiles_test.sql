-- profiles: username rules, ownership, protected columns, public visibility
begin;
select plan(26);

-- Fixtures (as the database owner)
select tests.as_admin();
create temp table ids as
select tests.create_user('a@example.com')        as a,
       tests.create_user('b@example.com')        as b,
       tests.create_user(null, true)             as guest;
grant select on ids to anon, authenticated;

-- ---------- Creating a profile ----------
select tests.as_user((select a from ids));
select lives_ok(
  $$ insert into public.profiles (id, username) values ((select a from ids), 'BisonFan') $$,
  'a registered user can create their own profile');

select tests.as_user((select b from ids));
select throws_ok(
  $$ insert into public.profiles (id, username) values ((select b from ids), 'bisonfan') $$,
  '23505', null, 'usernames are unique regardless of capitalization');
select throws_ok(
  $$ insert into public.profiles (id, username) values ((select b from ids), 'BISONFAN') $$,
  '23505', null, 'upper-case duplicate is rejected too');

-- ---------- Username format ----------
select throws_ok($$ insert into public.profiles (id, username) values ((select b from ids), 'ab') $$,
  '23514', null, 'username shorter than 3 characters is rejected');
select throws_ok($$ insert into public.profiles (id, username) values ((select b from ids), repeat('x', 21)) $$,
  '23514', null, 'username longer than 20 characters is rejected');
select throws_ok($$ insert into public.profiles (id, username) values ((select b from ids), 'bad name') $$,
  '23514', null, 'spaces are rejected');
select throws_ok($$ insert into public.profiles (id, username) values ((select b from ids), 'bison!') $$,
  '23514', null, 'punctuation is rejected');
select throws_ok($$ insert into public.profiles (id, username) values ((select b from ids), 'émile') $$,
  '23514', null, 'non-ASCII letters are rejected');
select lives_ok($$ insert into public.profiles (id, username) values ((select b from ids), 'Billy_2026') $$,
  'a 3-20 character name with letters, digits and underscore is accepted');

-- ---------- Reserved names ----------
select tests.as_user((select b from ids));
select throws_ok($$ update public.profiles set username = 'admin' where id = (select b from ids) $$,
  '23514', null, 'a reserved name cannot be taken');
select throws_ok($$ update public.profiles set username = 'UManitoba' where id = (select b from ids) $$,
  '23514', null, 'reserved names are matched case-insensitively');

-- ---------- Ownership ----------
select tests.as_user((select b from ids));
select throws_ok(
  $$ insert into public.profiles (id, username) values ((select guest from ids), 'Impostor') $$,
  '42501', null, 'cannot create a profile for another user');

update public.profiles set username = 'Hijacked' where id = (select a from ids);
select tests.as_admin();
select is((select username from public.profiles where id = (select a from ids)), 'BisonFan',
  'cannot rename another user''s profile (RLS hides the row)');

-- ---------- Guests ----------
select tests.as_user((select guest from ids), true);
select throws_ok(
  $$ insert into public.profiles (id, username) values ((select guest from ids), 'GuestUser') $$,
  '42501', null, 'anonymous (guest) sessions cannot create a profile');

-- ---------- Protected columns ----------
select tests.as_user((select a from ids));
select throws_ok($$ update public.profiles set is_um_verified = true, um_verified_at = now() where id = (select a from ids) $$,
  '42501', null, 'a user cannot mark themselves UM-verified');
select throws_ok($$ update public.profiles set role = 'admin' where id = (select a from ids) $$,
  '42501', null, 'a user cannot change their own role');
select throws_ok($$ update public.profiles set moderation_status = 'active' where id = (select a from ids) $$,
  '42501', null, 'a user cannot change their own moderation status');
select throws_ok($$ update public.profiles set created_at = now() - interval '5 years' where id = (select a from ids) $$,
  '42501', null, 'a user cannot rewrite timestamps');
select lives_ok($$ update public.profiles set username = 'BisonFan2' where id = (select a from ids) $$,
  'a user can rename themselves');

select tests.as_user((select b from ids));
select throws_ok(
  $$ delete from public.profiles where id = (select b from ids) $$,
  '42501', null, 'profiles cannot be deleted from the client');

-- Inserting with protected columns set also fails
select tests.as_admin();
delete from public.profiles where id = (select b from ids);
select tests.as_user((select b from ids));
select throws_ok(
  $$ insert into public.profiles (id, username, is_um_verified, um_verified_at) values ((select b from ids), 'Sneaky', true, now()) $$,
  '42501', null, 'cannot create a profile that is already UM-verified');

-- ---------- Public visibility ----------
select tests.as_anon();
select is((select username from public.profiles where id = (select a from ids)), 'BisonFan2',
  'visitors can read public profile fields');
select throws_ok($$ select role from public.profiles $$,
  '42501', null, 'visitors cannot read the role column');
select throws_ok($$ select moderation_status from public.profiles $$,
  '42501', null, 'visitors cannot read the moderation column');

select tests.as_admin();
update public.profiles set moderation_status = 'hidden' where id = (select a from ids);
select tests.as_anon();
select is((select count(*)::int from public.profiles where id = (select a from ids)), 0,
  'moderated (hidden) profiles are not publicly visible');
select tests.as_user((select a from ids));
select is((select count(*)::int from public.profiles where id = (select a from ids)), 1,
  'a hidden user can still see their own profile');

select * from finish();
rollback;
