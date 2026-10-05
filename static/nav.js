/* static/nav.js  -  mobile dropdown menu for the top nav (shared by every page) */
(function () {
    'use strict';
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
