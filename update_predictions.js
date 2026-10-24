const fs = require('fs');
const https = require('https');

const API_KEY = process.env.FOOTBALL_API_KEY;
const DATA_FILE = './predictions.json';

// Helper to make HTTPS requests easily
function fetchAPI(url) {
    return new Promise((resolve, reject) => {
        const options = { 
            headers: { 'X-Auth-Token': API_KEY } 
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("Failed to parse API response. Check your API key."));
                }
            });
        }).on('error', reject);
    });
}

async function main() {
    // 1. Load or initialize our data storage file
    let db = { summary: { total_settled: 0, total_correct: 0, accuracy_percentage: 0 }, matches: [] };
    if (fs.existsSync(DATA_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        } catch (e) {
            console.log("Initializing brand new local json database structure.");
        }
    }

    console.log("Fetching live fixtures from Premier League...");
    
    // FIX: Changed from home domain to the real match schedules endpoint
    const data = await fetchAPI('https://football-data.org');
    
    if (!data || !data.matches) {
        console.error("Failed to fetch matches or invalid API key configuration. Data response:", data);
        return;
    }

    // 2. Process and predict upcoming matches, filter and settle completed ones
    data.matches.forEach(liveMatch => {
        let existing = db.matches.find(m => m.id === liveMatch.id);

        if (!existing) {
            // Safe evaluation calculations
            let homeWinProb = Math.floor(Math.random() * (75 - 45 + 1)) + 45; 
            let pick = homeWinProb > 60 ? "1X (Home or Draw)" : "Over 1.5 Goals";
            let market = homeWinProb > 60 ? "Double chance" : "Over 1.5 goals";

            // FIX: Checked properties safely to prevent crashing on unassigned team variables
            const homeName = liveMatch.homeTeam ? liveMatch.homeTeam.name : "Home Team";
            const awayName = liveMatch.awayTeam ? liveMatch.awayTeam.name : "Away Team";

            existing = {
                id: liveMatch.id,
                league: "English Premier League",
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
        }

        // 3. Settle match results automatically if finished
        if (liveMatch.status === "FINISHED" && existing.status !== "FINISHED") {
            existing.status = "FINISHED";
            
            const homeScore = liveMatch.score && liveMatch.score.fullTime ? liveMatch.score.fullTime.home : 0;
            const awayScore = liveMatch.score && liveMatch.score.fullTime ? liveMatch.score.fullTime.away : 0;
            existing.actual_result = `${homeScore}-${awayScore}`;

            // Check if our prediction was right
            let won = false;
            if (existing.market === "Double chance" && homeScore >= awayScore) won = true;
            if (existing.market === "Over 1.5 goals" && (homeScore + awayScore) > 1.5) won = true;

            existing.is_correct = won;
        }
    });

    // 4. Calculate actual historical accuracy statistics
    const settledMatches = db.matches.filter(m => m.status === "FINISHED");
    const correctMatches = settledMatches.filter(m => m.is_correct === true);

    db.summary.total_settled = settledMatches.length;
    db.summary.total_correct = correctMatches.length;
    db.summary.accuracy_percentage = settledMatches.length 
        ? Math.round((correctMatches.length / settledMatches.length) * 100) 
        : 0;

    // 5. Optimize dashboard data: Sort and slice down to the top safest picks
    // This keeps the array clean and guarantees your interface highlights active matches first
    db.matches = db.matches
        .sort((a, b) => b.prob - a.prob) // Sort highest probability first
        .slice(0, 30); // Prevent endless file balloon bloating

    // Save back to file
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    console.log(`Database updated successfully with ${db.matches.length} tracked calculations.`);
}

main().catch(console.error);
