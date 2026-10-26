const fs = require('fs');

async function runAggregatorEngine() {
    try {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const formattedDate = yyyy + '-' + mm + '-' + dd;

        console.log('Running Calculation Engine for Date: ' + formattedDate);

        // HARDCODED API ENDPOINT URL - No brackets or string concatenation templates
        const url = 'https://openligadb.de';
        console.log('Fetching from URL: ' + url);
        
        const response = await fetch(url);
        if (!response.ok) throw new Error('HTTP error! status: ' + response.status);
        
        const matches = await response.json();

        // Isolate today's matches safely
        const todaysMatches = matches.filter(match => match.matchDateTime && match.matchDateTime.startsWith(formattedDate));

        const finalizedPredictions = todaysMatches.map(match => {
            const homeForm = match.team1.points || 65;
            const awayForm = match.team2.points || 45;
            const homeAvgGoalsScored = 1.8;
            const awayAvgGoalsConceded = 1.6;

            const homeStrength = (homeForm * 0.5) + 20; 
            const awayStrength = (awayForm * 0.5);
            const expectedGoals = (homeAvgGoalsScored + awayAvgGoalsConceded) / 2;

            const totalMatrix = homeStrength + awayStrength;
            const homeProbability = Math.round((homeStrength / totalMatrix) * 100);
            const awayProbability = Math.round((awayStrength / totalMatrix) * 100);
            const drawProbability = Math.max(10, 100 - (homeProbability + awayProbability));

            let finalTip = "1X (Home Win or Draw)";
            let confidenceScore = homeProbability;

            if (homeProbability >= 70) {
                finalTip = "Home Win (1)";
                confidenceScore = homeProbability;
            } else if (awayProbability >= 70) {
                finalTip = "Away Win (2)";
                confidenceScore = awayProbability;
            } else if (expectedGoals >= 1.5 && homeForm > 50 && awayForm > 50) {
                finalTip = "GG / BTTS";
                confidenceScore = Math.round(((homeForm + awayForm) / 2));
            } else if (expectedGoals >= 1.2) {
                finalTip = "Over 1.5 Goals";
                confidenceScore = 85;
            }

            return {
                homeTeam: match.team1.teamName,
                awayTeam: match.team2.teamName,
                date: formattedDate,
                tip: finalTip,
                confidence: confidenceScore + "%",
                homePercent: homeProbability + "%",
                drawPercent: drawProbability + "%",
                awayPercent: awayPercent = awayProbability + "%"
            };
        });

        // Write directly into your predictions.json database file inside your repository
        fs.writeFileSync('predictions.json', JSON.stringify(finalizedPredictions, null, 4));
        console.log("Predictions database successfully compiled with " + finalizedPredictions.length + " matches!");

    } catch (error) {
        console.error("Aggregation engine error:", error);
        process.exit(1); 
    }
}

runAggregatorEngine();
