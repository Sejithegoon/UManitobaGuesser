/* static/game.js */

// ---------- Config ----------
const params = new URLSearchParams(window.location.search);
const isDaily = params.get('mode') === 'daily';
// The Daily Challenge is always 5 rounds on medium (the server enforces it)
const difficulty = isDaily ? 'medium'
    : ['easy', 'medium', 'hard'].includes(params.get('diff')) ? params.get('diff') : 'easy';
const selectedRounds = isDaily ? '5' : params.get('rounds') || '5';
const isUnlimited = selectedRounds === 'unlimited';

const difficultySettings = { easy: 30, medium: 20, hard: 8 };
const SITE_URL = 'https://umanitobaguesser.ca';
const MAX_POINTS = 5000;      // per round
const CAMPUS_CENTER = [49.80877091322333, -97.13230173125407];
const CAMPUS_BOUNDS = L.latLngBounds([49.790, -97.170], [49.826, -97.095]);
const BEST_KEY = isDaily ? 'umg_best_daily' : `umg_best_${difficulty}_${selectedRounds}`;
const IS_TOUCH = window.matchMedia('(hover: none), (pointer: coarse)').matches;

const TIERS = [
    { max: 30,       kind: 'perfect', title: '🎯 Bullseye!',   sound: 'perfect' },
    { max: 200,      kind: 'win',     title: '🔥 Great guess!', sound: 'win' },
    { max: 600,      kind: 'ok',      title: '👍 Not bad',      sound: 'ok' },
    { max: Infinity, kind: 'far',     title: '📍 Way off',      sound: 'far' }
];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const modal = $('feedbackModal');
const feedbackText = $('feedbackMessage');
const timerDisplay = $('timer');
const timerBar = $('timerBar');
const timerWrap = $('timerWrap');
const guessBtn = $('guessButton');
const restartBtn = $('restartButton');
const endBtn = $('endButton');
const scoreEl = $('score');
const bestEl = $('bestScore');
const roundResult = $('roundResult');
const roundHeader = $('roundHeader');
const photoWrap = $('photoWrap');
const photoImg = $('locationImg');
const resultsModal = $('resultsModal');

// ---------- Map ----------
const map = L.map('map', {
    maxBounds: CAMPUS_BOUNDS,
    maxBoundsViscosity: 0.9,
    minZoom: 14
}).setView(CAMPUS_CENTER, 17);

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);

const pin = window.UMGPins.guess(window.UMGPins.color(1));
const pin1 = window.UMGPins.answer(32);

// ---------- State ----------
const gameState = {
    currentRound: 1,
    maxRounds: 5,
    totalScore: 0,
    userGuess: null,
    isGuessed: false
};

let results = [];          // { round, distance, score, guess: LatLng|null, answer: LatLng }
let locationGuess = null;
let targetMarker = null;
let connectionLine = null;
let timerInterval = null;
let timeLeft = 0;
let timerRunning = false;
let gameStarted = false;   // true once the rules popup has been closed
let imageReady = false;    // true once the current photo has loaded
let finished = false;
let displayedScore = 0;
let dailyNumber = null;

// Every game is run by the server (static/api.js): answers never reach the browser early
const serverReady = !!(window.UMGApi && window.UMGApi.enabled);
let serverGame = null;     // { id, round: { round_no, photo, time_limit_s } }
let busy = false;          // a server request is in flight: ignore Guess/Next/Enter

// ---------- Helpers ----------
function sfx(name, delay = 0) {
    if (!window.GameSounds) return;
    if (delay) setTimeout(() => window.GameSounds.play(name), delay);
    else window.GameSounds.play(name);
}

function formatDistance(m) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function getBest() { try { return parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { return 0; } }
function setBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) {} }
function renderBest() { const b = getBest(); bestEl.textContent = b ? `Best: ${b.toLocaleString()}` : 'Best: --'; }

function animateScore(to) {
    const from = displayedScore;
    displayedScore = to;
    if (to > from) {            // visual only: little bump on the score card
        const badge = scoreEl.parentElement;
        badge.classList.remove('bump');
        void badge.offsetWidth;
        badge.classList.add('bump');
    }
    const start = performance.now(), dur = 600;
    (function step(now) {
        const t = Math.min(1, (now - start) / dur);
        const v = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        scoreEl.textContent = `Score: ${v.toLocaleString()} 🦬`;
        if (t < 1) requestAnimationFrame(step);
    })(start);
}

function setHint(text) {
    roundResult.className = 'round-result hint';
    roundResult.textContent = text;
}

function showBanner({ kind, title, detail, points }) {
    roundResult.className = `round-result rr-${kind}`;   // "rr-" prefix: a bare "far" class clashes with Font Awesome
    roundResult.innerHTML =
        `<span class="rr-title">${title}</span>` +
        `<span class="rr-detail">${detail}</span>` +
        `<span class="rr-pts">+${points.toLocaleString()}</span>`;
}

function clearMapMarkers() {
    [locationGuess, targetMarker, connectionLine].forEach(l => { if (l) map.removeLayer(l); });
    locationGuess = targetMarker = connectionLine = null;
}

// ---------- Rules / info modal ----------
function showFeedback(message) {
    feedbackText.innerText = message;
    modal.classList.remove('hidden');
}

function hideFeedback() {
    modal.classList.add('hidden');
    if (!gameStarted) {
        gameStarted = true;
        // Round 1 is only issued now, so reading the rules never uses round time
        if (!serverGame) loadGameData(setupRound);
        else tryStartTimer();
    }
}

function onServerError(err) {
    console.error(err);
    busy = false;
    stopTimer();
    showFeedback("⚠️ Lost connection to the game server.\nPress Restart to start a new game.");
}

$('closeModal').addEventListener('click', hideFeedback);
modal.addEventListener('click', (e) => { if (e.target === modal) hideFeedback(); });

function displayGameRules() {
    const roundsLine = isUnlimited
        ? 'Rounds: Unlimited (press End Game any time)'
        : `Rounds: ${gameState.maxRounds}  •  Max points: ${(gameState.maxRounds * MAX_POINTS).toLocaleString()}`;
    showFeedback(
        (isDaily ? `📅 Daily Challenge 📅\nSame 5 photos for everyone today. One try only!\n\n` : `📜 How to play 📜\n\n`) +
        `1️⃣ Study the photo (use 🔍 to zoom in)\n` +
        `2️⃣ ${IS_TOUCH ? 'Tap' : 'Click'} the map to drop your pin\n` +
        `3️⃣ Press Guess before time runs out\n` +
        `4️⃣ Closer pins score more, up to ${MAX_POINTS.toLocaleString()} per round\n\n` +
        `${roundsLine}\n` +
        `Timer: ${difficultySettings[difficulty]}s per round (${difficulty})\n\n` +
        `Good luck, Bison! 🦬`
    );
}

// ---------- Timer ----------
function totalTime() { return difficultySettings[difficulty]; }

function renderTimer() {
    const t = Math.max(timeLeft, 0);
    timerDisplay.textContent = `${t}s`;
    timerBar.style.width = `${(t / totalTime()) * 100}%`;
    timerWrap.classList.toggle('low', timerRunning && t <= 5);
}

function stopTimer() {
    clearInterval(timerInterval);
    timerRunning = false;
}

function resetTimerDisplay() {
    stopTimer();
    timeLeft = totalTime();
    timerBar.style.transition = 'none';
    renderTimer();
    void timerBar.offsetWidth;
    timerBar.style.transition = '';
}

function startTimer(seconds) {
    resetTimerDisplay();
    if (seconds !== undefined) { timeLeft = Math.max(0, Math.min(totalTime(), seconds)); renderTimer(); }
    timerRunning = true;
    timerInterval = setInterval(() => {
        timeLeft--;
        renderTimer();
        if (timeLeft <= 0) {
            stopTimer();
            timerWrap.classList.remove('low');
            handleTimeOut();
        }
    }, 1000);
}

// Timer only starts once the rules are closed AND the photo has loaded.
// The server sets the real deadline when told the photo is showing.
function tryStartTimer() {
    if (!(gameStarted && imageReady && !gameState.isGuessed && !timerRunning && !finished)) return;
    if (busy || !serverGame) return;
    busy = true;
    window.UMGApi.startRound(serverGame.id)
        .then(r => { busy = false; startTimer(Math.ceil(r.remaining_ms / 1000)); })
        .catch(onServerError);
}

function handleTimeOut() {
    if (gameState.isGuessed) return;
    gameState.isGuessed = true;
    busy = true;
    window.UMGApi.submit(serverGame.id, null, null)
        .then(res => { busy = false; showTimeout(L.latLng(res.answer.lat, res.answer.lng), "⏰ Time's up!"); })
        .catch(onServerError);
}

function showTimeout(target, title, detail = 'No points this round.') {
    results.push({ round: gameState.currentRound, distance: null, score: 0, guess: null, answer: target });

    targetMarker = L.marker(target, { icon: pin1 }).addTo(map);
    map.flyTo(target, 18, { duration: 0.8 });

    showBanner({ kind: 'timeout', title, detail, points: 0 });
    sfx('timeout');
    setGuessState('next');
}

// ---------- Round flow ----------
function isLastRound() { return gameState.currentRound >= gameState.maxRounds; }

function setGuessState(state) {
    guessBtn.style.display = '';
    guessBtn.disabled = state === 'disabled';
    guessBtn.textContent = state === 'next' ? (isLastRound() ? 'See Results' : 'Next Round') : 'Guess';
}

function roundTitle() {
    const n = isUnlimited ? `ROUND ${gameState.currentRound}` : `ROUND ${gameState.currentRound} / ${gameState.maxRounds}`;
    return isDaily && dailyNumber ? `DAILY #${dailyNumber} · ${n}` : n;
}

function setupRound() {
    const data = serverGame && serverGame.round;
    if (!data) return;

    stopTimer();
    imageReady = false;
    gameState.isGuessed = false;
    gameState.userGuess = null;
    clearMapMarkers();
    map.setView(CAMPUS_CENTER, 17, { animate: false });

    roundHeader.textContent = roundTitle();
    setGuessState('disabled');
    setHint(IS_TOUCH ? 'Tap the map to drop your pin.' : 'Click the map to drop your pin.');
    resetTimerDisplay();

    const onReady = () => {
        imageReady = true;
        photoWrap.classList.remove('loading');
        tryStartTimer();
    };
    photoWrap.classList.add('loading');
    photoImg.onload = onReady;
    photoImg.onerror = () => {
        setHint('⚠️ This photo failed to load. Try refreshing the page.');
        onReady();
    };
    photoImg.src = `./${data.photo}`;
    if (photoImg.complete && photoImg.naturalWidth > 0) onReady();
}

function onMapClick(e) {
    if (gameState.isGuessed || finished) return;
    if (locationGuess) {
        locationGuess.setLatLng(e.latlng);
    } else {
        locationGuess = L.marker(e.latlng, { icon: pin }).addTo(map);
    }
    gameState.userGuess = e.latlng;
    setGuessState('ready');
    setHint('Pin placed. Press Guess (or Enter) to lock it in.');
    sfx('pin');
}
map.on('click', onMapClick);

function submitGuess() {
    stopTimer();
    timerWrap.classList.remove('low');
    gameState.isGuessed = true;
    busy = true;
    setGuessState('disabled');
    const g = gameState.userGuess;
    window.UMGApi.submit(serverGame.id, g.lat, g.lng)
        .then(res => {
            busy = false;
            const target = L.latLng(res.answer.lat, res.answer.lng);
            if (res.timed_out) {
                showTimeout(target, '⏰ Too late!', 'Your guess reached the server after time ran out.');
                return;
            }
            gameState.totalScore = res.total_score;
            showGuessResult(target, res.distance_m, res.score);
        })
        .catch(onServerError);
}

function showGuessResult(target, distance, score) {
    results.push({ round: gameState.currentRound, distance, score, guess: gameState.userGuess, answer: target });
    animateScore(gameState.totalScore);

    targetMarker = L.marker(target, { icon: pin1 }).addTo(map);
    connectionLine = L.polyline([gameState.userGuess, target], { color: '#1d9fd9', dashArray: '5, 10' }).addTo(map);
    map.fitBounds(L.latLngBounds([gameState.userGuess, target]), { padding: [50, 50], maxZoom: 18 });

    const tier = TIERS.find(t => distance < t.max);
    showBanner({ kind: tier.kind, title: tier.title, detail: `${formatDistance(distance)} away`, points: score });
    sfx('lock');
    sfx(tier.sound, 220);
    setGuessState('next');
}

function advance() {
    if (isLastRound()) {
        finishGame();
        return;
    }
    busy = true;
    setGuessState('disabled');
    window.UMGApi.nextRound(serverGame.id)
        .then(round => {
            busy = false;
            serverGame.round = round;
            gameState.currentRound = round.round_no;
            sfx('next');
            setupRound();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        })
        .catch(onServerError);
}

guessBtn.addEventListener('click', () => {
    if (busy) return;
    if (finished) { openResults(); return; }
    if (gameState.isGuessed) { advance(); return; }
    if (!gameState.userGuess) return;
    submitGuess();
});

// Keyboard: Enter = guess / next / dismiss rules
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const viewerOpen = $('photoViewer') && !$('photoViewer').classList.contains('hidden');
    if (viewerOpen || !resultsModal.classList.contains('hidden')) return;
    if (!modal.classList.contains('hidden')) { hideFeedback(); return; }
    if (document.activeElement && ['BUTTON', 'A'].includes(document.activeElement.tagName)) return;
    if (!guessBtn.disabled) guessBtn.click();
});

// ---------- End of game ----------
function rankFor(pct) {
    if (pct >= 0.9) return '🏆 Campus Legend';
    if (pct >= 0.7) return '🎓 Seasoned Senior';
    if (pct >= 0.45) return "📚 Dean's List";
    if (pct >= 0.2) return '🐣 First-Year Fresh';
    return '🔦 Lost in the Tunnels';
}

function squareFor(score) {
    if (score >= 4000) return '🟩';
    if (score >= 2000) return '🟨';
    if (score >= 500) return '🟧';
    return '🟥';
}

function buildShareText() {
    const max = results.length * MAX_POINTS;
    const squares = results.slice(0, 30).map(r => squareFor(r.score)).join('');
    const best = results.reduce((m, r) => (r.distance !== null && (m === null || r.distance < m) ? r.distance : m), null);
    const bestLine = best !== null ? `\n📍 Closest: ${formatDistance(best)}` : '';
    if (isDaily) {
        return `UManitoba Guesser Daily #${dailyNumber || ''} 🦬\n${gameState.totalScore.toLocaleString()} / ${max.toLocaleString()}\n${squares}${bestLine}`;
    }
    const mode = isUnlimited ? 'unlimited' : `${results.length} rounds`;
    return `UManitoba Guesser 🦬\n${gameState.totalScore.toLocaleString()} / ${max.toLocaleString()} (${difficulty}, ${mode})\n${squares}${bestLine}`;
}

function fillResults() {
    const max = results.length * MAX_POINTS;
    const pct = max ? gameState.totalScore / max : 0;
    const prevBest = getBest();
    const isNewBest = gameState.totalScore > prevBest && gameState.totalScore > 0;
    if (isNewBest) setBest(gameState.totalScore);
    renderBest();

    $('resRank').textContent = rankFor(pct);
    $('resScore').textContent = gameState.totalScore.toLocaleString();
    $('resMax').textContent = `/ ${max.toLocaleString()}`;
    $('resNew').hidden = !isNewBest || isDaily;
    $('resBest').textContent = isDaily
        ? `Daily #${dailyNumber || ''} · come back tomorrow for new photos`
        : `Personal best (${difficulty}, ${isUnlimited ? 'unlimited' : selectedRounds + ' rounds'}): ${getBest().toLocaleString()}`;

    const list = $('resList');
    list.innerHTML = '';
    results.forEach(r => {
        const li = document.createElement('li');
        li.innerHTML =
            `<span class="rl-sq">${squareFor(r.score)}</span>` +
            `<span class="rl-round">Round ${r.round}</span>` +
            `<span class="rl-dist">${r.distance === null ? 'Timed out' : formatDistance(r.distance)}</span>` +
            `<span class="rl-pts">${r.score.toLocaleString()}</span>`;
        list.appendChild(li);
    });
    if (isDaily) showDailyStanding();
}

// "You beat N% of today's players"
function showDailyStanding() {
    const el = $('resDaily');
    if (!el || !window.UMGApi.dailyStatus) return;
    el.hidden = true;
    window.UMGApi.dailyStatus().then(s => {
        if (s.my_score == null) return;
        el.textContent = s.beat_pct != null
            ? `You beat ${s.beat_pct}% of today's ${s.players.toLocaleString()} players`
            : `You're the first to finish today's challenge!`;
        el.hidden = false;
    }).catch(() => {});
}

// End-of-game map: every guess, every answer, joined by a line
let resultsMap = null;
function drawResultsMap() {
    const box = $('resMap');
    if (!box) return;
    if (!resultsMap) {
        resultsMap = L.map(box, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
        L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(resultsMap);
    }
    resultsMap.eachLayer(l => { if (!(l instanceof L.TileLayer)) resultsMap.removeLayer(l); });
    resultsMap.invalidateSize();
    const pts = [];
    results.forEach(r => {
        L.marker(r.answer, { icon: window.UMGPins.answer(26), interactive: false }).addTo(resultsMap);
        pts.push(r.answer);
        if (r.guess) {
            L.polyline([r.guess, r.answer], { color: '#1d9fd9', weight: 2, dashArray: '4, 6' }).addTo(resultsMap);
            L.marker(r.guess, { icon: window.UMGPins.guess(window.UMGPins.color(1), 24, String(r.round)), interactive: false }).addTo(resultsMap);
            pts.push(r.guess);
        }
    });
    if (pts.length) resultsMap.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 17 });
    else resultsMap.setView(CAMPUS_CENTER, 15);
}

function openResults() {
    resultsModal.classList.remove('hidden');
    setTimeout(drawResultsMap, 30);   // Leaflet needs the box to be visible to size it
}
function closeResults() { resultsModal.classList.add('hidden'); }

function finishGame() {
    stopTimer();
    finished = true;
    // Server records the result (ranked/abandoned); the screen already has every round
    if (serverGame) {
        window.UMGApi.finish(serverGame.id)
            .then(() => {
                document.dispatchEvent(new Event('umg:gamefinished'));   // lets the sidebar refresh
                if (isDaily) showDailyStanding();
            })
            .catch(err => console.error(err));
    }
    endBtn.style.display = 'none';
    guessBtn.style.display = '';
    guessBtn.disabled = false;
    guessBtn.textContent = 'View Results';
    fillResults();
    openResults();
    sfx('gameover');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function shareScore() {
    const text = buildShareText();
    const url = isDaily ? `${SITE_URL}/play.html?mode=daily` : SITE_URL;
    const btn = $('shareBtn');
    try {
        if (navigator.share) {
            await navigator.share({ title: 'UManitoba Guesser', text, url });
            return;
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
    }
    try {
        await navigator.clipboard.writeText(`${text}\nPlay: ${url}`);
        const old = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = old; }, 1800);
    } catch (e) {
        window.prompt('Copy your score:', `${text}\nPlay: ${url}`);
    }
}

$('shareBtn').addEventListener('click', shareScore);
$('closeResults').addEventListener('click', closeResults);
resultsModal.addEventListener('click', (e) => { if (e.target === resultsModal) closeResults(); });
$('playAgainBtn').addEventListener('click', () => {
    // One Daily attempt per day: "play again" means a normal game
    if (isDaily) { window.location.href = './play.html?diff=medium&rounds=5'; return; }
    resetGame();
});

endBtn.addEventListener('click', () => {
    if (results.length === 0) { setHint('Finish at least one round first.'); return; }
    finishGame();
});

// ---------- Data / init / restart ----------
function startError(err) {
    const code = err && err.message;
    if (code === 'daily_already_played') {
        roundHeader.textContent = 'DAILY CHALLENGE';
        showFeedback("📅 You've already played today's Daily Challenge.\n\nNew photos every day at midnight (Winnipeg time). See how you did on the Leaderboard page.");
        gameStarted = false;
        return;
    }
    console.error(err);
    showFeedback("⚠️ Couldn't reach the game server.\nCheck your connection and press Restart.");
}

function loadGameData(onComplete) {
    if (!serverReady) {
        showFeedback("⚠️ The game is offline for maintenance.\nPlease try again soon.");
        return;
    }
    busy = true;
    const rounds = isUnlimited ? null : (parseInt(selectedRounds, 10) || 5);
    const start = isDaily ? window.UMGApi.dailyStart() : window.UMGApi.startGame(difficulty, rounds);
    start
        .then(g => {
            busy = false;
            serverGame = { id: g.game_id, round: g.round };
            dailyNumber = g.daily_number || null;
            gameState.currentRound = g.round.round_no;
            gameState.maxRounds = g.rounds_planned || g.pool_size;
            onComplete();
        })
        .catch(err => { busy = false; startError(err); });
}

function resetGame() {
    if (isDaily && results.length) return;   // one attempt per day
    stopTimer();
    closeResults();
    finished = false;
    serverGame = null;
    gameState.currentRound = 1;
    gameState.totalScore = 0;
    results = [];
    displayedScore = 0;
    scoreEl.textContent = 'Score: 0 🦬';
    endBtn.style.display = isUnlimited ? '' : 'none';
    clearMapMarkers();
    loadGameData(() => {
        setupRound();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

restartBtn.addEventListener('click', () => {
    if (results.length > 0 && !finished && !window.confirm('Restart the game? Your current progress will be lost.')) return;
    resetGame();
});

window.addEventListener('load', () => {
    renderBest();
    endBtn.style.display = isUnlimited ? '' : 'none';
    if (isDaily) {
        restartBtn.style.display = 'none';
        roundHeader.textContent = 'DAILY CHALLENGE';
    }
    // The game (and round 1's clock) starts when the rules are closed: see hideFeedback()
    gameState.maxRounds = isUnlimited ? 0 : (parseInt(selectedRounds, 10) || 5);
    displayGameRules();
});
