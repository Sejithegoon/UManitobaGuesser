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

    // One client per page; signs in as a guest if there is no session yet
    function client() {
        if (!clientPromise) {
            clientPromise = (async () => {
                await loadSdk();
                const c = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
                    auth: { persistSession: true, autoRefreshToken: true }
                });
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

    async function rpc(fn, args) {
        const c = await client();
        const { data, error } = await c.rpc(fn, args);
        if (error) throw Object.assign(new Error(error.message || 'rpc_failed'), { code: error.code });
        return data;
    }

    window.UMGApi = {
        enabled,
        startGame: (difficulty, rounds) => rpc('game_start', { p_difficulty: difficulty, p_rounds: rounds }),
        startRound: (gameId) => rpc('game_start_round', { p_game_id: gameId }),
        submit: (gameId, lat, lng) => rpc('game_submit', { p_game_id: gameId, p_lat: lat, p_lng: lng }),
        nextRound: (gameId) => rpc('game_next_round', { p_game_id: gameId }),
        finish: (gameId) => rpc('game_finish', { p_game_id: gameId })
    };
})();
