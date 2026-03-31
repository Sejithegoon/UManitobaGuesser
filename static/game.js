
// map loading 

var map = L.map('map').setView([49.80877091322333, -97.13230173125407], 17);
map.invalidateSize();
var mainMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
});

var googleStreets = L.tileLayer('http://{s}.google.com/vt?lyrs=m&x={x}&y={y}&z={z}',{
    maxZoom: 20,
    subdomains:['mt0','mt1','mt2','mt3']
});

googleStreets.addTo(map);


// markers 

var pin = L.icon({
    iconUrl: './assets/pin.svg',
    iconSize: [20, 20],
    popupAnchor: [-3, -76]

});

var pin1 = L.icon({
    iconUrl: './assets/pin3.webp',
    iconSize: [25, 25],
    popupAnchor: [-3, -76]

});

//game logic

const modal = document.getElementById("feedbackModal");
const feedbackText = document.getElementById("feedbackMessage");
const closeBtn = document.getElementById("closeModal");

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
}


window.onclick = (e) => {
    if (e.target === modal) hideFeedback();
};

const gameRules = `
📜 Game Rules 📜

1️⃣   Max Points: 25,000
2️⃣   Total Rounds: 5
3️⃣   No Timer
4️⃣   One Click Per Round
Good luck!
`;

// Show rules once when page loads
window.addEventListener('load', () => {
    feedbackText.innerText = gameRules;
    modal.classList.remove("hidden");
});
closeBtn.onclick = () => hideFeedback();

window.onclick = (e) => {
    if (e.target === modal) hideFeedback();
};
const gameState = {
    currntRound : 1,
    maxRounds :  5,
    totalScore: 0,
    location: [],
    userGuess: null,
    isGuessed: false
}


let gamePool = [];
const gameLocations = fetch("./locations/locations.json")

gameLocations.then(response => response.json()).then(data => {
    let allLocations = data.locations;


    let shuffled = [...allLocations];

    for (let i = shuffled.length - 1; i > 0; i--) {
      let j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    gamePool = shuffled.slice(0, 5);

    gameState.maxRounds = gamePool.length;
    setupRound();
});

function setupRound() {
    const currentData = gamePool[gameState.currntRound - 1];
    window.scrollTo({
        top: 0,
        left: 0,
        behavior: 'smooth'
    });
    document.querySelector('#gameLocation img').src = `./locations/IMG/${currentData.name}.jpg`;
    
    document.querySelector('.game h1').innerText = `ROUND ${gameState.currntRound}`;

    if (locationGuess) {
        map.removeLayer(locationGuess);
        locationGuess = null;
    }
    gameState.isGuessed = false;
    gameState.userGuess = null;
    document.getElementById('guessButton').innerText = "guess";
}

let locationGuess = null;

function onMapClick(e){
    const clickCords = [e.latlng.lat, e.latlng.lng];
    if(gameState.isGuessed) return;


    if(locationGuess){
        locationGuess.setlatlan(clickCords);
    }else{
        locationGuess = L.marker(clickCords, {icon: pin}).addTo(map);
    }
    gameState.userGuess = clickCords;
    //console.log("Current Guess:", clickCords[0], clickCords[1]);
    
}

map.on('click', onMapClick)

document.getElementById('guessButton').addEventListener('click', function() {
    if (this.innerText === "next round") {
        hideFeedback();
        if(gameState.currntRound < gameState.maxRounds){
            window.scrollTo({
                top: 0,
                left: 0,
                behavior: 'smooth'
            });
        }
        nextRound();
        return;
    }

    if (!gameState.userGuess){
        showFeedback("⚠️ Click the map first!");
        return;
    };
    gameState.isGuessed = true;
    const currentData = gamePool[gameState.currntRound - 1];
    const targetCords = L.latLng([currentData.cords[0], currentData.cords[1]], {icon: pin});

    const distance = map.distance(gameState.userGuess, targetCords);
    const distanceKM = (distance / 1000).toFixed(2);
    //console.log(distance/1000);
    

    let score = Math.max(0, Math.floor(5000 - (distance * 2)));
    gameState.totalScore += score;

    document.getElementById('scroe').innerText = `score: ${gameState.totalScore} 🦬`;

    
    L.marker(targetCords, {icon: pin1}).addTo(map);
    const line = L.polyline([gameState.userGuess, targetCords], {color: '#1d9fd9'}).addTo(map);


    const bounds = L.latLngBounds([gameState.userGuess, targetCords]);


    map.fitBounds(bounds, {
        padding: [50, 50], 
        animate: true,
        duration: 2.5     
    });
    if (distance < 1000) {
        showFeedback(
            `🔥 Great job!\nYou were only ${Math.round(distance)} meters away!\nScore: +${score}`,
            2000
        );
    } else {
        showFeedback(
            `📍 You were ${distanceKM} km away.\nScore: +${score}`,
            2000
        );
    }

    
    this.innerText = "next round";
    
    
});



function nextRound() {
    if (gameState.currntRound < gameState.maxRounds) {
        gameState.currntRound++;
        
        map.eachLayer((layer) => {
            if (layer instanceof L.Marker || layer instanceof L.Polyline) {
                map.removeLayer(layer);
            }
        });

        setupRound();
    } else {
        document.getElementById("guessButton").remove()
        showFeedback(`🏁 Game Over!\nFinal Score: ${gameState.totalScore} 🦬`);
    }
}

document.getElementById('restartButton').addEventListener('click', function(){

    gameState.currntRound = 1;
    gameState.totalScore = 0;
    gameState.userGuess = null;
    gameState.isGuessed = false;

    document.getElementById('scroe').innerText = `score: 0 🦬`;

    map.eachLayer((layer) => {
        if (layer instanceof L.Marker || layer instanceof L.Polyline) {
            map.removeLayer(layer);
        }
    });


    fetch("./locations/locations.json")
    .then(res => res.json())
    .then(data => {
        let allLocations = data.locations;

        let shuffled = [...allLocations];
        for (let i = shuffled.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        gamePool = shuffled.slice(0, 5);
        gameState.maxRounds = gamePool.length;

        setupRound();
    });

});
