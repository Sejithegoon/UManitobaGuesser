// delete-account: permanently delete the caller's account and everything it owns.
//   POST {}  (Authorization: Bearer <session token>)
// Registered accounts must have signed in with a fresh email code in the last
// 10 minutes. Guests can delete their own guest data at any time.
// Deleting the auth user cascades to profiles, games, rounds, UM affiliation
// and pending UM codes. A user id + time is logged (35 days) so the deletion
// can be re-applied if a backup is ever restored.
import { adminClient, callerFrom, corsHeaders, json } from '../_shared/common.ts';

const FRESH_SECONDS = 10 * 60;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { ok: false, reason: 'method_not_allowed' });

  const admin = adminClient();
  const caller = await callerFrom(req, admin);
  if (!caller) return json(req, 401, { ok: false, reason: 'not_signed_in' });

  if (!caller.user.is_anonymous && Date.now() / 1000 - caller.iat > FRESH_SECONDS) {
    return json(req, 401, { ok: false, reason: 'reauth_required' });
  }

  const log = await admin.rpc('account_log_deletion', { p_user: caller.user.id });
  if (log.error) return json(req, 500, { ok: false, reason: 'server_error' });

  const { error } = await admin.auth.admin.deleteUser(caller.user.id);
  if (error) return json(req, 500, { ok: false, reason: 'server_error' });
  return json(req, 200, { ok: true });
});
