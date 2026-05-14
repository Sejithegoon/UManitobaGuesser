
const params = new URLSearchParams(window.location.search);
const difficulty = params.get('diff') || 'easy'; 

const difficultySettings = {
    'easy': 30,
    'medium': 20,
    'hard': 8
};

let timeLeft = difficultySettings[difficulty];
let timerInterval;
let gameStarted = false; 

var map = L.map('map').setView([49.80877091322333, -97.13230173125407], 17);
L.tileLayer('http://{s}.google.com/vt?lyrs=m&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
}).addTo(map);

// 2. Icons
var pin = L.icon({ iconUrl: './assets/pin.svg', iconSize: [20, 20], popupAnchor: [-3, -76] });
var pin1 = L.icon({ iconUrl: './assets/pin3.webp', iconSize: [25, 25], popupAnchor: [-3, -76] });

// 3. Game State
const gameState = {
    currntRound: 1,
    maxRounds: 5,
    totalScore: 0,
    userGuess: null,
    isGuessed: false
};

let gamePool = [];
let locationGuess = null;
let targetMarker = null;
let connectionLine = null;

// 4. Modal Elements & Logic
const modal = document.getElementById("feedbackModal");
const feedbackText = document.getElementById("feedbackMessage");
const closeBtn = document.getElementById("closeModal");
const timerDisplay = document.getElementById("timer");
const guessBtn = document.getElementById("guessButton");

// Restored Feedback Logic
function showFeedback(message, duration = null) {
    feedbackText.innerText = message;
    modal.classList.remove("hidden");

    if (duration) {
        setTimeout(() => {
            hideFeedback();
        }, duration);
    }
}

function hideFeedback() {
    modal.classList.add("hidden");
    
    if (!gameStarted) {
        gameStarted = true;
        startTimer();
    }
}

closeBtn.onclick = () => hideFeedback();
window.onclick = (e) => {
    if (e.target === modal) hideFeedback();
};

const gameRules = `
📜 Game Rules 📜

1️⃣ Max Points: 25,000
2️⃣ Total Rounds: 5
3️⃣ Time limits vary by difficulty!
4️⃣ You can move your pin before guessing.

Good luck, Bison! 🦬
`;

window.addEventListener('load', () => {
    showFeedback(gameRules);
});

// 5. Timer Logic
function startTimer() {
    clearInterval(timerInterval);
    timeLeft = difficultySettings[difficulty];
    timerDisplay.innerText = `${timeLeft}s`;
    
    timerInterval = setInterval(() => {
        timeLeft--;
        timerDisplay.innerText = `${timeLeft}s`;
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            handleTimeOut();
        }
    }, 1000);
}

function handleTimeOut() {
    gameState.isGuessed = true;
    showFeedback("⏰ TIME'S UP! 0 points for this round.", 3000);
    
    const currentData = gamePool[gameState.currntRound - 1];
    const targetCords = L.latLng(currentData.cords[0], currentData.cords[1]);
    targetMarker = L.marker(targetCords, {icon: pin1}).addTo(map);
    
    guessBtn.innerText = "next round";
}

// 6. Game Flow
function setupRound() {
    if (gameState.currntRound > gameState.maxRounds) return;
    
    const currentData = gamePool[gameState.currntRound - 1];
    
    document.getElementById('roundHeader').innerText = `ROUND ${gameState.currntRound}`;
    document.querySelector('#gameLocation img').src = `./locations/IMG/${currentData.name}.jpg`;
    guessBtn.innerText = "guess";
    
    if (locationGuess) map.removeLayer(locationGuess);
    if (targetMarker) map.removeLayer(targetMarker);
    if (connectionLine) map.removeLayer(connectionLine);
    
    locationGuess = null;
    gameState.isGuessed = false;
    gameState.userGuess = null;
    
    
    if (gameStarted) {
        startTimer();
    }
}

// 7. Click Logic
function onMapClick(e) {
    if (gameState.isGuessed) return;

    const clickCords = [e.latlng.lat, e.latlng.lng];

    if (locationGuess) {
        locationGuess.setLatLng(e.latlng);
    } else {
        locationGuess = L.marker(clickCords, { icon: pin }).addTo(map);
    }
    gameState.userGuess = e.latlng;
}
map.on('click', onMapClick);

// 8. Guess Logic
guessBtn.addEventListener('click', function() {
    if (this.innerText === "next round") {
        hideFeedback();
        nextRound();
        return;
    }

    if (!gameState.userGuess) {
        showFeedback("⚠️ Click the map to place a pin first!", 2000);
        return;
    };

    clearInterval(timerInterval);
    gameState.isGuessed = true;

    const currentData = gamePool[gameState.currntRound - 1];
    const targetCords = L.latLng(currentData.cords[0], currentData.cords[1]);

    const distance = map.distance(gameState.userGuess, targetCords);
    const distanceKM = (distance / 1000).toFixed(2);
    let score = Math.max(0, Math.floor(5000 - (distance * 2)));
    gameState.totalScore += score;

    document.getElementById('scroe').innerText = `score: ${gameState.totalScore} 🦬`;
    targetMarker = L.marker(targetCords, {icon: pin1}).addTo(map);
    connectionLine = L.polyline([gameState.userGuess, targetCords], {color: '#1d9fd9', dashArray: '5, 10'}).addTo(map);

    map.fitBounds(L.polyline([gameState.userGuess, targetCords]).getBounds(), { padding: [50, 50] });

    // Restored old popup logic!
    if (distance < 1000) {
        showFeedback(`🔥 Great job!\nYou were only ${Math.round(distance)} meters away!\nScore: +${score}`, 3000);
    } else {
        showFeedback(`📍 You were ${distanceKM} km away.\nScore: +${score}`, 3000);
    }

    this.innerText = "next round";
});

function nextRound() {
    if (gameState.currntRound < gameState.maxRounds) {
        gameState.currntRound++;
        setupRound();
    } else {
        guessBtn.style.display = "none";
        showFeedback(`🏁 Game Over!\nFinal Score: ${gameState.totalScore} 🦬`);
    }
}

// 9. Init Game
fetch("./locations/locations.json")
    .then(res => res.json())
    .then(data => {
        gamePool = data.locations.sort(() => 0.5 - Math.random()).slice(0, 5);
        gameState.maxRounds = gamePool.length;
        setupRound();
    });

// 10. Restart Logic (Restored)
document.getElementById('restartButton').addEventListener('click', function(){
    guessBtn.style.display = "inline-block";
    gameState.currntRound = 1;
    gameState.totalScore = 0;
    document.getElementById('scroe').innerText = `score: 0 🦬`;
    
    map.eachLayer((layer) => {
        if (layer instanceof L.Marker || layer instanceof L.Polyline) {
            map.removeLayer(layer);
        }
    });

    fetch("./locations/locations.json")
    .then(res => res.json())
    .then(data => {
        gamePool = data.locations.sort(() => 0.5 - Math.random()).slice(0, 5);
        gameState.maxRounds = gamePool.length;
        setupRound();
        startTimer(); // Immediately start timer on manual restart
    });
});