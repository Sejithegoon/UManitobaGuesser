/* static/api.js - thin client for the server-run game (Supabase RPCs).
   Loads nothing unless the server game is switched on (config.js or ?server=1),
   so the classic game is unaffected. Players get an anonymous "guest" session
   automatically; every rule (deadlines, scoring, answers) lives on the server. */
(function () {
    'use strict';

    const cfg = window.UMG_CONFIG || {};
    const forced = new URLSearchParams(location.search).get('server');
    const enabled = forced === '1' ? true : forced === '0' ? false : !!cfg.serverGame;

    // Pinned version + Subresource Integrity: the browser refuses the file if it ever changes
    const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js';
    const SDK_SRI = 'sha384-BWcjm9OdFth9TbhCxZPdm+gAOUMAzQy9nmTs12ioXdCcbVnJaPMn+fMUoQCLt60R';

    // Cloudflare Turnstile (bot check) - only used when a site key is configured.
    // Must be loaded from this exact URL (Cloudflare updates it; no SRI possible).
    const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

    let clientPromise = null;

    function loadScript(src, integrity) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
            s.onload = resolve;
            s.onerror = () => reject(new Error('script_load_failed: ' + src));
            document.head.appendChild(s);
        });
    }

    // Returns a one-time Turnstile token. Invisible for most people; if Cloudflare
    // wants a click, a small centred box appears until it's done.
    async function captchaToken() {
        if (!cfg.turnstileSiteKey) return undefined;
        if (!window.turnstile) await loadScript(TURNSTILE_URL);
        let box = document.getElementById('umg-captcha');
        if (!box) {
            box = document.createElement('div');
            box.id = 'umg-captcha';
            box.className = 'captcha-box';
            box.hidden = true;
            box.innerHTML = '<p>Quick check that you’re not a bot</p><div class="captcha-widget"></div>';
            document.body.appendChild(box);
        }
        return new Promise((resolve, reject) => {
            const id = window.turnstile.render(box.querySelector('.captcha-widget'), {
                sitekey: cfg.turnstileSiteKey,
                appearance: 'interaction-only',
                theme: document.documentElement.classList.contains('dark-mode') ? 'dark' : 'light',
                'before-interactive-callback': () => { box.hidden = false; },
                'after-interactive-callback': () => { box.hidden = true; },
                callback: (token) => { box.hidden = true; resolve(token); setTimeout(() => window.turnstile.remove(id), 0); },
                'error-callback': () => { box.hidden = true; reject(new Error('captcha_failed')); },
                'expired-callback': () => { box.hidden = true; reject(new Error('captcha_expired')); }
            });
        });
    }

    function loadSdk() {
        if (window.supabase && window.supabase.createClient) return Promise.resolve();
        return loadScript(SDK_URL, SDK_SRI);
    }

    // One Supabase client per page (no sign-in by itself)
    let basePromise = null;
    function baseClient() {
        if (!basePromise) {
            basePromise = loadSdk()
                .then(() => window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
                    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
                }))
                .catch(err => { basePromise = null; throw err; });
        }
        return basePromise;
    }

    // For the game: make sure there's a session, signing in as a guest if needed
    function client() {
        if (!clientPromise) {
            clientPromise = (async () => {
                const c = await baseClient();
                const { data } = await c.auth.getSession();
                if (!data.session) {
                    // Returning guests reuse their saved session, so the bot check runs once per browser
                    const token = await captchaToken();
                    const { error } = await c.auth.signInAnonymously({ options: { captchaToken: token } });
                    if (error) throw Object.assign(new Error('guest_sign_in_failed'), { cause: error });
                }
                return c;
            })().catch(err => { clientPromise = null; throw err; });
        }
        return clientPromise;
    }

    async function rpc(fn, args, c) {
        c = c || await client();
        const { data, error } = await c.rpc(fn, args);
        if (error) throw Object.assign(new Error(error.message || 'rpc_failed'), { code: error.code });
        return data;
    }

    // Edge Functions (UM verification, account deletion) with the caller's session
    async function callFunction(name, body) {
        const c = await baseClient();
        const { data } = await c.auth.getSession();
        if (!data.session) throw Object.assign(new Error('not_signed_in'), { reason: 'not_signed_in' });
        const res = await fetch(`${cfg.supabaseUrl}/functions/v1/${name}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: cfg.supabaseKey,
                Authorization: `Bearer ${data.session.access_token}`
            },
            body: JSON.stringify(body || {})
        });
        let out = {};
        try { out = await res.json(); } catch { /* empty body */ }
        if (!res.ok || out.ok === false) throw Object.assign(new Error(out.reason || 'request_failed'), { reason: out.reason || 'request_failed', status: res.status, data: out });
        return out;
    }

    const accountPage = `${location.origin}/account.html`;

    // Accounts: passwordless email codes. Everything here is safe to call from the browser;
    // the database and Edge Functions enforce the rules.
    const auth = {
        async session() {
            const c = await baseClient();
            const { data } = await c.auth.getSession();
            return data.session;
        },
        // Sends a 6-digit code. A guest keeps their game history by adding an email to the
        // same account; if that email already has an account, it signs in to that one instead.
        async sendCode(email) {
            const c = await baseClient();
            const { data } = await c.auth.getSession();
            if (data.session && data.session.user.is_anonymous) {
                const up = await c.auth.updateUser({ email }, { emailRedirectTo: accountPage });
                if (!up.error) return 'convert';
            }
            const token = await captchaToken();
            const { error } = await c.auth.signInWithOtp({
                email,
                options: { shouldCreateUser: true, captchaToken: token, emailRedirectTo: accountPage }
            });
            if (error) throw error;
            return 'signin';
        },
        async verifyCode(email, code, mode) {
            const c = await baseClient();
            const { data, error } = await c.auth.verifyOtp({ email, token: code, type: mode === 'convert' ? 'email_change' : 'email' });
            if (error) throw error;
            clientPromise = null;   // the game should pick up the new session
            return data.session;
        },
        async signOut() {
            const c = await baseClient();
            await c.auth.signOut();
            clientPromise = null;
        },
        async profile() {
            const c = await baseClient();
            const { data: s } = await c.auth.getSession();
            if (!s.session) return null;
            const { data, error } = await c.from('profiles')
                .select('id, username, is_um_verified, created_at').eq('id', s.session.user.id).maybeSingle();
            if (error) throw error;
            return data;
        },
        async saveUsername(username) {
            const c = await baseClient();
            const { data: s } = await c.auth.getSession();
            const uid = s.session.user.id;
            const existing = await this.profile();
            const q = existing
                ? c.from('profiles').update({ username }).eq('id', uid)
                : c.from('profiles').insert({ id: uid, username });
            const { error } = await q;
            if (error) throw error;
        },
        async usernameAvailable(username) { return rpc('username_available', { p_username: username }, await baseClient()); },
        async myBests() { return rpc('my_bests', {}, await baseClient()); },
        umStart: (email) => callFunction('um-verify', { action: 'start', email }),
        umConfirm: (code) => callFunction('um-verify', { action: 'confirm', code }),
        async deleteAccount() {
            const out = await callFunction('delete-account', {});
            const c = await baseClient();
            await c.auth.signOut({ scope: 'local' });
            clientPromise = null;
            return out;
        }
    };

    window.UMGApi = {
        enabled,
        accounts: cfg.accounts !== false,
        leaderboardEnabled: cfg.leaderboard !== false,
        startGame: (difficulty, rounds) => rpc('game_start', { p_difficulty: difficulty, p_rounds: rounds }),
        startRound: (gameId) => rpc('game_start_round', { p_game_id: gameId }),
        submit: (gameId, lat, lng) => rpc('game_submit', { p_game_id: gameId, p_lat: lat, p_lng: lng }),
        nextRound: (gameId) => rpc('game_next_round', { p_game_id: gameId }),
        finish: (gameId) => rpc('game_finish', { p_game_id: gameId }),
        leaderboard: async (difficulty, rounds, period) =>
            rpc('leaderboard', { p_difficulty: difficulty, p_rounds: rounds, p_period: period }, await baseClient()),
        auth
    };
})();
