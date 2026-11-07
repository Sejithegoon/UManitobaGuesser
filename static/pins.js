/* static/pins.js - map pins shared by the solo game, the results map and lobbies.
   Guess pins are drawn in a colour (one per lobby player) and their tip is the
   exact spot that gets scored. The answer pin is the bison. */
(function () {
    'use strict';

    // Pin colour per lobby seat colour (0-7). Distinct on the light OSM map.
    const COLORS = ['#e6a10b', '#1d6fd9', '#e0457b', '#16a34a', '#8b5cf6', '#ea580c', '#0891b2', '#b91c1c'];
    const PATH = 'M0 188.6C0 84.4 86 0 192 0S384 84.4 384 188.6c0 119.3-120.2 262.3-170.4 316.8-11.8 12.8-31.5 12.8-43.3 0-50.2-54.5-170.4-197.5-170.4-316.8z';
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function guess(color, size, label) {
        size = size || 34;
        const w = Math.round(size * 0.8), h = size;
        return L.divIcon({
            className: 'pin-marker pin-color',
            html: `<svg viewBox="-24 -24 432 560" width="${w}" height="${h}" aria-hidden="true">` +
                  `<path d="${PATH}" fill="${color}" stroke="#fff" stroke-width="30"/>` +
                  `<circle cx="192" cy="188" r="66" fill="#fff"/></svg>` +
                  (label ? `<span class="pin-label" style="--pin:${color}">${esc(label)}</span>` : ''),
            iconSize: [w, h],
            iconAnchor: [w / 2, h - 1]
        });
    }

    function answer(size) {
        size = size || 34;
        return L.divIcon({
            className: 'pin-marker',
            html: '<img src="./assets/pin3.webp" alt="">',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
    }

    window.UMGPins = { COLORS, color: (i) => COLORS[((i % 8) + 8) % 8], guess, answer };
})();
