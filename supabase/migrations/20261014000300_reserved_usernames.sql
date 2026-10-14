-- =====================================================================
-- UManitoba Guesser 2.0 - Phase 2: reserved usernames
-- Lower-case only (enforced by a CHECK). Add more later with a new
-- migration; never edit this one after it has been applied.
-- =====================================================================
insert into public.reserved_usernames (name, reason) values
  ('admin',          'staff'),
  ('administrator',  'staff'),
  ('moderator',      'staff'),
  ('mod',            'staff'),
  ('staff',          'staff'),
  ('support',        'staff'),
  ('help',           'staff'),
  ('owner',          'staff'),
  ('developer',      'staff'),
  ('dev',            'staff'),
  ('official',       'impersonation'),
  ('umanitoba',      'impersonation'),
  ('uofm',           'impersonation'),
  ('uofmanitoba',    'impersonation'),
  ('universityofmanitoba', 'impersonation'),
  ('umsu',           'impersonation'),
  ('umanitobaguesser', 'impersonation'),
  ('guesser',        'impersonation'),
  ('guest',          'system'),
  ('anonymous',      'system'),
  ('anon',           'system'),
  ('system',         'system'),
  ('root',           'system'),
  ('null',           'system'),
  ('undefined',      'system'),
  ('deleted',        'system'),
  ('deleted_user',   'system'),
  ('unknown',        'system'),
  ('everyone',       'system'),
  ('leaderboard',    'system')
on conflict (name) do nothing;
