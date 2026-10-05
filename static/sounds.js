/* static/sounds.js
   Sound effects generated with the Web Audio API (no audio files needed).
   Usage: GameSounds.play('pin' | 'lock' | 'perfect' | 'win' | 'ok' | 'far' | 'timeout' | 'gameover' | 'next') */
(function () {
    let ctx = null;
    let master = null;
    let muted = false;

    try { muted = localStorage.getItem('muted') === 'true'; } catch (e) {}

    function ensureCtx() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
            master = ctx.createGain();
            master.gain.value = 0.35;
            master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    // One note: frequency, start offset (s), duration (s), wave type, volume, optional end frequency
    function tone(freq, start, dur, type = 'sine', vol = 0.6, endFreq = null) {
        const t0 = ctx.currentTime + start;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
    }

    // Short burst of filtered noise (used for the "thud" of a pin landing)
    function thud(start, dur, vol = 0.5) {
        const t0 = ctx.currentTime + start;
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 500;
        const g = ctx.createGain();
        g.gain.value = vol;
        src.connect(filter);
        filter.connect(g);
        g.connect(master);
        src.start(t0);
    }

    const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E6 = 1318.5, G6 = 1568;

    const sounds = {
        // Pin lands on the map
        pin() {
            tone(640, 0, 0.14, 'sine', 0.7, 220);
            thud(0, 0.08, 0.45);
        },
        // Guess locked in
        lock() {
            tone(392, 0, 0.09, 'triangle', 0.5);
            tone(523.25, 0.08, 0.14, 'triangle', 0.5);
        },
        // Within ~50 m: big celebration
        perfect() {
            [C5, E5, G5, C6, E6, G6].forEach((f, i) => tone(f, i * 0.085, 0.3, 'triangle', 0.55));
            tone(C6, 0.55, 0.7, 'sine', 0.45);
            tone(E6, 0.55, 0.7, 'sine', 0.35);
            tone(G6, 0.55, 0.7, 'sine', 0.3);
        },
        // Close guess (under 1 km)
        win() {
            [C5, E5, G5, C6].forEach((f, i) => tone(f, i * 0.09, 0.28, 'triangle', 0.55));
            tone(C6, 0.4, 0.45, 'sine', 0.4);
        },
        // Middling guess
        ok() {
            tone(E5, 0, 0.18, 'triangle', 0.5);
            tone(G5, 0.12, 0.3, 'triangle', 0.5);
        },
        // Far away: soft descending "womp"
        far() {
            tone(300, 0, 0.22, 'sine', 0.55, 200);
            tone(220, 0.2, 0.35, 'sine', 0.55, 130);
        },
        // Out of time
        timeout() {
            tone(220, 0, 0.18, 'sawtooth', 0.28);
            tone(185, 0.18, 0.18, 'sawtooth', 0.28);
            tone(147, 0.36, 0.45, 'sawtooth', 0.28);
        },
        // Game finished
        gameover() {
            const seq = [[C5, 0], [C5, 0.14], [C5, 0.28], [G5, 0.42], [E5, 0.62], [G5, 0.8], [C6, 1.0]];
            seq.forEach(([f, t]) => tone(f, t, 0.3, 'triangle', 0.55));
            [C5, E5, G5, C6].forEach(f => tone(f, 1.0, 1.0, 'sine', 0.3));
        },
        // Moving to the next round
        next() {
            tone(587.33, 0, 0.07, 'sine', 0.35);
        }
    };

    window.GameSounds = {
        play(name) {
            if (muted || !sounds[name]) return;
            if (!ensureCtx()) return;
            try { sounds[name](); } catch (e) { /* never let audio break the game */ }
        },
        isMuted() { return muted; },
        setMuted(value) {
            muted = !!value;
            try { localStorage.setItem('muted', String(muted)); } catch (e) {}
            updateIcon();
            if (!muted) this.play('next'); // confirmation blip when unmuting
        },
        toggle() { this.setMuted(!muted); }
    };

    function updateIcon() {
        const icon = document.getElementById('soundIcon');
        const btn = document.getElementById('soundToggle');
        if (icon) icon.className = muted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
        if (btn) {
            btn.setAttribute('aria-pressed', String(muted));
            btn.title = muted ? 'Sound off (click to turn on)' : 'Sound on (click to mute)';
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('soundToggle');
        if (btn) btn.addEventListener('click', () => window.GameSounds.toggle());
        updateIcon();
    });
})();
