/* static/leaderboard.js - ranked leaderboard (scores come straight from the server) */
(function () {
    'use strict';
    const api = window.UMGApi;
    const $ = (id) => document.getElementById(id);
    const filter = { difficulty: 'easy', rounds: 5, period: 'all' };

    function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function when(ts) { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    const medal = (n) => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[n] || n);

    async function load() {
        const body = $('lbBody');
        if (!api || !api.leaderboardEnabled) { body.innerHTML = '<p class="muted">The leaderboard is coming soon.</p>'; return; }
        body.innerHTML = '<p class="muted">Loading…</p>';
        try {
            const rows = await api.leaderboard(filter.difficulty, filter.rounds, filter.period);
            if (!rows || !rows.length) {
                body.innerHTML = '<p class="lb-empty">No ranked games here yet. Be the first! 🦬</p>';
                return;
            }
            const max = filter.rounds * 5000;
            body.innerHTML = '<table class="acct-table lb-table"><thead><tr><th>#</th><th>Player</th><th>Score</th><th>Date</th></tr></thead><tbody>' +
                rows.map(r => `<tr${r.is_me ? ' class="me"' : ''}><td class="lb-rank">${medal(Number(r.rank))}</td><td>${esc(r.username)}${r.is_me ? ' <span class="badge sm">You</span>' : ''}</td><td><strong>${Number(r.score).toLocaleString()}</strong> <span class="muted">/ ${max.toLocaleString()}</span></td><td class="muted">${when(r.achieved_at)}</td></tr>`).join('') +
                '</tbody></table>';
        } catch (err) {
            console.error(err);
            body.innerHTML = '<p class="muted">Couldn’t load the leaderboard. Please refresh.</p>';
        }
    }

    function wire(groupId, key, cast) {
        $(groupId).addEventListener('click', (e) => {
            const b = e.target.closest('button[data-v]');
            if (!b) return;
            [...$(groupId).children].forEach(x => x.classList.toggle('on', x === b));
            filter[key] = cast ? cast(b.dataset.v) : b.dataset.v;
            load();
        });
    }
    wire('fDiff', 'difficulty');
    wire('fRounds', 'rounds', Number);
    wire('fPeriod', 'period');

    // Hide the call-to-action for players who are already verified
    (async () => {
        try {
            if (!api || !api.accounts) return;
            const s = await api.auth.session();
            if (s && !s.user.is_anonymous) {
                const p = await api.auth.profile();
                if (p && p.is_um_verified) $('lbCta').hidden = true;
            }
        } catch (e) { /* optional */ }
    })();

    load();
})();
