/* static/lobby.js - friend lobbies (live Party + Duels).
   The server runs the game: this page polls lobby_state(), draws whatever it
   says, and sends guesses. Players ping each other over Realtime so changes
   show up instantly; the poll is the safety net. Times arrive as "ms from
   now", so nobody's clock has to be right. */
(function () {
    'use strict';

    const api = window.UMGApi;
    const Pins = window.UMGPins;
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const IS_TOUCH = window.matchMedia('(hover: none), (pointer: coarse)').matches;
    const SITE_URL = 'https://umanitobaguesser.ca';
    const CAMPUS_CENTER = [49.80877091322333, -97.13230173125407];
    const CAMPUS_BOUNDS = L.latLngBounds([49.790, -97.170], [49.826, -97.095]);
    const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const NICK_RE = /^[A-Za-z0-9_][A-Za-z0-9_ ]{0,14}[A-Za-z0-9_]$/;
    const NICK_KEY = 'umg_nick';
    const SESSION_KEY = 'umg_lobby';

    const ERRORS = {
        lobby_not_found: "There's no open lobby with that code. Check it and try again.",
        lobby_full: 'That lobby is full (8 players max).',
        lobby_started: 'That game has already started. Ask the host to start a new one.',
        nickname_taken: 'Someone is already using that nickname. Pick another one.',
        invalid_nickname: 'Nicknames are 2-16 letters, numbers, spaces or _.',
        nickname_not_allowed: "That nickname isn't allowed. Pick another one.",
        need_two_players: 'Duels need at least 2 players.',
        rate_limited: "You've made a lot of lobbies. Try again in a bit.",
        not_enough_locations: 'Not enough campus photos for that many rounds.',
        captcha_failed: "The bot check didn't work. Refresh and try again.",
        guest_sign_in_failed: "Couldn't connect to the game server. Refresh and try again."
    };
    const errText = (err) => ERRORS[err && err.message] || 'Something went wrong. Please try again.';

    const TIERS = [
        { max: 30,       kind: 'perfect', title: '🎯 Bullseye!',   sound: 'perfect' },
        { max: 200,      kind: 'win',     title: '🔥 Great guess!', sound: 'win' },
        { max: 600,      kind: 'ok',      title: '👍 Not bad',      sound: 'ok' },
        { max: Infinity, kind: 'far',     title: '📍 Way off',      sound: 'far' }
    ];

    // ---------- State ----------
    let lobbyId = null;
    let lobbyCode = null;
    let st = null;                // last lobby_state()
    let pollTimer = null;
    let polling = false;
    let lastPoll = 0;
    let chan = null;
    const clock = { round: 0, starts: 0, deadline: 0, next: 0 };   // performance.now() times
    let shownRound = 0;           // round whose photo is on screen
    let revealedRound = 0;        // round whose answer is drawn
    let pinLatLng = null;
    let myPin = null;
    let layers = [];
    let busy = false;
    let finalShown = false;
    let map = null;
    let finalMap = null;

    function sfx(name, delay) {
        if (!window.GameSounds) return;
        if (delay) setTimeout(() => window.GameSounds.play(name), delay);
        else window.GameSounds.play(name);
    }
    const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
    const me = () => st && st.players.find(p => p.seat === st.me);
    const active = () => (st ? st.players.filter(p => !p.left) : []);
    const isDuels = () => st && st.lobby.mode === 'duels';
    const nickOf = (seat) => { const p = st.players.find(x => x.seat === seat); return p ? p.nickname : '?'; };
    const colorOf = (seat) => { const p = st.players.find(x => x.seat === seat); return Pins.color(p ? p.color : 0); };

    function showError(id, text) {
        const el = $(id);
        el.textContent = text || '';
        el.hidden = !text;
    }

    function setSection(name) {
        $('lbEntry').hidden = name !== 'entry';
        $('lbWait').hidden = name !== 'wait';
        $('lbGame').hidden = name !== 'game';
        if (name === 'game') initMap();
    }

    // ---------- Segmented buttons ----------
    function segValue(id) { const b = $(id).querySelector('button.selected'); return b ? b.dataset.v : null; }
    function segSet(id, v, disabled) {
        $(id).querySelectorAll('button').forEach(b => {
            const on = b.dataset.v === String(v);
            b.classList.toggle('selected', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.disabled = !!disabled;
        });
    }

    const MODE_HELP = {
        party: 'Everyone plays the same photos. Highest total wins.',
        duels: 'Everyone starts with 6,000 HP. Each round you lose the gap to the best guess. Last one standing wins.'
    };

    // =====================================================================
    // Entry: create / join
    // =====================================================================
    function nickname() {
        const v = $('nickInput').value.replace(/\s+/g, ' ').trim();
        if (!NICK_RE.test(v)) {
            showError('entryError', ERRORS.invalid_nickname);
            $('nickInput').focus();
            return null;
        }
        try { localStorage.setItem(NICK_KEY, v); } catch (e) { /* fine */ }
        return v;
    }

    $('createMode').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        segSet('createMode', b.dataset.v);
        $('createHelp').textContent = MODE_HELP[b.dataset.v];
    });

    $('createBtn').addEventListener('click', async () => {
        showError('entryError');
        const nick = nickname();
        if (!nick || busy) return;
        busy = true;
        $('createBtn').disabled = true;
        try {
            enter(await api.lobby.create(nick, segValue('createMode') || 'party', 'medium', 5));
        } catch (err) {
            console.error(err);
            showError('entryError', errText(err));
        } finally {
            busy = false;
            $('createBtn').disabled = false;
        }
    });

    async function join(code, nick, quiet) {
        busy = true;
        $('joinBtn').disabled = true;
        try {
            enter(await api.lobby.join(code, nick));
        } catch (err) {
            if (!quiet) console.error(err);
            showError('entryError', errText(err));
            forget();
        } finally {
            busy = false;
            $('joinBtn').disabled = false;
        }
    }

    $('joinBtn').addEventListener('click', () => {
        showError('entryError');
        const code = $('codeInput').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) { showError('entryError', 'Lobby codes are 6 letters and numbers.'); $('codeInput').focus(); return; }
        const nick = nickname();
        if (nick && !busy) join(code, nick);
    });
    $('codeInput').addEventListener('input', () => {
        $('codeInput').value = $('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    [$('codeInput'), $('nickInput')].forEach(el => el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        ($('codeInput').value.length === 6 ? $('joinBtn') : $('createBtn')).click();
    }));

    function remember() {
        try { sessionStorage.setItem(SESSION_KEY, lobbyCode); } catch (e) { /* fine */ }
        history.replaceState(null, '', `./lobby.html?code=${lobbyCode}`);
    }
    function forget() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* fine */ }
    }

    async function enter(state) {
        lobbyId = state.lobby.id;
        lobbyCode = state.lobby.code;
        remember();
        render(state);
        schedulePoll();
        if (!chan) {
            try { chan = await api.lobby.channel(lobbyCode, pollSoon); } catch (e) { chan = null; /* polling still works */ }
        }
    }

    // Tell everyone else to refresh now (the server state is the truth)
    function ping() { if (chan) chan.ping(); }

    function leftLobby(message) {
        clearTimeout(pollTimer);
        if (chan) { chan.close(); chan = null; }
        lobbyId = lobbyCode = st = null;
        shownRound = revealedRound = 0;
        finalShown = false;
        closeFinal();
        forget();
        history.replaceState(null, '', './lobby.html');
        setSection('entry');
        showError('entryError', message || '');
    }

    async function leave() {
        if (!lobbyId) return;
        const id = lobbyId;
        try { await api.lobby.leave(id); ping(); } catch (e) { /* leaving anyway */ }
        leftLobby();
    }
    $('leaveBtn').addEventListener('click', leave);
    $('leaveGameBtn').addEventListener('click', () => {
        if (st && st.lobby.status === 'playing' && !window.confirm('Leave this game? You can rejoin with the code while it lasts.')) return;
        leave();
    });
    $('finalLeaveBtn').addEventListener('click', leave);

    // =====================================================================
    // Polling
    // =====================================================================
    function schedulePoll() {
        clearTimeout(pollTimer);
        if (!lobbyId) return;
        const playing = st && st.lobby.status === 'playing';
        pollTimer = setTimeout(poll, document.hidden ? 4000 : playing ? 1000 : 2000);
    }

    async function poll() {
        if (!lobbyId || polling) return;
        polling = true;
        lastPoll = performance.now();
        try {
            render(await api.lobby.state(lobbyId));
        } catch (err) {
            if (err && err.message === 'lobby_not_found') { polling = false; leftLobby('You are no longer in that lobby.'); return; }
            console.warn('lobby poll failed', err);
        }
        polling = false;
        schedulePoll();
    }

    // A ping, a timer hitting zero or the tab coming back: refresh soon (at most ~3x a second)
    function pollSoon() {
        if (!lobbyId || polling) return;
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, Math.max(0, 300 - (performance.now() - lastPoll)));
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSoon(); });

    // =====================================================================
    // Render
    // =====================================================================
    function render(s) {
        st = s;
        const status = s.lobby.status;
        if (status === 'closed') { leftLobby('That lobby has closed.'); return; }
        if (status === 'waiting') {
            if (finalShown || shownRound) {   // host started a rematch
                finalShown = false;
                shownRound = revealedRound = 0;
                closeFinal();
                clearLayers();
            }
            setSection('wait');
            renderWait();
            return;
        }
        setSection('game');
        renderGame();
        if (status === 'finished') renderFinal();
    }

    // ---------- Waiting room ----------
    function playerRow(p, opts) {
        const tags = [
            p.is_host ? '<span class="lp-tag host" title="Host">👑 Host</span>' : '',
            p.seat === st.me ? '<span class="lp-tag you">You</span>' : '',
            p.away ? '<span class="lp-tag away">Away</span>' : ''
        ].join('');
        const kick = opts && opts.kick && p.seat !== st.me
            ? `<button type="button" class="lp-kick" data-seat="${p.seat}" aria-label="Remove ${esc(p.nickname)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : '';
        return `<li style="--pin:${Pins.color(p.color)}"><span class="lp-dot" aria-hidden="true"></span>` +
               `<span class="lp-name">${esc(p.nickname)}</span>${tags}${kick}</li>`;
    }

    function renderWait() {
        const L0 = st.lobby;
        const players = active();
        $('codeBig').textContent = L0.code;
        $('playerCount').textContent = `${players.length} / 8`;
        $('waitPlayers').innerHTML = players.map(p => playerRow(p, { kick: st.is_host })).join('');

        const host = st.is_host;
        segSet('setMode', L0.mode, !host);
        segSet('setDiff', L0.difficulty, !host);
        segSet('setRounds', L0.rounds_planned, !host);
        $('roundsSetting').hidden = L0.mode === 'duels';
        $('modeHelp').textContent = MODE_HELP[L0.mode];

        const needTwo = L0.mode === 'duels' && players.length < 2;
        $('startBtn').hidden = !host;
        $('startBtn').disabled = needTwo;   // a click while a request is running is ignored by the handler
        $('waitNote').textContent = host
            ? (needTwo ? 'Duels need at least 2 players. Share the code!' : players.length < 2 ? 'Share the code with your friends, then press Start.' : 'Everyone in? Press Start.')
            : 'Waiting for the host to start the game…';
    }

    function onSetting(e) {
        const b = e.target.closest('button');
        if (!b || !st || !st.is_host || busy) return;
        const L0 = st.lobby;
        const next = {
            mode: e.currentTarget.id === 'setMode' ? b.dataset.v : L0.mode,
            diff: e.currentTarget.id === 'setDiff' ? b.dataset.v : L0.difficulty,
            rounds: e.currentTarget.id === 'setRounds' ? parseInt(b.dataset.v, 10) : L0.rounds_planned
        };
        busy = true;
        api.lobby.settings(lobbyId, next.mode, next.diff, next.rounds)
            .then(s => { ping(); render(s); })
            .catch(err => showError('waitError', errText(err)))
            .finally(() => { busy = false; });
    }
    ['setMode', 'setDiff', 'setRounds'].forEach(id => $(id).addEventListener('click', onSetting));

    $('waitPlayers').addEventListener('click', (e) => {
        const b = e.target.closest('.lp-kick');
        if (!b || busy) return;
        const seat = parseInt(b.dataset.seat, 10);
        if (!window.confirm(`Remove ${nickOf(seat)} from the lobby?`)) return;
        api.lobby.kick(lobbyId, seat).then(s => { ping(); render(s); }).catch(err => showError('waitError', errText(err)));
    });

    $('startBtn').addEventListener('click', () => {
        if (busy) return;
        showError('waitError');
        busy = true;
        $('startBtn').disabled = true;
        api.lobby.start(lobbyId)
            .then(s => { ping(); render(s); })
            .catch(err => showError('waitError', errText(err)))
            .finally(() => { busy = false; if (st && st.lobby.status === 'waiting') $('startBtn').disabled = false; });
    });

    function inviteLink() { return `${SITE_URL}/lobby.html?code=${lobbyCode}`; }
    async function copyInvite() {
        const link = inviteLink();
        try {
            if (IS_TOUCH && navigator.share) { await navigator.share({ title: 'UManitoba Guesser', text: `Join my UManitoba Guesser lobby: ${lobbyCode}`, url: link }); return; }
        } catch (e) { if (e.name === 'AbortError') return; }
        try {
            await navigator.clipboard.writeText(link);
            const btn = $('copyLinkBtn');
            const old = btn.innerHTML;
            btn.textContent = 'Link copied!';
            setTimeout(() => { btn.innerHTML = old; }, 1800);
        } catch (e) {
            window.prompt('Copy this invite link:', link);
        }
    }
    $('copyLinkBtn').addEventListener('click', copyInvite);
    $('codeBig').addEventListener('click', copyInvite);

    // =====================================================================
    // The game
    // =====================================================================
    function initMap() {
        if (map) { map.invalidateSize(); return; }
        map = L.map('map', { maxBounds: CAMPUS_BOUNDS, maxBoundsViscosity: 0.9, minZoom: 14 }).setView(CAMPUS_CENTER, 17);
        L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
        map.on('click', onMapClick);
    }

    function clearLayers() {
        layers.forEach(l => map && map.removeLayer(l));
        layers = [];
        if (myPin && map) map.removeLayer(myPin);
        myPin = null;
        pinLatLng = null;
    }

    function syncClock(r) {
        const t = performance.now();
        const deadline = t + r.remaining_ms;
        // Ignore small network jitter so the countdown doesn't jump around
        if (clock.round !== r.round_no || Math.abs(deadline - clock.deadline) > 700) clock.deadline = deadline;
        clock.starts = t + r.starts_in_ms;
        clock.next = r.next_in_ms != null ? t + r.next_in_ms : 0;
        clock.round = r.round_no;
    }

    function setHint(text) {
        const el = $('roundResult');
        el.className = 'round-result hint';
        el.textContent = text;
    }

    function renderGame() {
        const r = st.round;
        if (!r) return;
        const L0 = st.lobby;
        if (r.round_no !== shownRound) newRound(r);
        syncClock(r);

        const mult = isDuels() && r.multiplier > 1 ? ` · ×${Number(r.multiplier)} DAMAGE` : '';
        $('roundHeader').textContent = isDuels() ? `ROUND ${r.round_no}${mult}` : `ROUND ${r.round_no} / ${L0.rounds_planned}`;
        $('sideMode').textContent = `${isDuels() ? '⚔️ Duels' : '🎉 Party'} · ${L0.time_limit_s}s timer · code ${L0.code}`;

        // Back after a refresh: put my locked-in pin back
        if (r.my_guess && !myPin && !r.resolved) placePin(L.latLng(r.my_guess.lat, r.my_guess.lng), true);

        if (r.resolved && revealedRound !== r.round_no) reveal();
        renderScoreboard();
        renderButtons();
        tick();
    }

    function newRound(r) {
        shownRound = r.round_no;
        clearLayers();
        map.setView(CAMPUS_CENTER, 17, { animate: false });
        const wrap = $('photoWrap');
        const img = $('locationImg');
        wrap.classList.add('loading');
        img.onload = () => wrap.classList.remove('loading');
        img.onerror = () => { wrap.classList.remove('loading'); setHint('⚠️ This photo failed to load. Try refreshing the page.'); };
        img.src = `./${r.photo}`;
        if (img.complete && img.naturalWidth > 0) wrap.classList.remove('loading');
        const m = me();
        setHint(isDuels() && m && m.hp <= 0
            ? "💀 You're out of HP. Watch the others battle it out!"
            : r.starts_in_ms > 0 ? 'Get ready…' : (IS_TOUCH ? 'Tap the map to drop your pin.' : 'Click the map to drop your pin.'));
        if (r.round_no > 1) sfx('next');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function canGuess() {
        const r = st && st.round;
        const m = me();
        if (!r || st.lobby.status !== 'playing' || r.resolved || r.my_guess || busy) return false;
        if (isDuels() && m && m.hp <= 0) return false;
        const t = performance.now();
        return t >= clock.starts && t < clock.deadline;
    }

    function placePin(latlng, locked) {
        pinLatLng = latlng;
        const m = me();
        const icon = Pins.guess(Pins.color(m ? m.color : 0));
        if (myPin) myPin.setLatLng(latlng);
        else myPin = L.marker(latlng, { icon, interactive: false }).addTo(map);
        if (locked) myPin.getElement() && myPin.getElement().classList.add('locked');
    }

    function onMapClick(e) {
        if (!canGuess()) return;
        placePin(e.latlng);
        setHint('Pin placed. Press Guess (or Enter) to lock it in.');
        sfx('pin');
        renderButtons();
    }

    function submitGuess() {
        if (!pinLatLng || !canGuess()) return;
        busy = true;
        renderButtons();
        api.lobby.guess(lobbyId, pinLatLng.lat, pinLatLng.lng)
            .then(s => {
                busy = false;
                sfx('lock');
                ping();
                render(s);
                if (!s.round.resolved) setHint('🔒 Locked in. Waiting for everyone else…');
            })
            .catch(err => {
                busy = false;
                if (err && (err.message === 'round_closed' || err.message === 'already_guessed')) setHint("⏰ Too late! Time ran out before your guess arrived.");
                else { console.error(err); setHint('⚠️ Couldn’t send your guess. Try again.'); }
                renderButtons();
                pollSoon();
            });
    }

    function renderButtons() {
        if (!st || !st.round) return;
        const r = st.round;
        const g = $('guessButton');
        const n = $('nextButton');
        const done = st.lobby.status === 'finished';
        if (r.resolved) {
            g.hidden = true;
            n.hidden = false;
            n.disabled = !st.is_host || busy;
            n.textContent = done ? 'See results' : st.is_host ? 'Next round' : 'Next round soon…';
            if (done) n.disabled = false;
        } else {
            g.hidden = false;
            n.hidden = true;
            g.disabled = !(pinLatLng && canGuess());
            g.textContent = r.my_guess ? 'Locked in ✓' : 'Guess';
        }
        const m = me();
        if (m) {
            $('score').textContent = isDuels() ? `HP: ${m.hp.toLocaleString()} ❤️` : `Score: ${m.total_score.toLocaleString()} 🦬`;
            const place = standings().findIndex(p => p.seat === m.seat) + 1;
            $('scoreSub').textContent = `${ordinal(place)} of ${active().length}`;
        }
    }

    $('guessButton').addEventListener('click', submitGuess);
    $('nextButton').addEventListener('click', () => {
        if (st.lobby.status === 'finished') { openFinal(); return; }
        if (!st.is_host || busy) return;
        busy = true;
        api.lobby.next(lobbyId)
            .then(s => { ping(); render(s); })
            .catch(() => pollSoon())
            .finally(() => { busy = false; renderButtons(); });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || $('lbGame').hidden) return;
        if (!$('finalModal').classList.contains('hidden')) return;
        const viewer = $('photoViewer');
        if (viewer && !viewer.classList.contains('hidden')) return;
        if (document.activeElement && ['BUTTON', 'A', 'INPUT'].includes(document.activeElement.tagName)) return;
        if (!$('guessButton').hidden && !$('guessButton').disabled) submitGuess();
        else if (!$('nextButton').hidden && !$('nextButton').disabled) $('nextButton').click();
    });

    // Answer + everyone's pins, joined by lines
    function reveal() {
        const r = st.round;
        revealedRound = r.round_no;
        if (myPin) { map.removeLayer(myPin); myPin = null; }
        pinLatLng = null;
        const answer = L.latLng(r.answer.lat, r.answer.lng);
        const pts = [answer];
        layers.push(L.marker(answer, { icon: Pins.answer(34), interactive: false, zIndexOffset: 1000 }).addTo(map));
        r.guesses.forEach(g => {
            if (g.lat == null) return;
            const at = L.latLng(g.lat, g.lng);
            const color = colorOf(g.seat);
            layers.push(L.polyline([at, answer], { color, weight: 3, opacity: 0.8, dashArray: '5, 8' }).addTo(map));
            layers.push(L.marker(at, { icon: Pins.guess(color, 30, nickOf(g.seat)), interactive: false }).addTo(map));
            pts.push(at);
        });
        map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 18 });

        const mine = r.guesses.find(g => g.seat === st.me);
        const el = $('roundResult');
        const best = r.guesses[0];
        const winner = best && best.score > 0 ? `${best.seat === st.me ? 'You' : esc(nickOf(best.seat))} won the round` : 'Nobody scored';
        if (!mine) {
            el.className = 'round-result rr-timeout';
            el.innerHTML = `<span class="rr-title">👀 Spectating</span><span class="rr-detail">${winner}</span><span class="rr-pts"></span>`;
            return;
        }
        if (mine.lat == null) {
            el.className = 'round-result rr-timeout';
            el.innerHTML = `<span class="rr-title">⏰ No guess</span><span class="rr-detail">${winner}</span>` +
                `<span class="rr-pts">${isDuels() && mine.damage ? `−${mine.damage.toLocaleString()} HP` : '+0'}</span>`;
            sfx('timeout');
            return;
        }
        const tier = TIERS.find(t => mine.distance_m < t.max);
        el.className = `round-result rr-${tier.kind}`;
        el.innerHTML = `<span class="rr-title">${tier.title}</span>` +
            `<span class="rr-detail">${fmtDist(mine.distance_m)} away · ${winner}</span>` +
            `<span class="rr-pts">${isDuels() ? (mine.damage ? `−${mine.damage.toLocaleString()} HP` : 'No damage!') : `+${mine.score.toLocaleString()}`}</span>`;
        sfx(tier.sound, 120);
    }

    // ---------- Scoreboard ----------
    function standings() {
        return active().slice().sort((a, b) => isDuels()
            ? (b.hp - a.hp) || (b.total_score - a.total_score) || (a.seat - b.seat)
            : (b.total_score - a.total_score) || (a.seat - b.seat));
    }
    function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

    function renderScoreboard() {
        const r = st.round;
        const byRound = {};
        if (r && r.resolved && r.guesses) r.guesses.forEach(g => { byRound[g.seat] = g; });
        // Two lines per player: name + total, then this round's status (and HP bar in Duels)
        const list = standings().map((p, i) => {
            const out = isDuels() && p.hp <= 0;
            let status = '';
            if (out) status = '<span class="ls-st out">Knocked out</span>';
            else if (r && !r.resolved) status = p.guessed ? '<span class="ls-st ok">✓ Guessed</span>' : `<span class="ls-st wait">${p.away ? 'Away' : 'Guessing…'}</span>`;
            else if (byRound[p.seat]) {
                const g = byRound[p.seat];
                status = isDuels()
                    ? `<span class="ls-st ${g.damage ? 'hit' : 'ok'}">${g.damage ? '−' + g.damage.toLocaleString() + ' HP' : 'Round winner'}</span>`
                    : `<span class="ls-st ok">+${g.score.toLocaleString()} this round</span>`;
            }
            const hp = isDuels()
                ? `<span class="ls-hp" title="${p.hp.toLocaleString()} HP"><span style="width:${Math.max(0, p.hp / st.lobby.max_hp * 100)}%"></span></span>` : '';
            return `<li class="${p.seat === st.me ? 'me' : ''}${out ? ' out' : ''}" style="--pin:${Pins.color(p.color)}">` +
                   `<span class="ls-rank">${i + 1}</span><span class="lp-dot" aria-hidden="true"></span>` +
                   `<span class="ls-main"><span class="ls-name">${esc(p.nickname)}${p.is_host ? ' <span title="Host">👑</span>' : ''}</span>${status}${hp}</span>` +
                   `<span class="ls-num">${(isDuels() ? p.hp : p.total_score).toLocaleString()}</span></li>`;
        });
        $('gamePlayers').innerHTML = list.join('');
        $('sideTitle').textContent = isDuels() ? 'Health' : 'Scoreboard';
    }

    // ---------- Clock (4x a second) ----------
    function tick() {
        if (!st || !st.round || $('lbGame').hidden) return;
        const r = st.round;
        const t = performance.now();
        const limitMs = st.lobby.time_limit_s * 1000;
        const startsIn = clock.starts - t;
        const counting = startsIn > 0 && !r.resolved;

        $('getReady').hidden = !counting;
        $('photoWrap').classList.toggle('lb-wait', counting);
        if (counting) $('getReadyNum').textContent = String(Math.ceil(startsIn / 1000));
        else if ($('roundResult').textContent === 'Get ready…') setHint(IS_TOUCH ? 'Tap the map to drop your pin.' : 'Click the map to drop your pin.');

        const rem = r.resolved ? 0 : Math.max(0, Math.min(limitMs, clock.deadline - Math.max(t, clock.starts)));
        const secs = Math.ceil(rem / 1000);
        $('timer').textContent = r.resolved
            ? (st.lobby.status === 'playing' && clock.next ? `Next in ${Math.max(0, Math.ceil((clock.next - t) / 1000))}s` : 'Round over')
            : `${secs}s`;
        // During the reveal the bar drains toward the next round instead
        const nextLeft = r.resolved && st.lobby.status === 'playing' && clock.next ? Math.max(0, clock.next - t) : null;
        $('timerBar').style.width = `${nextLeft !== null ? Math.min(100, nextLeft / 9000 * 100) : (rem / limitMs) * 100}%`;
        $('timerWrap').classList.toggle('low', !r.resolved && !counting && secs <= 5);

        // A placed pin locks itself in just before time runs out
        if (!r.resolved && pinLatLng && !r.my_guess && !busy && rem > 0 && rem < 700 && !counting) submitGuess();
        // Time's up, or the reveal is over: ask the server what's next
        if (!r.resolved && !counting && rem <= 0) pollSoon();
        if (r.resolved && st.lobby.status === 'playing' && clock.next && t >= clock.next) pollSoon();
        if (!r.resolved) $('guessButton').disabled = !(pinLatLng && canGuess());
    }
    setInterval(tick, 250);

    // =====================================================================
    // Final standings
    // =====================================================================
    function renderFinal() {
        if (finalShown) { renderFinalButtons(); return; }
        finalShown = true;
        const order = standings();
        const top = order[0];
        const mine = me();
        const iWon = top && mine && top.seat === mine.seat;
        $('finalTitle').textContent = !top ? 'Game over' : iWon ? '🏆 You win!' : `🏆 ${top.nickname} wins!`;
        const place = mine ? order.findIndex(p => p.seat === mine.seat) + 1 : 0;
        $('finalSub').textContent = isDuels()
            ? `Last bison standing after ${st.lobby.round_no} round${st.lobby.round_no === 1 ? '' : 's'}${place ? ` · you came ${ordinal(place)}` : ''}`
            : `${st.lobby.round_no} round${st.lobby.round_no === 1 ? '' : 's'}${place ? ` · you came ${ordinal(place)} of ${order.length}` : ''}`;
        $('finalList').innerHTML = order.map((p, i) =>
            `<li class="${p.seat === st.me ? 'me' : ''}" style="--pin:${Pins.color(p.color)}">` +
            `<span class="rl-sq">${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'}</span>` +
            `<span class="rl-round"><span class="lp-dot" aria-hidden="true"></span> ${esc(p.nickname)}</span>` +
            `<span class="rl-dist">${isDuels() ? `${p.hp.toLocaleString()} HP` : ''}</span>` +
            `<span class="rl-pts">${p.total_score.toLocaleString()}</span></li>`).join('');
        renderFinalButtons();
        sfx('gameover', 400);
        // Let the last round's reveal sink in first
        setTimeout(() => { if (st && st.lobby.status === 'finished') openFinal(); }, 2200);
    }

    function renderFinalButtons() {
        $('againBtn').disabled = !st.is_host;
        $('againBtn').textContent = st.is_host ? 'Play again' : 'Waiting for host…';
    }

    function openFinal() {
        $('finalModal').classList.remove('hidden');
        setTimeout(drawFinalMap, 30);   // Leaflet needs the box visible to size it
    }
    function closeFinal() { $('finalModal').classList.add('hidden'); }
    $('closeFinal').addEventListener('click', closeFinal);
    $('finalModal').addEventListener('click', (e) => { if (e.target === $('finalModal')) closeFinal(); });

    function drawFinalMap() {
        if (!st || !st.history) return;
        if (!finalMap) {
            finalMap = L.map('finalMap', { zoomControl: false, scrollWheelZoom: false });
            L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(finalMap);
        }
        finalMap.eachLayer(l => { if (!(l instanceof L.TileLayer)) finalMap.removeLayer(l); });
        finalMap.invalidateSize();
        const pts = [];
        st.history.forEach(h => {
            const a = L.latLng(h.answer.lat, h.answer.lng);
            pts.push(a);
            L.marker(a, { icon: Pins.answer(24), interactive: false }).addTo(finalMap);
            h.guesses.forEach(g => {
                if (g.lat == null) return;
                const at = L.latLng(g.lat, g.lng);
                const color = colorOf(g.seat);
                L.polyline([at, a], { color, weight: 2, opacity: 0.75, dashArray: '4, 6' }).addTo(finalMap);
                L.marker(at, { icon: Pins.guess(color, 20), interactive: false }).addTo(finalMap);
                pts.push(at);
            });
        });
        if (pts.length) finalMap.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 17 });
        else finalMap.setView(CAMPUS_CENTER, 15);
    }

    $('againBtn').addEventListener('click', () => {
        if (!st || !st.is_host || busy) return;
        busy = true;
        api.lobby.reset(lobbyId)
            .then(s => { ping(); render(s); })
            .catch(err => { console.error(err); pollSoon(); })
            .finally(() => { busy = false; });
    });

    $('shareBtn').addEventListener('click', async () => {
        if (!st) return;
        const order = standings();
        const mine = me();
        const place = mine ? order.findIndex(p => p.seat === mine.seat) + 1 : 0;
        const medal = ['🥇', '🥈', '🥉'][place - 1] || '🦬';
        const text = `UManitoba Guesser ${isDuels() ? '⚔️ Duels' : '🎉 Party'} 🦬\n` +
            `${medal} ${ordinal(place)} of ${order.length} · ${mine ? mine.total_score.toLocaleString() : 0} pts\n` +
            `Think you know campus? Play with friends: ${SITE_URL}/lobby.html`;
        try {
            if (navigator.share) { await navigator.share({ title: 'UManitoba Guesser', text }); return; }
        } catch (e) { if (e.name === 'AbortError') return; }
        try {
            await navigator.clipboard.writeText(text);
            const btn = $('shareBtn');
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Share'; }, 1800);
        } catch (e) { window.prompt('Copy your result:', text); }
    });

    // =====================================================================
    // Start-up
    // =====================================================================
    async function init() {
        if (!api || !api.enabled) {
            showError('entryError', 'Lobbies are offline for maintenance. Please try again soon.');
            $('createBtn').disabled = $('joinBtn').disabled = true;
            return;
        }
        let saved = '';
        try { saved = localStorage.getItem(NICK_KEY) || ''; } catch (e) { /* fine */ }
        $('nickInput').value = saved;
        $('createHelp').textContent = MODE_HELP.party;

        const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        if (code) $('codeInput').value = code;

        // Signed-in players: default the nickname to their username
        if (!saved && api.auth) {
            api.auth.profile().then(p => { if (p && p.username && !$('nickInput').value) $('nickInput').value = p.username.slice(0, 16); }).catch(() => {});
        }

        // Refreshed mid-game: rejoin silently
        let was = null;
        try { was = sessionStorage.getItem(SESSION_KEY); } catch (e) { /* fine */ }
        if (code && was === code && NICK_RE.test(saved)) { join(code, saved, true); return; }
        (code ? $('nickInput').value ? $('joinBtn') : $('nickInput') : $('nickInput')).focus();
    }
    init();
})();
