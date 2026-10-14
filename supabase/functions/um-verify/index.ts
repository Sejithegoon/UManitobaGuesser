// um-verify: prove you have a University of Manitoba email.
//   POST { action: "start",   email: "you@myumanitoba.ca" }  -> emails a 6-digit code
//   POST { action: "confirm", code: "123456" }               -> marks your profile verified
// Rules (expiry, attempts, send limits, one email per account) live in the
// database functions um_start / um_confirm. Secrets used here:
//   UM_EMAIL_HMAC_KEY (required), UM_HMAC_KEY_VERSION (default 1),
//   RESEND_API_KEY + RESEND_FROM (for sending the email).
import { adminClient, callerFrom, corsHeaders, hmacHex, json } from '../_shared/common.ts';

const ELIGIBLE_DOMAINS = ['myumanitoba.ca', 'umanitoba.ca'];

function normalize(raw: string): { email: string; domain: string } | null {
  const email = String(raw ?? '').trim().toLowerCase();
  const m = email.match(/^([a-z0-9._-]+)(\+[^@]*)?@([a-z0-9.-]+)$/);
  if (!m || !ELIGIBLE_DOMAINS.includes(m[3])) return null;
  // Drop "+tag" so one mailbox can't verify several accounts
  return { email: `${m[1]}@${m[3]}`, domain: m[3] };
}

function sixDigitCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4_294_000_000); // avoid modulo bias
  return String(n % 1_000_000).padStart(6, '0');
}

async function sendEmail(to: string, code: string): Promise<boolean> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM');
  if (!apiKey || !from) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: `Your UManitoba Guesser code: ${code}`,
      text: `Your UManitoba Guesser verification code is ${code}.\n\nIt expires in 15 minutes. If you didn't ask for this, you can ignore this email.`,
    }),
  });
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { ok: false, reason: 'method_not_allowed' });

  const hmacKey = Deno.env.get('UM_EMAIL_HMAC_KEY');
  if (!hmacKey) return json(req, 503, { ok: false, reason: 'not_configured' });
  const keyVersion = Number(Deno.env.get('UM_HMAC_KEY_VERSION') ?? '1');

  const admin = adminClient();
  const caller = await callerFrom(req, admin);
  if (!caller) return json(req, 401, { ok: false, reason: 'not_signed_in' });
  if (caller.user.is_anonymous) return json(req, 403, { ok: false, reason: 'account_required' });

  let body: { action?: string; email?: string; code?: string };
  try { body = await req.json(); } catch { return json(req, 400, { ok: false, reason: 'bad_request' }); }

  if (body.action === 'start') {
    const norm = normalize(body.email ?? '');
    if (!norm) return json(req, 400, { ok: false, reason: 'not_eligible' });
    if (!Deno.env.get('RESEND_API_KEY') || !Deno.env.get('RESEND_FROM')) {
      return json(req, 503, { ok: false, reason: 'email_not_configured' });
    }
    const code = sixDigitCode();
    const { data, error } = await admin.rpc('um_start', {
      p_user: caller.user.id,
      p_email_hmac: await hmacHex(hmacKey, norm.email),
      p_domain: norm.domain,
      p_code_hmac: await hmacHex(hmacKey, `${caller.user.id}:${code}`),
      p_key_version: keyVersion,
    });
    if (error) return json(req, 500, { ok: false, reason: 'server_error' });
    if (!data.ok) return json(req, data.reason === 'rate_limited' ? 429 : 400, data);
    const sent = await sendEmail(norm.email, code);
    if (!sent) return json(req, 502, { ok: false, reason: 'email_failed' });
    return json(req, 200, { ok: true });
  }

  if (body.action === 'confirm') {
    const code = String(body.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) return json(req, 400, { ok: false, reason: 'wrong_code' });
    const { data, error } = await admin.rpc('um_confirm', {
      p_user: caller.user.id,
      p_code_hmac: await hmacHex(hmacKey, `${caller.user.id}:${code}`),
    });
    if (error) return json(req, 500, { ok: false, reason: 'server_error' });
    return json(req, data.ok ? 200 : 400, data);
  }

  return json(req, 400, { ok: false, reason: 'bad_request' });
});
