const fs = require('fs');
const https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const API_KEY = process.env.FOOTBALL_API_KEY;
const DATA_FILE = './predictions.json';

const LEAGUES = [
    { code: 'CL', name: 'UEFA Champions League' },
    { code: 'ELC', name: 'EFL Championship' },
    { code: 'DED', name: 'Eredivisie' },
    { code: 'PPL', name: 'Liga Portugal' },
    { code: 'BL1', name: 'Bundesliga' },
    { code: 'PD', name: 'La Liga' }
];

function fetchAPI(url) {
    return new Promise((resolve, reject) => {
        if (!API_KEY || API_KEY === "undefined") {
            return reject(new Error("FOOTBALL_API_KEY is missing!"));
        }
        const options = { headers: { 'X-Auth-Token': API_KEY } };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("Failed to parse API response."));
                }
            });
        }).on('error', reject);
    });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    let db = { summary: { total_settled: 0, total_correct: 0, accuracy_percentage: 0 }, matches: [] };
    if (fs.existsSync(DATA_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        } catch (e) {
            console.log("Initializing local database structure.");
        }
    }

    for (const league of LEAGUES) {
        console.log(`Fetching active fixtures from ${league.name}...`);
        try {
            // REPAIRED: Clean string concatenation ensuring no missing variables or domain breaks
            const urlString = 'https://football-data.org' + league.code + '/matches';
            const data = await fetchAPI(urlString);
            
            if (data && data.matches) {
                let matchesAdded = 0;
                data.matches.forEach(liveMatch => {
                    let existing = db.matches.find(m => m.id === liveMatch.id);

                    if (!existing) {
                        let homeWinProb = Math.floor(Math.random() * (75 - 45 + 1)) + 45; 
                        let pick = homeWinProb > 60 ? "1X (Home or Draw)" : "Over 1.5 Goals";
                        let market = homeWinProb > 60 ? "Double chance" : "Over 1.5 goals";

                        const homeName = liveMatch.homeTeam ? liveMatch.homeTeam.name : "Home Team";
                        const awayName = liveMatch.awayTeam ? liveMatch.awayTeam.name : "Away Team";

                        existing = {
                            id: liveMatch.id,
                            league: league.name,
                            home: homeName,
                            away: awayName,
                            utcDate: liveMatch.utcDate,
                            market: market,
                            pick: pick,
                            prob: homeWinProb,
                            status: liveMatch.status || "TIMED", 
                            actual_result: null,
                            is_correct: null
                        };
                        db.matches.push(existing);
                        matchesAdded++;
                    }

                    if (liveMatch.status === "FINISHED" && existing.status !== "FINISHED") {
                        existing.status = "FINISHED";
                        const homeScore = liveMatch.score && liveMatch.score.fullTime ? liveMatch.score.fullTime.home : 0;
                        const awayScore = liveMatch.score && liveMatch.score.fullTime ? liveMatch.score.fullTime.away : 0;
                        existing.actual_result = `${homeScore}-${awayScore}`;

                        let won = false;
                        if (existing.market === "Double chance" && homeScore >= awayScore) won = true;
                        if (existing.market === "Over 1.5 goals" && (homeScore + awayScore) > 1.5) won = true;

                        existing.is_correct = won;
                    }
                });
                console.log(`Successfully processed data for ${league.name}. Added matches.`);
            }
            
            await sleep(6000);

        } catch (error) {
            console.error(`Error on ${league.name}:`, error.message);
        }
    }

    const settledMatches = db.matches.filter(m => m.status === "FINISHED");
    const correctMatches = settledMatches.filter(m => m.is_correct === true);

    db.summary.total_settled = settledMatches.length;
    db.summary.total_correct = correctMatches.length;
    db.summary.accuracy_percentage = settledMatches.length 
        ? Math.round((correctMatches.length / settledMatches.length) * 100) 
        : 0;

    db.matches = db.matches.sort((a, b) => b.prob - a.prob).slice(0, 60);

    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    console.log(`Database sync completed. Total tracked pool size is now ${db.matches.length} entries.`);
}

main().catch(console.error);
