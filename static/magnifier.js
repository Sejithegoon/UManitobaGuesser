/* static/magnifier.js
   Desktop: hover lens over the location photo (toggle with the magnifier button).
   Everywhere: fullscreen viewer with wheel / pinch zoom, drag to pan, double-tap to zoom.
   On touch devices, tapping the photo opens the viewer. */
(function () {
    const wrap = document.getElementById('photoWrap');
    const img = document.getElementById('locationImg');
    const lens = document.getElementById('magLens');
    const toggleBtn = document.getElementById('magToggle');
    const expandBtn = document.getElementById('expandBtn');
    const hint = document.getElementById('photoHint');

    const viewer = document.getElementById('photoViewer');
    const stage = document.getElementById('viewerStage');
    const vImg = document.getElementById('viewerImg');

    if (!wrap || !img || !viewer) return;

    const LENS_ZOOM = 2.5;
    const isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches;
    let lensEnabled = true;

    /* ---------- Hover lens (desktop) ---------- */
    function lensSize() { return lens.offsetWidth || 180; }

    function moveLens(e) {
        if (!lensEnabled || isTouch) return;
        const rect = img.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
            lens.classList.remove('active');
            return;
        }
        const size = lensSize();
        lens.style.backgroundImage = `url("${img.currentSrc || img.src}")`;
        lens.style.backgroundSize = `${rect.width * LENS_ZOOM}px ${rect.height * LENS_ZOOM}px`;
        lens.style.backgroundPosition = `${-(x * LENS_ZOOM - size / 2)}px ${-(y * LENS_ZOOM - size / 2)}px`;
        lens.style.left = `${x - size / 2 + (img.offsetLeft || 0)}px`;
        lens.style.top = `${y - size / 2 + (img.offsetTop || 0)}px`;
        lens.classList.add('active');
    }

    function setLens(on) {
        lensEnabled = on;
        toggleBtn.setAttribute('aria-pressed', String(on));
        wrap.classList.toggle('lens-on', on && !isTouch);
        if (!on) lens.classList.remove('active');
        updateHint();
    }

    function updateHint() {
        if (isTouch) hint.textContent = 'Tap the photo to zoom in.';
        else hint.textContent = lensEnabled
            ? 'Hover over the photo to magnify. Click the expand button for full size.'
            : 'Magnifier is off. Click the expand button for full size.';
    }

    if (isTouch) {
        wrap.classList.add('touch-mode');
        toggleBtn.style.display = 'none';
    } else {
        wrap.addEventListener('mousemove', moveLens);
        wrap.addEventListener('mouseleave', () => lens.classList.remove('active'));
        toggleBtn.addEventListener('click', () => setLens(!lensEnabled));
        setLens(true);
    }
    updateHint();

    /* ---------- Fullscreen viewer ---------- */
    let scale = 1, tx = 0, ty = 0;
    const MIN = 1, MAX = 6;
    const pointers = new Map();
    let lastDist = 0, lastMid = null, lastTap = 0, moved = false;

    function apply() {
        vImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    }

    function clampPan() {
        if (scale <= 1) { tx = 0; ty = 0; return; }
        const r = vImg.getBoundingClientRect();
        const baseW = r.width / scale, baseH = r.height / scale;
        const sr = stage.getBoundingClientRect();
        const maxX = Math.max(0, (baseW * scale - sr.width) / 2);
        const maxY = Math.max(0, (baseH * scale - sr.height) / 2);
        tx = Math.min(maxX, Math.max(-maxX, tx));
        ty = Math.min(maxY, Math.max(-maxY, ty));
    }

    function setScale(next, cx, cy) {
        next = Math.min(MAX, Math.max(MIN, next));
        if (cx !== undefined) {
            // keep the point under the cursor/fingers fixed
            const sr = stage.getBoundingClientRect();
            const ox = cx - (sr.left + sr.width / 2);
            const oy = cy - (sr.top + sr.height / 2);
            const k = next / scale;
            tx = ox - (ox - tx) * k;
            ty = oy - (oy - ty) * k;
        }
        scale = next;
        clampPan();
        apply();
    }

    function resetView() { scale = 1; tx = 0; ty = 0; apply(); }

    function openViewer() {
        vImg.src = img.currentSrc || img.src;
        resetView();
        viewer.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeViewer() {
        viewer.classList.add('hidden');
        document.body.style.overflow = '';
        pointers.clear();
    }

    expandBtn.addEventListener('click', openViewer);
    if (isTouch) {
        img.addEventListener('click', openViewer);
    }
    document.getElementById('vClose').addEventListener('click', closeViewer);
    document.getElementById('vReset').addEventListener('click', resetView);
    document.getElementById('vZoomIn').addEventListener('click', () => {
        const r = stage.getBoundingClientRect();
        setScale(scale * 1.5, r.left + r.width / 2, r.top + r.height / 2);
    });
    document.getElementById('vZoomOut').addEventListener('click', () => {
        const r = stage.getBoundingClientRect();
        setScale(scale / 1.5, r.left + r.width / 2, r.top + r.height / 2);
    });

    document.addEventListener('keydown', (e) => {
        if (viewer.classList.contains('hidden')) return;
        if (e.key === 'Escape') closeViewer();
        if (e.key === '+' || e.key === '=') document.getElementById('vZoomIn').click();
        if (e.key === '-') document.getElementById('vZoomOut').click();
    });

    // Click on the dark backdrop (not the photo) closes at 1x
    stage.addEventListener('click', (e) => {
        if (e.target === stage && scale === 1 && !moved) closeViewer();
    });

    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        setScale(scale * factor, e.clientX, e.clientY);
    }, { passive: false });

    stage.addEventListener('pointerdown', (e) => {
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = false;
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            lastDist = Math.hypot(a.x - b.x, a.y - b.y);
            lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
        stage.classList.add('dragging');
    });

    stage.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        const prev = pointers.get(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 1) {
            const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
            if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
            if (scale > 1) {
                tx += dx; ty += dy;
                clampPan();
                apply();
            }
        } else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            moved = true;
            if (lastDist > 0) setScale(scale * (dist / lastDist), mid.x, mid.y);
            if (lastMid && scale > 1) {
                tx += mid.x - lastMid.x;
                ty += mid.y - lastMid.y;
                clampPan();
                apply();
            }
            lastDist = dist;
            lastMid = mid;
        }
    });

    function endPointer(e) {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) { lastDist = 0; lastMid = null; }
        if (pointers.size === 0) {
            stage.classList.remove('dragging');
            // double-tap / double-click toggles zoom
            if (!moved && e.target === vImg) {
                const now = Date.now();
                if (now - lastTap < 300) {
                    if (scale > 1) resetView();
                    else setScale(2.5, e.clientX, e.clientY);
                    lastTap = 0;
                } else {
                    lastTap = now;
                }
            }
        }
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
})();
