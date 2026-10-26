const fs = require("fs");
const path = require("path");

const API_URL = "https://api.football-data.org/v4";
const API_KEY = (process.env.FOOTBALL_DATA_API_KEY || "").trim();
const TIMEZONE = "Africa/Nairobi";
const OUTPUT_FILE = path.join(__dirname, "predictions.json");

const MAX_FIXTURES = 40;
const HISTORY_MATCHES = 6;

const COMPETITIONS = [
  { code: "PL", name: "Premier League" },
  { code: "PD", name: "La Liga" },
  { code: "BL1", name: "Bundesliga" },
  { code: "SA", name: "Serie A" },
  { code: "CL", name: "Champions League" }
];

function kenyaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function apiRequest(endpoint) {
  const response = await fetch(`${API_URL}${endpoint}`, {
    headers: {
      "X-Auth-Token": API_KEY
    }
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid API response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(
      `football-data.org HTTP ${response.status}: ${
        data.message || "Request failed"
      }`
    );
  }

  return data;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function poissonProbability(lambda, goals) {
  let result = Math.exp(-lambda);

  for (let i = 1; i <= goals; i++) {
    result *= lambda / i;
  }

  return result;
}

function calculateProbabilities(homeGoals, awayGoals) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let over25 = 0;
  let under45 = 0;
  let homeScores = 0;
  let awayScores = 0;

  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const probability =
        poissonProbability(homeGoals, h) *
        poissonProbability(awayGoals, a);

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 2) over15 += probability;
      if (h + a >= 3) over25 += probability;
      if (h + a <= 4) under45 += probability;
      if (h > 0) homeScores += probability;
      if (a > 0) awayScores += probability;
    }
  }

  return {
    homeWin,
    draw,
    awayWin,
    over15,
    over25,
    under45,
    homeScores,
    awayScores
  };
}

async function getTeamHistory(teamId, beforeDate) {
  const data = await apiRequest(
    `/teams/${teamId}/matches?status=FINISHED&dateTo=${beforeDate}&limit=10`
  );

  const matches = (data.matches || [])
    .filter(match => {
      const score = match.score?.fullTime;

      return (
        match.status === "FINISHED" &&
        match.utcDate.slice(0, 10) < beforeDate &&
        Number.isFinite(score?.home) &&
        Number.isFinite(score?.away)
      );
    })
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, HISTORY_MATCHES);

  return matches.map(match => {
    const isHome = match.homeTeam.id === teamId;

    return {
      scored: isHome
        ? match.score.fullTime.home
        : match.score.fullTime.away,
      conceded: isHome
        ? match.score.fullTime.away
        : match.score.fullTime.home
    };
  });
}

function calculatePrediction(homeHistory, awayHistory) {
  const homeAttack = average(homeHistory.map(match => match.scored));
  const homeConcede = average(homeHistory.map(match => match.conceded));
  const awayAttack = average(awayHistory.map(match => match.scored));
  const awayConcede = average(awayHistory.map(match => match.conceded));

  // Neutral model: no home-advantage bonus.
  const expectedHomeGoals = clamp(
    (homeAttack + awayConcede) / 2,
    0.15,
    4.5
  );

  const expectedAwayGoals = clamp(
    (awayAttack + homeConcede) / 2,
    0.15,
    4.5
  );

  const p = calculateProbabilities(
    expectedHomeGoals,
    expectedAwayGoals
  );

  const markets = [
    {
      market: "Double Chance 1X",
      probability: p.homeWin + p.draw
    },
    {
      market: "Double Chance X2",
      probability: p.awayWin + p.draw
    },
    {
      market: "Over 1.5 Goals",
      probability: p.over15
    },
    {
      market: "Under 4.5 Goals",
      probability: p.under45
    },
    {
      market: "Over 2.5 Goals",
      probability: p.over25
    },
    {
      market: "Both Teams To Score",
      probability: p.homeScores * p.awayScores
    },
    {
      market: "Home Win",
      probability: p.homeWin
    },
    {
      market: "Draw",
      probability: p.draw
    },
    {
      market: "Away Win",
      probability: p.awayWin
    }
  ]
    .map(item => ({
      market: item.market,
      probability: Number((item.probability * 100).toFixed(1))
    }))
    .sort((a, b) => b.probability - a.probability);

  return {
    expectedHomeGoals: Number(expectedHomeGoals.toFixed(2)),
    expectedAwayGoals: Number(expectedAwayGoals.toFixed(2)),
    predictedScore:
      `${Math.round(expectedHomeGoals)}-${Math.round(expectedAwayGoals)}`,
    markets,
    bestPick: markets[0].market,
    probability: markets[0].probability,
    calculationMethod: "Neutral venue; no home-advantage bonus",
    historyMatchesUsed: {
      home: homeHistory.length,
      away: awayHistory.length
    }
  };
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "FOOTBALL_DATA_API_KEY is missing. Add this secret under GitHub Settings > Secrets and variables > Actions."
    );
  }

  console.log("Football-data.org key detected.");
  console.log("Kenya date:", kenyaDate());

  const today = kenyaDate();
  const endDate = addDays(today, 7);
  const predictions = [];

  for (const competition of COMPETITIONS) {
    console.log(`Loading ${competition.name} fixtures...`);

    const endpoint =
      `/competitions/${competition.code}/matches` +
      `?dateFrom=${today}&dateTo=${endDate}`;

    const data = await apiRequest(endpoint);

    for (const match of data.matches || []) {
      if (!["SCHEDULED", "TIMED"].includes(match.status)) continue;
      if (predictions.length >= MAX_FIXTURES) break;

      const home = match.homeTeam;
      const away = match.awayTeam;

      if (!home?.id || !away?.id) continue;

      try {
        console.log(`Calculating ${home.name} vs ${away.name}`);

        const [homeHistory, awayHistory] = await Promise.all([
          getTeamHistory(home.id, today),
          getTeamHistory(away.id, today)
        ]);

        if (!homeHistory.length || !awayHistory.length) {
          console.log("Skipped: insufficient completed match history.");
          continue;
        }

        const calculation = calculatePrediction(
          homeHistory,
          awayHistory
        );

        predictions.push({
          fixtureId: match.id,
          date: match.utcDate,
          timestamp: Math.floor(
            new Date(match.utcDate).getTime() / 1000
          ),
          league: competition.name,
          country: match.area?.name || "",
          home: home.name,
          away: away.name,
          homeTeam: home.name,
          awayTeam: away.name,
          status: match.status,
          ...calculation
        });
      } catch (error) {
        console.error(
          `Skipped ${home.name} vs ${away.name}: ${error.message}`
        );

        // Stop on authentication, permission or rate-limit errors.
        if (/HTTP (401|403|429)/i.test(error.message)) {
          throw error;
        }
      }
    }

    if (predictions.length >= MAX_FIXTURES) break;
  }

  predictions.sort((a, b) => {
    if (b.probability !== a.probability) {
      return b.probability - a.probability;
    }

    return a.timestamp - b.timestamp;
  });

  const output = {
    updatedAt: new Date().toISOString(),
    date: today,
    timezone: TIMEZONE,
    provider: "football-data.org",
    calculationMethod: "Neutral venue; no home-advantage bonus",
    totalFixtures: predictions.length,
    predictions,
    fixtures: predictions,
    matches: predictions,
    topTips: predictions.slice(0, 6)
  };

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(output, null, 2) + "\n",
    "utf8"
  );

  console.log("Predictions saved:", OUTPUT_FILE);
  console.log("Predictions generated:", predictions.length);
}

main().catch(error => {
  console.error("Prediction update failed:", error.message);
  process.exitCode = 1;
});
