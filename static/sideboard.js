/* static/sideboard.js - on wide screens, show the leaderboard for the mode being
   played next to the game. Read-only; never affects gameplay. */
(function () {
    'use strict';
    const api = window.UMGApi;
    const box = document.getElementById('sideBoard');
    if (!box || !api || !api.leaderboardEnabled) return;

    const wide = window.matchMedia('(min-width: 1280px)');
    const params = new URLSearchParams(location.search);
    const difficulty = ['easy', 'medium', 'hard'].includes(params.get('diff')) ? params.get('diff') : 'easy';
    const roundsParam = params.get('rounds');
    const unlimited = roundsParam === 'unlimited';
    const rounds = [5, 10, 20].includes(Number(roundsParam)) ? Number(roundsParam) : 5;
    let loaded = false;

    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const medal = (n) => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[n] || n + '.');

    async function load() {
        loaded = true;
        document.getElementById('sbMode').textContent =
            `${difficulty[0].toUpperCase()}${difficulty.slice(1)} · ${rounds} rounds · all time`;
        const list = document.getElementById('sbList');
        const note = document.getElementById('sbNote');
        note.textContent = unlimited ? "Unlimited games aren't ranked. Showing the 5-round board." : '';
        try {
            const rows = await api.leaderboard(difficulty, rounds, 'all');
            list.innerHTML = rows && rows.length
                ? rows.slice(0, 10).map(r =>
                    `<li${r.is_me ? ' class="me"' : ''}><span class="sb-rank">${medal(Number(r.rank))}</span><span class="sb-name">${esc(r.username)}</span><span class="sb-score">${Number(r.score).toLocaleString()}</span></li>`).join('')
                : '<li class="sb-empty">No ranked scores yet. Verify your UM email on your account page to claim the top spot!</li>';
        } catch (e) {
            list.innerHTML = '<li class="sb-empty">Leaderboard unavailable right now.</li>';
        }
    }

    function sync() {
        box.hidden = !wide.matches;
        if (wide.matches && !loaded) load();   // only fetch when it's actually shown
    }
    wide.addEventListener('change', sync);
    document.addEventListener('umg:gamefinished', () => { if (wide.matches) load(); });
    sync();
})();
