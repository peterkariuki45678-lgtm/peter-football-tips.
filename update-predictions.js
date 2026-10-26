
const fs = require("fs");
const path = require("path");

const API_URL = "https://v3.football.api-sports.io";
const API_KEY = (process.env.API_FOOTBALL_KEY || "").trim();
const TIMEZONE = "Africa/Nairobi";
const OUTPUT_FILE = path.join(__dirname, "predictions.json");
const MAX_FIXTURES = 40;
const HISTORY_MATCHES = 6;

function kenyaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function apiRequest(endpoint, params = {}) {
  const url = new URL(`${API_URL}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok || data.errors?.token || data.errors?.requests) {
    throw new Error(
      `API-Football HTTP ${response.status}: ${JSON.stringify(data.errors || data)}`
    );
  }

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
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

function goalProbabilities(homeGoals, awayGoals) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let over25 = 0;
  let under45 = 0;
  let homeScores = 0;
  let awayScores = 0;

  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
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
  const data = await apiRequest("/fixtures", {
    team: teamId,
    last: HISTORY_MATCHES,
    status: "FT",
    to: addDays(beforeDate, -1),
    timezone: TIMEZONE
  });

  return (data.response || [])
    .filter(match =>
      match.fixture.status.short === "FT" ||
      match.fixture.status.short === "AET" ||
      match.fixture.status.short === "PEN"
    )
    .slice(0, HISTORY_MATCHES)
    .map(match => {
      const isHome = match.teams.home.id === teamId;
      return {
        scored: isHome ? match.goals.home : match.goals.away,
        conceded: isHome ? match.goals.away : match.goals.home
      };
    })
    .filter(match =>
      Number.isFinite(match.scored) &&
      Number.isFinite(match.conceded)
    );
}

function calculatePrediction(homeHistory, awayHistory) {
  const homeAttack = average(homeHistory.map(m => m.scored));
  const homeConcede = average(homeHistory.map(m => m.conceded));
  const awayAttack = average(awayHistory.map(m => m.scored));
  const awayConcede = average(awayHistory.map(m => m.conceded));

  // Neutral calculation: neither team receives a home-advantage bonus.
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

  const probabilities = goalProbabilities(
    expectedHomeGoals,
    expectedAwayGoals
  );

  const markets = [
    {
      market: "Double Chance 1X",
      probability: probabilities.homeWin + probabilities.draw
    },
    {
      market: "Double Chance X2",
      probability: probabilities.awayWin + probabilities.draw
    },
    {
      market: "Over 1.5 Goals",
      probability: probabilities.over15
    },
    {
      market: "Under 4.5 Goals",
      probability: probabilities.under45
    },
    {
      market: "Over 2.5 Goals",
      probability: probabilities.over25
    },
    {
      market: "Both Teams To Score",
      probability: probabilities.homeScores * probabilities.awayScores
    },
    {
      market: "Home Win",
      probability: probabilities.homeWin
    },
    {
      market: "Draw",
      probability: probabilities.draw
    },
    {
      market: "Away Win",
      probability: probabilities.awayWin
    }
  ].map(item => ({
    ...item,
    probability: Math.round(item.probability * 1000) / 10
  }));

  markets.sort((a, b) => b.probability - a.probability);

  return {
    expectedHomeGoals: Number(expectedHomeGoals.toFixed(2)),
    expectedAwayGoals: Number(expectedAwayGoals.toFixed(2)),
    predictedScore:
      `${Math.round(expectedHomeGoals)}-${Math.round(expectedAwayGoals)}`,
    markets,
    bestPick: markets[0].market,
    probability: markets[0].probability,
    historyMatchesUsed: {
      home: homeHistory.length,
      away: awayHistory.length
    }
  };
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "API_FOOTBALL_KEY is missing. Check GitHub Settings > Secrets and variables > Actions."
    );
  }

  console.log("API key loaded. Character count:", API_KEY.length);

  const today = kenyaDate();
  const endDate = addDays(today, 7);

  console.log("Kenya date:", today);
  console.log(`Loading upcoming fixtures: ${today} to ${endDate}`);

  // Verify authentication first, independently of fixture availability.
  const status = await apiRequest("/status");
  console.log("API authentication accepted.");

  if (status.response?.subscription?.active === false) {
    throw new Error("Your API-Football subscription is not active.");
  }

  const fixturesData = await apiRequest("/fixtures", {
    from: today,
    to: endDate,
    timezone: TIMEZONE
  });

  const fixtures = (fixturesData.response || [])
    .filter(match => {
      const statusCode = match.fixture.status.short;
      return ["NS", "TBD"].includes(statusCode);
    })
    .slice(0, MAX_FIXTURES);

  console.log("Upcoming fixtures found:", fixtures.length);

  const predictions = [];

  for (const fixture of fixtures) {
    const home = fixture.teams.home;
    const away = fixture.teams.away;

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

      const calculation = calculatePrediction(homeHistory, awayHistory);

      predictions.push({
        fixtureId: fixture.fixture.id,
        date: fixture.fixture.date,
        timestamp: fixture.fixture.timestamp,
        league: fixture.league.name,
        country: fixture.league.country,
        home: home.name,
        away: away.name,
        homeTeam: home.name,
        awayTeam: away.name,
        status: fixture.fixture.status.short,
        ...calculation
      });
    } catch (error) {
      console.error(
        `Skipped ${home.name} vs ${away.name}: ${error.message}`
      );

      // Authentication and quota errors must stop the workflow.
      if (/application key|invalid.*key|rate limit|requests/i.test(error.message)) {
        throw error;
      }
    }
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
