/* static/visit.js - adds one to the site's all-time visit counter, once per
   browser session. Sends nothing about the visitor: it's a bare "+1" (no
   cookies, no ids, no page names). Needs config.js loaded first. */
(function () {
    'use strict';
    const cfg = window.UMG_CONFIG;
    if (!cfg || !cfg.supabaseUrl || cfg.visitCounter === false) return;
    // Search engines and link previews aren't visitors
    if (navigator.webdriver || /bot|crawl|spider|slurp|preview|lighthouse|headless/i.test(navigator.userAgent)) return;
    try {
        if (sessionStorage.getItem('umg_visit')) return;
        sessionStorage.setItem('umg_visit', '1');
    } catch (e) { return; }   // storage blocked: skip rather than count every page

    const send = () => fetch(`${cfg.supabaseUrl}/rest/v1/rpc/track_visit`, {
        method: 'POST',
        keepalive: true,
        headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
        body: '{}'
    }).catch(() => { /* offline: not worth retrying */ });

    if ('requestIdleCallback' in window) requestIdleCallback(send, { timeout: 4000 });
    else setTimeout(send, 1500);
})();
