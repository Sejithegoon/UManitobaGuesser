/* static/game.js */

// ---------- Config ----------
const params = new URLSearchParams(window.location.search);
const difficulty = ['easy', 'medium', 'hard'].includes(params.get('diff')) ? params.get('diff') : 'easy';
const selectedRounds = params.get('rounds') || '5';
const isUnlimited = selectedRounds === 'unlimited';

const difficultySettings = { easy: 30, medium: 20, hard: 8 };
const SITE_URL = 'https://umanitobaguesser.ca';
const MAX_POINTS = 5000;      // per round
const BULLSEYE_M = 10;        // within this distance = full points
const FALLOFF_M = 200;        // score decays smoothly; ~200 m off loses about 63%
const CAMPUS_CENTER = [49.80877091322333, -97.13230173125407];
const CAMPUS_BOUNDS = L.latLngBounds([49.790, -97.170], [49.826, -97.095]);
const BEST_KEY = `umg_best_${difficulty}_${selectedRounds}`;
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

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

function makePin(src, size) {
    return L.divIcon({
        className: 'pin-marker',
        html: `<img src="${src}" alt="">`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}
const pin = makePin('./assets/pin.svg', 28);
const pin1 = makePin('./assets/pin3.webp', 32);

// ---------- State ----------
const gameState = {
    currentRound: 1,
    maxRounds: 5,
    totalScore: 0,
    userGuess: null,
    isGuessed: false
};

let gamePool = [];
let results = [];
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

// ---------- Helpers ----------
function sfx(name, delay = 0) {
    if (!window.GameSounds) return;
    if (delay) setTimeout(() => window.GameSounds.play(name), delay);
    else window.GameSounds.play(name);
}

function imgPath(name) { return `./locations/IMG/${name}.jpg`; }

function formatDistance(m) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function calcScore(distance) {
    const d = Math.max(0, distance - BULLSEYE_M);
    return Math.round(MAX_POINTS * Math.exp(-d / FALLOFF_M));
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function getBest() { try { return parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { return 0; } }
function setBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) {} }
function renderBest() { const b = getBest(); bestEl.textContent = b ? `Best: ${b.toLocaleString()}` : 'Best: --'; }

function animateScore(to) {
    const from = displayedScore;
    displayedScore = to;
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
        tryStartTimer();
    }
}

$('closeModal').addEventListener('click', hideFeedback);
modal.addEventListener('click', (e) => { if (e.target === modal) hideFeedback(); });

function displayGameRules() {
    const roundsLine = isUnlimited
        ? 'Rounds: Unlimited (press End Game any time)'
        : `Rounds: ${gameState.maxRounds}  •  Max points: ${(gameState.maxRounds * MAX_POINTS).toLocaleString()}`;
    showFeedback(
        `📜 How to play 📜\n\n` +
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

function startTimer() {
    resetTimerDisplay();
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

// Timer only starts once the rules are closed AND the photo has loaded
function tryStartTimer() {
    if (gameStarted && imageReady && !gameState.isGuessed && !timerRunning && !finished) startTimer();
}

function handleTimeOut() {
    if (gameState.isGuessed) return;
    gameState.isGuessed = true;
    const target = currentTarget();
    results.push({ round: gameState.currentRound, distance: null, score: 0 });

    targetMarker = L.marker(target, { icon: pin1 }).addTo(map);
    map.flyTo(target, 18, { duration: 0.8 });

    showBanner({ kind: 'timeout', title: "⏰ Time's up!", detail: 'No points this round.', points: 0 });
    sfx('timeout');
    setGuessState('next');
}

// ---------- Round flow ----------
function currentTarget() {
    const d = gamePool[gameState.currentRound - 1];
    return L.latLng(d.cords[0], d.cords[1]);
}

function isLastRound() { return gameState.currentRound >= gameState.maxRounds; }

function setGuessState(state) {
    guessBtn.style.display = '';
    guessBtn.disabled = state === 'disabled';
    guessBtn.textContent = state === 'next' ? (isLastRound() ? 'See Results' : 'Next Round') : 'Guess';
}

function setupRound() {
    const data = gamePool[gameState.currentRound - 1];
    if (!data) return;

    stopTimer();
    imageReady = false;
    gameState.isGuessed = false;
    gameState.userGuess = null;
    clearMapMarkers();
    map.setView(CAMPUS_CENTER, 17, { animate: false });

    roundHeader.textContent = isUnlimited
        ? `ROUND ${gameState.currentRound}`
        : `ROUND ${gameState.currentRound} / ${gameState.maxRounds}`;
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
    const src = imgPath(data.name);
    photoImg.src = src;
    if (photoImg.complete && photoImg.naturalWidth > 0) onReady();

    // Warm the cache for the next round
    const next = gamePool[gameState.currentRound];
    if (next) new Image().src = imgPath(next.name);
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

    const target = currentTarget();
    const distance = map.distance(gameState.userGuess, target);
    const score = calcScore(distance);
    gameState.totalScore += score;
    results.push({ round: gameState.currentRound, distance, score });
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
    gameState.currentRound++;
    sfx('next');
    setupRound();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

guessBtn.addEventListener('click', () => {
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
    const mode = isUnlimited ? 'unlimited' : `${results.length} rounds`;
    return `UManitoba Guesser 🦬\n${gameState.totalScore.toLocaleString()} / ${max.toLocaleString()} (${difficulty}, ${mode})\n${squares}`;
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
    $('resNew').hidden = !isNewBest;
    $('resBest').textContent = `Personal best (${difficulty}, ${isUnlimited ? 'unlimited' : selectedRounds + ' rounds'}): ${getBest().toLocaleString()}`;

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
}

function openResults() { resultsModal.classList.remove('hidden'); }
function closeResults() { resultsModal.classList.add('hidden'); }

function finishGame() {
    stopTimer();
    finished = true;
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
    const btn = $('shareBtn');
    try {
        if (navigator.share) {
            await navigator.share({ title: 'UManitoba Guesser', text, url: SITE_URL });
            return;
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
    }
    try {
        await navigator.clipboard.writeText(`${text}\nPlay: ${SITE_URL}`);
        const old = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = old; }, 1800);
    } catch (e) {
        window.prompt('Copy your score:', `${text}\nPlay: ${SITE_URL}`);
    }
}

$('shareBtn').addEventListener('click', shareScore);
$('closeResults').addEventListener('click', closeResults);
resultsModal.addEventListener('click', (e) => { if (e.target === resultsModal) closeResults(); });
$('playAgainBtn').addEventListener('click', resetGame);

endBtn.addEventListener('click', () => {
    if (results.length === 0) { setHint('Finish at least one round first.'); return; }
    finishGame();
});

// ---------- Data / init / restart ----------
function loadGameData(onComplete) {
    fetch('./locations/locations.json')
        .then(res => { if (!res.ok) throw new Error(res.status); return res.json(); })
        .then(data => {
            const shuffled = shuffle(data.locations.slice());
            gamePool = isUnlimited
                ? shuffled
                : shuffled.slice(0, Math.min(parseInt(selectedRounds, 10) || 5, shuffled.length));
            gameState.maxRounds = gamePool.length;
            onComplete();
        })
        .catch(err => {
            console.error(err);
            showFeedback("⚠️ Couldn't load the locations.\nPlease refresh the page.");
        });
}

function resetGame() {
    stopTimer();
    closeResults();
    finished = false;
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
    loadGameData(() => {
        setupRound();
        displayGameRules();
    });
});
