
const fs = require("fs");
const path = require("path");

const API_URL = "https://api.football-data.org/v4";
const API_KEY = (process.env.FOOTBALL_DATA_API_KEY || "").trim();
const TIMEZONE = "Africa/Nairobi";
const OUTPUT_FILE = path.join(__dirname, "predictions.json");

const MAX_FIXTURES = 40;
const HISTORY_MATCHES = 6;
const MIN_HISTORY_MATCHES = 3;

const COMPETITIONS = [
  { code: "PL", name: "Premier League" },
  { code: "PD", name: "La Liga" },
  { code: "BL1", name: "Bundesliga" },
  { code: "SA", name: "Serie A" },
  { code: "CL", name: "Champions League" }
];

function kenyaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const result = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = part.value;
  }

  return `${result.year}-${result.month}-${result.day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function apiRequest(endpoint) {
  const response = await fetch(`${API_URL}${endpoint}`, {
    headers: { "X-Auth-Token": API_KEY }
  });

  const body = await response.text();
  let data;

  try {
    data = JSON.parse(body);
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
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
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
  const result = {
    homeWin: 0,
    draw: 0,
    awayWin: 0,
    over15: 0,
    over25: 0,
    under45: 0,
    homeScores: 0,
    awayScores: 0
  };

  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const probability =
        poissonProbability(homeGoals, h) *
        poissonProbability(awayGoals, a);

      if (h > a) result.homeWin += probability;
      else if (h === a) result.draw += probability;
      else result.awayWin += probability;

      if (h + a >= 2) result.over15 += probability;
      if (h + a >= 3) result.over25 += probability;
      if (h + a <= 4) result.under45 += probability;
      if (h > 0) result.homeScores += probability;
      if (a > 0) result.awayScores += probability;
    }
  }

  return result;
}

function teamHistory(teamId, allMatches, beforeDate) {
  return allMatches
    .filter(match => {
      if (match.status !== "FINISHED") return false;
      if (!match.utcDate || match.utcDate.slice(0, 10) >= beforeDate) {
        return false;
      }

      const score = match.score?.fullTime;
      const isHome = match.homeTeam?.id === teamId;
      const isAway = match.awayTeam?.id === teamId;

      return (
        (isHome || isAway) &&
        Number.isFinite(score?.home) &&
        Number.isFinite(score?.away)
      );
    })
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, HISTORY_MATCHES)
    .map(match => {
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
  const homeAttack = average(homeHistory.map(m => m.scored));
  const homeConcede = average(homeHistory.map(m => m.conceded));
  const awayAttack = average(awayHistory.map(m => m.scored));
  const awayConcede = average(awayHistory.map(m => m.conceded));

  // No home-advantage bonus. Both teams are evaluated neutrally.
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

  const p = calculateProbabilities(expectedHomeGoals, expectedAwayGoals);

  const markets = [
    { market: "Double Chance 1X", probability: p.homeWin + p.draw },
    { market: "Double Chance X2", probability: p.awayWin + p.draw },
    { market: "Over 1.5 Goals", probability: p.over15 },
    { market: "Under 4.5 Goals", probability: p.under45 },
    { market: "Over 2.5 Goals", probability: p.over25 },
    {
      market: "Both Teams To Score",
      probability: p.homeScores * p.awayScores
    },
    { market: "Home Win", probability: p.homeWin },
    { market: "Draw", probability: p.draw },
    { market: "Away Win", probability: p.awayWin }
  ]
    .map(item => ({
      market: item.market,
      probability: Number((item.probability * 100).toFixed(1))
    }))
    .sort((a, b) => b.probability - a.probability);

  return {
    predictionAvailable: true,
    expectedHomeGoals: Number(expectedHomeGoals.toFixed(2)),
    expectedAwayGoals: Number(expectedAwayGoals.toFixed(2)),
    predictedScore:
      `${Math.round(expectedHomeGoals)}-${Math.round(expectedAwayGoals)}`,
    markets,
    bestPick: markets[0].market,
    probability: markets[0].probability,
    calculationMethod: "Neutral model; no home-advantage bonus",
    historyMatchesUsed: {
      home: homeHistory.length,
      away: awayHistory.length
    }
  };
}

function unavailablePrediction(homeHistory, awayHistory) {
  return {
    predictionAvailable: false,
    expectedHomeGoals: null,
    expectedAwayGoals: null,
    predictedScore: null,
    markets: [],
    bestPick: "Prediction unavailable",
    probability: null,
    calculationMethod: "Insufficient verified match history",
    historyMatchesUsed: {
      home: homeHistory.length,
      away: awayHistory.length
    }
  };
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "FOOTBALL_DATA_API_KEY is missing. Check GitHub Settings > Secrets and variables > Actions."
    );
  }

  const today = kenyaDate();
  const lastFixtureDate = addDays(today, 7);
  const endExclusive = addDays(today, 8);
  const historyStart = addDays(today, -365);

  console.log("Football-data.org key detected.");
  console.log("Kenya date:", today);
  console.log(
    `Searching fixtures: ${today} to ${lastFixtureDate}`
  );

  const allMatchesById = new Map();
  const requestedCompetitions = new Set();

  // Fetch each competition's recent history and upcoming schedule.
  // One request per competition helps avoid excessive API calls.
  for (const competition of COMPETITIONS) {
    console.log(`Loading ${competition.name} data...`);

    const endpoint =
      `/competitions/${encodeURIComponent(competition.code)}/matches` +
      `?dateFrom=${historyStart}` +
      `&dateTo=${endExclusive}` +
      `&limit=500`;

    try {
      const data = await apiRequest(endpoint);
      requestedCompetitions.add(competition.code);

      const matches = Array.isArray(data.matches) ? data.matches : [];

      console.log(
        `${competition.name}: ${matches.length} matches returned.`
      );

      for (const match of matches) {
        if (!match.id || !match.utcDate) continue;
        if (!match.homeTeam?.id || !match.awayTeam?.id) continue;

        // Keep the match exactly as returned by the provider.
        if (!allMatchesById.has(match.id)) {
          allMatchesById.set(match.id, {
            ...match,
            _competitionCode: competition.code,
            _competitionName:
              match.competition?.name || competition.name
          });
        }
      }
    } catch (error) {
      console.error(
        `Could not load ${competition.name}: ${error.message}`
      );

      // Authentication and rate-limit errors should stop the run.
      if (/HTTP (401|403|429)/i.test(error.message)) {
        throw error;
      }
    }
  }

  const allMatches = Array.from(allMatchesById.values());

  // Select only real, upcoming fixtures in the requested date window.
  const fixtureMap = new Map();

  for (const match of allMatches) {
    const matchDate = match.utcDate.slice(0, 10);

    if (matchDate < today || matchDate > lastFixtureDate) continue;
    if (!["SCHEDULED", "TIMED"].includes(match.status)) continue;
    if (!requestedCompetitions.has(match._competitionCode)) continue;

    fixtureMap.set(match.id, match);
  }

  const fixtures = Array.from(fixtureMap.values())
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .slice(0, MAX_FIXTURES);

  console.log("Unique upcoming fixtures found:", fixtures.length);

  const predictions = [];

  for (const match of fixtures) {
    const home = match.homeTeam;
    const away = match.awayTeam;

    const homeHistory = teamHistory(home.id, allMatches, today);
    const awayHistory = teamHistory(away.id, allMatches, today);

    let calculation;

    if (
      homeHistory.length >= MIN_HISTORY_MATCHES &&
      awayHistory.length >= MIN_HISTORY_MATCHES
    ) {
      calculation = calculatePrediction(homeHistory, awayHistory);
    } else {
      calculation = unavailablePrediction(homeHistory, awayHistory);

      console.log(
        `Prediction unavailable: ${home.name} vs ${away.name}; ` +
        `history home=${homeHistory.length}, away=${awayHistory.length}`
      );
    }

    predictions.push({
      fixtureId: match.id,
      date: match.utcDate,
      timestamp: Math.floor(new Date(match.utcDate).getTime() / 1000),
      league: match._competitionName,
      competitionCode: match._competitionCode,
      country: match.area?.name || "",
      home: home.name,
      away: away.name,
      homeTeam: home.name,
      awayTeam: away.name,
      status: match.status,
      ...calculation
    });
  }

  // Keep the main fixture list chronological.
  predictions.sort((a, b) => a.timestamp - b.timestamp);

  // Only actual calculated predictions qualify for top tips.
  const topTips = predictions
    .filter(item => item.predictionAvailable === true)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 6);

  const output = {
    updatedAt: new Date().toISOString(),
    date: today,
    timezone: TIMEZONE,
    provider: "football-data.org",
    calculationMethod: "Neutral model; no home-advantage bonus",
    totalFixtures: predictions.length,
    totalPredictionsAvailable: predictions.filter(
      item => item.predictionAvailable
    ).length,
    totalPredictionsUnavailable: predictions.filter(
      item => !item.predictionAvailable
    ).length,
    competitionsChecked: Array.from(requestedCompetitions),
    predictions,
    fixtures: predictions,
    matches: predictions,
    topTips
  };

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(output, null, 2) + "\n",
    "utf8"
  );

  console.log("Predictions saved:", OUTPUT_FILE);
  console.log("Fixtures saved:", predictions.length);
  console.log("Calculated predictions:", output.totalPredictionsAvailable);
  console.log("Predictions unavailable:", output.totalPredictionsUnavailable);

  if (predictions.length === 0) {
    console.error(
      "WARNING: No upcoming fixtures were returned for the selected competitions and date range."
    );
    console.error(
      "Check the competition access allowed by your API plan and the provider's fixture schedule."
    );
  }
}

main().catch(error => {
  console.error("Prediction update failed:", error.message);
  process.exitCode = 1;
});
