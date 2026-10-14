/* static/account.js - account page: email-code sign-in, username, UM verification,
   personal bests, sign-out and deletion. All rules are enforced on the server. */
(function () {
    'use strict';
    const api = window.UMGApi;
    const $ = (id) => document.getElementById(id);
    const states = ['stLoading', 'stOff', 'stSignIn', 'stUsername', 'stAccount'];
    let pendingEmail = '';
    let pendingMode = 'signin';

    function show(id) { states.forEach(s => { $(s).hidden = s !== id; }); }
    function msg(text, kind) { const m = $('msg'); m.textContent = text || ''; m.className = 'acct-msg' + (kind ? ' ' + kind : ''); }
    function busy(btn, on, label) {
        if (!btn) return;
        if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Please wait…'; btn.disabled = true; }
        else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
    }

    const FRIENDLY = {
        email_address_not_authorized: "Sign-in emails aren't switched on for everyone yet. Please try again soon.",
        over_email_send_rate_limit: 'Too many emails just now. Please wait a minute and try again.',
        over_request_rate_limit: 'Too many attempts. Please wait a minute and try again.',
        otp_expired: 'That code has expired or is wrong. Request a new one.',
        captcha_failed: "The bot check didn't pass. Refresh the page and try again.",
        not_eligible: 'Use a @myumanitoba.ca or @umanitoba.ca address.',
        already_verified: "You're already verified.",
        rate_limited: "You've asked for a lot of codes. Please try again in an hour.",
        wrong_code: "That code isn't right. Check it and try again.",
        expired: 'That code has expired. Send a new one.',
        too_many_attempts: 'Too many wrong tries. Send a new code.',
        no_request: 'Send a code first.',
        email_in_use: 'That university email is already linked to another account.',
        email_not_configured: "University verification emails aren't switched on yet. Please try again soon.",
        email_failed: "We couldn't send the email. Please try again.",
        reauth_required: 'For safety, confirm with a fresh code first.',
        not_configured: "University verification isn't set up yet."
    };
    function explain(err) {
        const key = err && (err.reason || err.code || err.error_code);
        if (key && FRIENDLY[key]) return FRIENDLY[key];
        const m = String((err && err.message) || '');
        if (/not authorized/i.test(m)) return FRIENDLY.email_address_not_authorized;
        if (/expired|invalid/i.test(m)) return FRIENDLY.otp_expired;
        if (/captcha/i.test(m)) return FRIENDLY.captcha_failed;
        if (/rate limit|too many/i.test(m)) return FRIENDLY.over_request_rate_limit;
        return 'Something went wrong. Please try again.';
    }

    // ---------- Render ----------
    async function render() {
        msg('');
        if (!api || !api.accounts) { show('stOff'); return; }
        let session;
        try { session = await api.auth.session(); } catch (e) { show('stOff'); return; }
        if (!session || session.user.is_anonymous) {
            show('stSignIn');
            $('acctSub').textContent = 'Sign in with a one-time code. No password needed.';
            return;
        }
        const profile = await api.auth.profile();
        if (!profile) {
            show('stUsername');
            $('acctSub').textContent = 'Almost done: choose the name other players will see.';
            $('username').focus();
            return;
        }
        show('stAccount');
        $('acctSub').textContent = 'You are signed in.';
        $('acctName').textContent = profile.username;
        $('acctEmail').textContent = session.user.email || '';
        $('rename').value = profile.username;
        $('umBadge').hidden = !profile.is_um_verified;
        $('umPanel').hidden = !!profile.is_um_verified;
        renderBests();
    }

    async function renderBests() {
        try {
            const rows = await api.auth.myBests();
            if (!rows || !rows.length) return;
            const label = (r) => `${r.difficulty[0].toUpperCase()}${r.difficulty.slice(1)} · ${r.rounds_planned ? r.rounds_planned + ' rounds' : 'Unlimited'}`;
            $('bests').innerHTML = '<table class="acct-table"><thead><tr><th>Mode</th><th>Best</th><th>Ranked best</th><th>Games</th></tr></thead><tbody>' +
                rows.map(r => `<tr><td>${label(r)}</td><td>${Number(r.best_score).toLocaleString()}</td><td>${r.ranked_best == null ? '—' : Number(r.ranked_best).toLocaleString()}</td><td>${r.games_played}</td></tr>`).join('') +
                '</tbody></table>';
        } catch (e) { /* bests are optional */ }
    }

    // ---------- Sign in ----------
    $('emailForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('email').value.trim();
        busy($('emailBtn'), true, 'Sending…');
        msg('');
        try {
            pendingMode = await api.auth.sendCode(email);
            pendingEmail = email;
            $('codeEmail').textContent = email;
            $('emailForm').hidden = true;
            $('codeForm').hidden = false;
            $('code').value = '';
            $('code').focus();
            msg('Code sent. Check your inbox.', 'ok');
        } catch (err) { msg(explain(err), 'err'); }
        busy($('emailBtn'), false);
    });

    $('codeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('codeBtn'), true, 'Checking…');
        try {
            await api.auth.verifyCode(pendingEmail, $('code').value.replace(/\D/g, ''), pendingMode);
            $('codeForm').hidden = true;
            $('emailForm').hidden = false;
            await render();
        } catch (err) { msg(explain(err), 'err'); }
        busy($('codeBtn'), false);
    });

    $('changeEmail').addEventListener('click', () => {
        $('codeForm').hidden = true;
        $('emailForm').hidden = false;
        msg('');
    });

    // ---------- Username ----------
    let nameTimer;
    $('username').addEventListener('input', () => {
        clearTimeout(nameTimer);
        const v = $('username').value.trim();
        nameTimer = setTimeout(async () => {
            if (!v) { $('nameHint').textContent = '3–20 letters, numbers or underscores. This is shown on the leaderboard.'; return; }
            try {
                const r = await api.auth.usernameAvailable(v);
                $('nameHint').textContent = { ok: '✓ Available', taken: 'That name is taken.', reserved: "That name can't be used.", invalid: '3–20 letters, numbers or underscores only.' }[r] || '';
            } catch (e) { /* hint only */ }
        }, 300);
    });

    async function saveName(input, btn, hintEl) {
        const name = input.value.trim();
        const r = await api.auth.usernameAvailable(name);
        if (r !== 'ok') {
            hintEl.textContent = { taken: 'That name is taken.', reserved: "That name can't be used.", invalid: '3–20 letters, numbers or underscores only.' }[r];
            return false;
        }
        busy(btn, true, 'Saving…');
        try { await api.auth.saveUsername(name); return true; }
        catch (err) { hintEl.textContent = /duplicate|unique/i.test(err.message) ? 'That name is taken.' : explain(err); return false; }
        finally { busy(btn, false); }
    }

    $('nameForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (await saveName($('username'), $('nameBtn'), $('nameHint'))) render();
    });

    $('renameForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (await saveName($('rename'), e.submitter, $('renameHint'))) { $('renameHint').textContent = '✓ Saved'; render(); }
    });

    // ---------- UM verification ----------
    $('umEmailForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('umEmailBtn'), true, 'Sending…');
        msg('');
        try {
            await api.auth.umStart($('umEmail').value.trim());
            $('umEmailForm').hidden = true;
            $('umCodeForm').hidden = false;
            $('umCode').focus();
            msg('Code sent to your university email. It expires in 15 minutes.', 'ok');
        } catch (err) { msg(explain(err), 'err'); }
        busy($('umEmailBtn'), false);
    });

    $('umCodeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('umCodeBtn'), true, 'Verifying…');
        try {
            await api.auth.umConfirm($('umCode').value.trim());
            msg("🎉 You're verified! Your 5, 10 and 20-round games now count on the leaderboard.", 'ok');
            await render();
        } catch (err) {
            msg(explain(err), 'err');
            if (['expired', 'too_many_attempts', 'email_in_use', 'no_request'].includes(err.reason)) {
                $('umCodeForm').hidden = true;
                $('umEmailForm').hidden = false;
            }
        }
        busy($('umCodeBtn'), false);
    });

    // ---------- Sign out / delete ----------
    $('signOutBtn').addEventListener('click', async () => {
        await api.auth.signOut();
        render();
    });

    $('deleteStart').addEventListener('click', async () => {
        if (!window.confirm('Delete your account and all your scores? This cannot be undone.')) return;
        const session = await api.auth.session();
        busy($('deleteStart'), true, 'Sending code…');
        try {
            pendingEmail = session.user.email;
            await api.auth.sendCode(pendingEmail);   // fresh sign-in code proves it's really you
            $('deleteForm').hidden = false;
            $('deleteCode').focus();
            msg('We emailed you a code to confirm.', 'ok');
        } catch (err) { msg(explain(err), 'err'); }
        busy($('deleteStart'), false);
    });

    $('deleteForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('deleteBtn'), true, 'Deleting…');
        try {
            await api.auth.verifyCode(pendingEmail, $('deleteCode').value.replace(/\D/g, ''), 'signin');
            await api.auth.deleteAccount();
            $('deleteForm').hidden = true;
            msg('Your account and all its data have been deleted.', 'ok');
            render();
        } catch (err) { msg(explain(err), 'err'); }
        busy($('deleteBtn'), false);
    });

    render();
})();
