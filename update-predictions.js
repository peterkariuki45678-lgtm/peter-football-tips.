
const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.football-data.org/v4";
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;

const OUTPUT_FILE = path.join(__dirname, "predictions.json");
const TIME_ZONE = "Africa/Nairobi";
const DAYS_AHEAD = 7;
const HISTORY_DAYS = 120;
const HISTORY_MATCHES = 6;

// football-data.org competition codes.
const COMPETITIONS = [
  { code: "PL", name: "ENGLISH PREMIER LEAGUE", country: "England" },
  { code: "PD", name: "SPANISH LA LIGA", country: "Spain" },
  { code: "BL1", name: "GERMAN BUNDESLIGA", country: "Germany" },
  { code: "SA", name: "ITALIAN SERIE A", country: "Italy" },
  { code: "CL", name: "UEFA CHAMPIONS LEAGUE", country: "Europe" }
];

if (!API_KEY || !API_KEY.trim()) {
  throw new Error(
    "Missing FOOTBALL_DATA_API_KEY. Check GitHub Settings > Secrets and variables > Actions."
  );
}

function dateInKenya(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function apiGet(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Auth-Token": API_KEY.trim(),
      "Accept": "application/json"
    }
  });

  const bodyText = await response.text();
  let data;

  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(
      `football-data.org returned invalid JSON (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    const message =
      data.message ||
      data.error ||
      data.errorCode ||
      bodyText ||
      "Unknown API error";

    throw new Error(
      `football-data.org HTTP ${response.status}: ${String(message).slice(0, 500)}`
    );
  }

  return data;
}

function isCompleted(match) {
  return (
    ["FINISHED", "AWARDED"].includes(match.status) &&
    Number.isFinite(match.score?.fullTime?.home) &&
    Number.isFinite(match.score?.fullTime?.away)
  );
}

function isUpcoming(match, today, lastDay) {
  const matchDate = match.utcDate?.slice(0, 10);

  return (
    match.id != null &&
    match.homeTeam?.id != null &&
    match.awayTeam?.id != null &&
    match.homeTeam.id !== match.awayTeam.id &&
    ["SCHEDULED", "TIMED"].includes(match.status) &&
    matchDate >= today &&
    matchDate <= lastDay
  );
}

function matchGoalsForTeam(match, teamId) {
  const home = match.homeTeam.id === teamId;
  const teamGoals = home
    ? match.score.fullTime.home
    : match.score.fullTime.away;
  const opponentGoals = home
    ? match.score.fullTime.away
    : match.score.fullTime.home;

  return { scored: teamGoals, conceded: opponentGoals };
}

function buildTeamHistory(historyMatches) {
  const byTeam = new Map();

  for (const match of historyMatches) {
    if (!isCompleted(match)) continue;

    for (const team of [match.homeTeam, match.awayTeam]) {
      if (!team?.id) continue;

      if (!byTeam.has(team.id)) {
        byTeam.set(team.id, []);
      }

      byTeam.get(team.id).push({
        date: match.utcDate,
        ...matchGoalsForTeam(match, team.id)
      });
    }
  }

  for (const [teamId, matches] of byTeam) {
    matches.sort((a, b) => new Date(b.date) - new Date(a.date));
    byTeam.set(teamId, matches.slice(0, HISTORY_MATCHES));
  }

  return byTeam;
}

function leagueAverage(historyMatches) {
  let totalGoals = 0;
  let totalTeams = 0;

  for (const match of historyMatches) {
    if (!isCompleted(match)) continue;

    totalGoals +=
      match.score.fullTime.home + match.score.fullTime.away;
    totalTeams += 2;
  }

  // Neutral fallback: both sides receive the same baseline.
  const average = totalTeams > 0 ? totalGoals / totalTeams : 1.35;

  return clamp(average, 0.5, 2.5);
}

function teamRates(teamId, teamHistory, baseline) {
  const matches = teamHistory.get(teamId) || [];

  if (matches.length === 0) {
    return {
      scored: baseline,
      conceded: baseline,
      matchesUsed: 0
    };
  }

  const scored = matches.reduce((sum, m) => sum + m.scored, 0);
  const conceded = matches.reduce((sum, m) => sum + m.conceded, 0);

  return {
    scored: scored / matches.length,
    conceded: conceded / matches.length,
    matchesUsed: matches.length
  };
}

function poisson(lambda, goals) {
  let probability = Math.exp(-lambda);

  for (let i = 1; i <= goals; i++) {
    probability *= lambda / i;
  }

  return probability;
}

function calculateMarkets(homeXg, awayXg) {
  const maxGoals = 10;
  const homeGoals = [];
  const awayGoals = [];

  for (let goals = 0; goals <= maxGoals; goals++) {
    homeGoals.push(poisson(homeXg, goals));
    awayGoals.push(poisson(awayXg, goals));
  }

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let under25 = 0;
  let under35 = 0;
  let under45 = 0;
  let bttsYes = 0;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const probability = homeGoals[h] * awayGoals[a];

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      const total = h + a;

      if (total >= 2) over15 += probability;
      if (total >= 3) over25 += probability;
      if (total >= 4) over35 += probability;

      if (total <= 2) under25 += probability;
      if (total <= 3) under35 += probability;
      if (total <= 4) under45 += probability;

      if (h > 0 && a > 0) bttsYes += probability;
    }
  }

  const oneX = homeWin + draw;
  const xTwo = draw + awayWin;
  const twelve = homeWin + awayWin;

  const markets = {
    homeWin,
    draw,
    awayWin,
    "1X": oneX,
    "X2": xTwo,
    "12": twelve,
    over15,
    over25,
    over35,
    under25,
    under35,
    under45,
    bttsYes,
    bttsNo: 1 - bttsYes
  };

  for (const key of Object.keys(markets)) {
    markets[key] = clamp(markets[key], 0, 1);
  }

  return markets;
}

function chooseBestPick(markets) {
  const candidates = [
    { name: "Over 1.5 Goals", probability: markets.over15 },
    { name: "Under 4.5 Goals", probability: markets.under45 },
    { name: "Double Chance 1X", probability: markets["1X"] },
    { name: "Double Chance X2", probability: markets["X2"] },
    { name: "Under 3.5 Goals", probability: markets.under35 },
    { name: "Both Teams To Score - No", probability: markets.bttsNo },
    { name: "Over 2.5 Goals", probability: markets.over25 }
  ];

  candidates.sort((a, b) => b.probability - a.probability);

  return {
    name: candidates[0].name,
    probability: candidates[0].probability
  };
}

function predictFixture(match, teamHistory, baseline, competition) {
  const homeId = match.homeTeam.id;
  const awayId = match.awayTeam.id;

  const home = teamRates(homeId, teamHistory, baseline);
  const away = teamRates(awayId, teamHistory, baseline);

  // Neutral-ground model: no home advantage or venue multiplier.
  // Both teams are assessed using the same formula.
  const homeXg = clamp((home.scored + away.conceded) / 2, 0.15, 4.0);
  const awayXg = clamp((away.scored + home.conceded) / 2, 0.15, 4.0);

  const markets = calculateMarkets(homeXg, awayXg);
  const bestPick = chooseBestPick(markets);

  const predictionQuality =
    home.matchesUsed >= 5 && away.matchesUsed >= 5
      ? "GOOD_HISTORY"
      : home.matchesUsed >= 3 && away.matchesUsed >= 3
        ? "LIMITED_HISTORY"
        : "LOW_HISTORY";

  return {
    fixtureId: match.id,
    date: match.utcDate.slice(0, 10),
    timestamp: match.utcDate,
    kickoffKenya: new Date(match.utcDate).toLocaleString("en-GB", {
      timeZone: TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short"
    }),
    league: competition.name,
    competitionCode: competition.code,
    leagueId: match.competition?.id ?? null,
    country: match.area?.name || competition.country,
    season: match.season?.startDate?.slice(0, 4) || null,
    home: match.homeTeam.name,
    away: match.awayTeam.name,
    homeTeamId: homeId,
    awayTeamId: awayId,
    status: match.status,
    predictionAvailable: true,
    expectedGoals: {
      home: round(homeXg, 2),
      away: round(awayXg, 2)
    },
    predictedScore: `${Math.round(homeXg)}-${Math.round(awayXg)}`,
    probabilities: {
      homeWin: round(markets.homeWin, 4),
      draw: round(markets.draw, 4),
      awayWin: round(markets.awayWin, 4),
      homeOrDraw: round(markets["1X"], 4),
      drawOrAway: round(markets["X2"], 4),
      over15: round(markets.over15, 4),
      over25: round(markets.over25, 4),
      under25: round(markets.under25, 4),
      under35: round(markets.under35, 4),
      under45: round(markets.under45, 4),
      bttsYes: round(markets.bttsYes, 4),
      bttsNo: round(markets.bttsNo, 4)
    },
    markets: Object.fromEntries(
      Object.entries(markets).map(([key, value]) => [key, round(value, 4)])
    ),
    bestPick: bestPick.name,
    bestPickProbability: round(bestPick.probability, 4),
    calculationMethod: "Neutral-ground Poisson model; no home-advantage bonus",
    neutralGround: true,
    homeAdvantage: 0,
    historyMatchesUsed: {
      home: home.matchesUsed,
      away: away.matchesUsed
    },
    predictionQuality,
    source: "football-data.org API v4",
    generatedAt: new Date().toISOString()
  };
}

async function fetchCompetitionMatches(code, params) {
  const result = await apiGet(`/competitions/${code}/matches`, params);
  return Array.isArray(result.matches) ? result.matches : [];
}

async function main() {
  const today = dateInKenya();
  const lastDay = addDays(today, DAYS_AHEAD);
  const historyStart = addDays(today, -HISTORY_DAYS);
  const yesterday = addDays(today, -1);

  console.log(`Kenya date: ${today}`);
  console.log(`Fixture window: ${today} to ${lastDay}`);
  console.log(`History window: ${historyStart} to ${yesterday}`);
  console.log("Provider: football-data.org v4");
  console.log("Model: neutral ground; no home-advantage bonus.");

  const allPredictions = [];
  const failedCompetitions = [];

  for (const competition of COMPETITIONS) {
    console.log(`Loading ${competition.name} (${competition.code})...`);

    try {
      // One request for upcoming fixtures and one for recent league history.
      const upcoming = await fetchCompetitionMatches(competition.code, {
        dateFrom: today,
        dateTo: lastDay
      });

      const history = await fetchCompetitionMatches(competition.code, {
        dateFrom: historyStart,
        dateTo: yesterday,
        status: "FINISHED"
      });

      const genuineUpcoming = upcoming
        .filter(match => isUpcoming(match, today, lastDay))
        .filter(match => match.competition?.code === competition.code);

      const finishedHistory = history.filter(isCompleted);
      const teamHistory = buildTeamHistory(finishedHistory);
      const baseline = leagueAverage(finishedHistory);

      console.log(
        `${competition.code}: ${genuineUpcoming.length} upcoming fixtures; ` +
        `${finishedHistory.length} completed history matches.`
      );

      for (const match of genuineUpcoming) {
        allPredictions.push(
          predictFixture(match, teamHistory, baseline, competition)
        );
      }
    } catch (error) {
      console.error(`${competition.code} could not be loaded: ${error.message}`);
      failedCompetitions.push(competition.code);
    }
  }

  // Do not invent fixtures or retain stale predictions from an old file.
  const unique = new Map();

  for (const prediction of allPredictions) {
    if (!unique.has(prediction.fixtureId)) {
      unique.set(prediction.fixtureId, prediction);
    }
  }

  const predictions = [...unique.values()].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  if (predictions.length === 0) {
    throw new Error(
      "No verified upcoming fixtures were returned. " +
      `Failed competitions: ${failedCompetitions.join(", ") || "none"}. ` +
      "Check the API subscription, competition access, and date window. " +
      "The existing predictions.json has not been overwritten."
    );
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(predictions, null, 2) + "\n",
    "utf8"
  );

  console.log(`Saved ${predictions.length} verified fixtures to predictions.json.`);

  if (failedCompetitions.length) {
    console.warn(
      `Some competitions were unavailable: ${failedCompetitions.join(", ")}`
    );
  }
}

main().catch(error => {
  console.error(`Prediction update failed: ${error.message}`);
  process.exitCode = 1;
});
