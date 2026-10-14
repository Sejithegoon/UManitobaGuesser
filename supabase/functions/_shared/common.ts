// Shared helpers for UManitoba Guesser Edge Functions.
// Secrets come only from the function environment (never from the client).
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.117.3';

const ALLOWED_ORIGINS = new Set([
  'https://umanitobaguesser.ca',
  'https://www.umanitobaguesser.ca',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://umanitobaguesser.ca',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function secretKey(): string {
  // New-style keys (JSON object keyed by name), with the legacy variable as fallback
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      if (parsed.default) return parsed.default;
    } catch { /* fall through */ }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!legacy) throw new Error('server key missing');
  return legacy;
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The signed-in caller, validated by the Auth server, plus the token's issue time. */
export async function callerFrom(req: Request, admin: SupabaseClient): Promise<{ user: User; iat: number } | null> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  let iat = 0;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    iat = Number(payload.iat) || 0;
  } catch { /* iat stays 0 */ }
  return { user: data.user, iat };
}

/** HMAC-SHA256, hex. Used so emails and codes are never stored in plain text. */
export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
