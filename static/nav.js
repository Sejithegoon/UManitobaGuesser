/* static/nav.js  -  shared by every page: mobile dropdown menu + smooth theme switch */
(function () {
    'use strict';
    const root = document.documentElement;

    // ---------- Theme toggle polish (the toggle itself is each page's toggleTheme()) ----------
    let themeTimer;
    document.querySelectorAll('.theme-toggle[onclick]').forEach(btn => {
        btn.addEventListener('click', () => {
            // Fade colours across the whole page for a moment, then remove so it never slows normal use
            root.classList.add('theme-anim');
            clearTimeout(themeTimer);
            themeTimer = setTimeout(() => root.classList.remove('theme-anim'), 450);

            const icon = btn.querySelector('i');
            if (icon) {
                icon.classList.remove('spin');
                void icon.offsetWidth;          // restart the animation
                icon.classList.add('spin');
                icon.addEventListener('animationend', () => icon.classList.remove('spin'), { once: true });
            }
        });
    });

    // ---------- Mobile dropdown ----------
    const nav = document.getElementById('siteNav');
    const btn = document.getElementById('menuToggle');
    if (!nav || !btn) return;
    const icon = btn.querySelector('i');

    function setOpen(open) {
        nav.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
        btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        if (icon) icon.className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
    }

    btn.addEventListener('click', () => setOpen(!nav.classList.contains('open')));

    // Close when a link is picked, when tapping outside, on Escape, or when the screen gets wide
    nav.querySelectorAll('.links a').forEach(a => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('click', e => { if (!nav.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && nav.classList.contains('open')) { setOpen(false); btn.focus(); }
    });
    window.matchMedia('(min-width: 769px)').addEventListener('change', e => { if (e.matches) setOpen(false); });
})();
