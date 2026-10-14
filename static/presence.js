/* static/presence.js - live "N online / N playing now" plus registered-player count.
   Fills any element with data-online / data-playing / data-registered.
   Anonymous: no names or IDs are shared. Never affects the game. */
(function () {
    'use strict';
    const api = window.UMGApi;
    const cfg = window.UMG_CONFIG || {};
    if (!api || cfg.presence === false) return;

    const fill = (attr, text) => document.querySelectorAll(`[${attr}]`).forEach(el => {
        el.textContent = text;
        const wrap = el.closest('[data-live]');
        if (wrap) wrap.hidden = false;
    });
    const fmt = (n, one, many) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
    const playing = document.body.dataset.page === 'play';

    function start() {
        api.watchOnline(({ online, playing: inGame }) => {
            fill('data-online', fmt(online, 'player online', 'players online'));
            fill('data-playing', fmt(inGame, 'playing now', 'playing now'));
        }, playing).catch(() => { /* realtime unavailable: just stay hidden */ });

        api.siteStats().then(s => {
            fill('data-registered', fmt(s.registered_players, 'registered player', 'registered players'));
        }).catch(() => {});
    }

    // Don't compete with the page's first paint
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 800);
})();
