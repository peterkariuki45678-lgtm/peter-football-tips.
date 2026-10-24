const fs = require('fs');

const FIXTURES = [
    { league: "ENGLISH PREMIER LEAGUE", home: "Manchester United", away: "Chelsea", time: "15:30", h_att: 1.55, h_def: 1.10, a_att: 1.45, a_def: 1.20 },
    { league: "ENGLISH PREMIER LEAGUE", home: "Arsenal", away: "Liverpool", time: "18:00", h_att: 1.85, h_def: 0.75, a_att: 1.80, a_def: 0.85 },
    { league: "ENGLISH PREMIER LEAGUE", home: "Manchester City", away: "Aston Villa", time: "20:15", h_att: 2.10, h_def: 0.90, a_att: 1.40, a_def: 1.30 },
    { league: "SPANISH LA LIGA", home: "Real Madrid", away: "Barcelona", time: "22:00", h_att: 2.05, h_def: 0.80, a_att: 1.95, a_def: 0.95 },
    { league: "SPANISH LA LIGA", home: "Atletico Madrid", away: "Sevilla", time: "17:00", h_att: 1.45, h_def: 0.70, a_att: 1.15, a_def: 1.40 },
    { league: "ITALIAN SERIE A", home: "Inter Milan", away: "Juventus", time: "19:45", h_att: 1.75, h_def: 0.65, a_att: 1.35, a_def: 0.60 }
];

function factorial(n) {
    if (n === 0 || n === 1) return 1;
    let res = 1;
    for (let i = 2; i <= n; i++) res *= i;
    return res;
}

function poissonProbability(k, lambda) {
    return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function calculate() {
    const computed = [];
    FIXTURES.forEach(f => {
        const expHome = f.h_att * f.a_def * 1.48;
        const expAway = f.a_att * f.h_def * 1.18;
        
        let homeWin = 0, draw = 0, awayWin = 0;
        for (let h = 0; h < 6; h++) {
            for (let a = 0; a < 6; a++) {
                const p = poissonProbability(h, expHome) * poissonProbability(a, expAway);
                if (h > a) homeWin += p;
                else if (h === a) draw += p;
                else awayWin += p;
            }
        }

        let pick = "Double Chance (1X)";
        let conf = homeWin + draw;
        if ((awayWin + draw) > (homeWin + draw)) {
            pick = "Double Chance (X2)";
            conf = awayWin + draw;
        }

        computed.push({
            league: f.league,
            utcTime: f.time,
            home: f.home,
            away: f.away,
            safe_bet: pick,
            confidence: `${(conf * 100).toFixed(1)}%`,
            raw_probabilities: {
                "1": (homeWin * 100).toFixed(1),
                "X": (draw * 100).toFixed(1),
                "2": (awayWin * 100).toFixed(1)
            }
        });
    });

    // Writes the direct array format your index file needs to render
    fs.writeFileSync('predictions.json', JSON.stringify(computed, null, 4));
    console.log("Database file successfully synchronized.");
}

calculate();
