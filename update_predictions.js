
const fs = require("fs");

const API_URL = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY;

const OUTPUT_FILE = "predictions.json";
const TIMEZONE = "Africa/Nairobi";
const HISTORY_DAYS = 90;
const FUTURE_DAYS = 7;
const MAX_FIXTURES = 100;

function dateInKenya(date) {
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
  const url = new URL(`${API_URL}/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(`API request failed: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(
      "API-Football error: " + JSON.stringify(data.errors)
    );
  }

  return data.response || [];
}

function validScore(value) {
  return Number.isInteger(value) && value >= 0;
}

function completedFixture(fixture) {
  return ["FT", "AET", "PEN"].includes(
    fixture.fixture?.status?.short
  );
}

function getTeamLastSix(fixtures, teamId) {
  return fixtures
    .filter(f => {
      if (!completedFixture(f)) return false;

      const homeId = f.teams?.home?.id;
      const awayId = f.teams?.away?.id;

      if (homeId !== teamId && awayId !== teamId) return false;

      return validScore(f.goals?.home) &&
             validScore(f.goals?.away);
    })
    .sort((a, b) =>
      new Date(b.fixture.date) - new Date(a.fixture.date)
    )
    .slice(0, 6)
    .map(f => {
      const isHome = f.teams.home.id === teamId;
      const gf = isHome ? f.goals.home : f.goals.away;
      const ga = isHome ? f.goals.away : f.goals.home;

      return {
        gf,
        ga,
        result: gf > ga ? "W" : gf === ga ? "D" : "L",
        date: f.fixture.date
      };
    });
}

function teamStats(lastSix) {
  if (!Array.isArray(lastSix) || lastSix.length < 6) {
    return null;
  }

  const total = lastSix.reduce((sum, match) => ({
    gf: sum.gf + match.gf,
    ga: sum.ga + match.ga
  }), { gf: 0, ga: 0 });

  return {
    scored: total.gf / lastSix.length,
    conceded: total.ga / lastSix.length
  };
}

function factorial(n) {
  let value = 1;
  for (let i = 2; i <= n; i++) value *= i;
  return value;
}

function poisson(k, lambda) {
  return Math.exp(-lambda) * Math.pow(lambda, k) /
    factorial(k);
}

function calculateProbabilities(homeStats, awayStats) {
  /*
   * Neutral-ground model:
   * No home-team multiplier or home-advantage bonus.
   * Both teams use the same calculation.
   */
  const expectedHomeGoals = Math.max(
    0.1,
    Math.min(5, (homeStats.scored + awayStats.conceded) / 2)
  );

  const expectedAwayGoals = Math.max(
    0.1,
    Math.min(5, (awayStats.scored + homeStats.conceded) / 2)
  );

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let under45 = 0;
  let totalProbability = 0;

  for (let h = 0; h <= 12; h++) {
    for (let a = 0; a <= 12; a++) {
      const probability =
        poisson(h, expectedHomeGoals) *
        poisson(a, expectedAwayGoals);

      totalProbability += probability;

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 2) over15 += probability;
      if (h + a <= 4) under45 += probability;
    }
  }

  // Normalize the probabilities to account for the score range.
  const normalize = value => value / totalProbability;

  const p = {
    home: normalize(homeWin),
    draw: normalize(draw),
    away: normalize(awayWin),
    over15: normalize(over15),
    under45: normalize(under45)
  };

  return {
    probabilities: p,
    expectedHomeGoals,
    expectedAwayGoals
  };
}

function selectSafestMarket(p) {
  const markets = [
    { name: "Double Chance (1X)", probability: p.home + p.draw },
    { name: "Double Chance (X2)", probability: p.draw + p.away },
    { name: "Over 1.5 Goals", probability: p.over15 },
    { name: "Under 4.5 Goals", probability: p.under45 }
  ];

  markets.sort((a, b) => b.probability - a.probability);

  return markets[0];
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "Missing API_FOOTBALL_KEY GitHub Actions secret."
    );
  }

  const today = dateInKenya(new Date());
  const yesterday = addDays(today, -1);
  const historyStart = addDays(today, -HISTORY_DAYS);
  const futureEnd = addDays(today, FUTURE_DAYS);

  console.log("Fetching completed fixtures for historical form...");
  console.log(`History range: ${historyStart} to ${yesterday}`);

  const history = await apiRequest("fixtures", {
    from: historyStart,
    to: yesterday,
    timezone: TIMEZONE
  });

  console.log(`Historical fixtures returned: ${history.length}`);

  console.log("Fetching upcoming fixtures across available competitions...");

  const upcoming = await apiRequest("fixtures", {
    from: today,
    to: futureEnd,
    timezone: TIMEZONE
  });

  console.log(`Upcoming fixtures returned: ${upcoming.length}`);

  const finishedHistory = history.filter(completedFixture);

  const eligibleFixtures = upcoming
    .filter(f => ["NS", "TBD"].includes(f.fixture?.status?.short))
    .filter(f => f.teams?.home?.id && f.teams?.away?.id)
    .sort((a, b) =>
      new Date(a.fixture.date) - new Date(b.fixture.date)
    );

  const predictions = [];
  let skipped = 0;

  for (const fixture of eligibleFixtures) {
    if (predictions.length >= MAX_FIXTURES) break;

    const homeId = fixture.teams.home.id;
    const awayId = fixture.teams.away.id;

    const homeLast6 = getTeamLastSix(finishedHistory, homeId);
    const awayLast6 = getTeamLastSix(finishedHistory, awayId);

    const homeStats = teamStats(homeLast6);
    const awayStats = teamStats(awayLast6);

    // Never invent form when historical data is unavailable.
    if (!homeStats || !awayStats) {
      skipped++;
      continue;
    }

    const result = calculateProbabilities(homeStats, awayStats);
    const p = result.probabilities;
    const best = selectSafestMarket(p);

    predictions.push({
      fixtureId: fixture.fixture.id,
      league: fixture.league.name,
      country: fixture.league.country,
      leagueId: fixture.league.id,
      season: fixture.league.season,
      utcTime: new Intl.DateTimeFormat("en-GB", {
        timeZone: TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(fixture.fixture.date)),
      kickoff: fixture.fixture.date,
      home: fixture.teams.home.name,
      away: fixture.teams.away.name,

      homeLast6,
      awayLast6,

      safe_bet: best.name,
      confidence: (best.probability * 100).toFixed(1) + "%",

      raw_probabilities: {
        "1": (p.home * 100).toFixed(1),
        "X": (p.draw * 100).toFixed(1),
        "2": (p.away * 100).toFixed(1),
        "over15": (p.over15 * 100).toFixed(1),
        "under45": (p.under45 * 100).toFixed(1)
      },

      expected_goals: {
        home: Number(result.expectedHomeGoals.toFixed(2)),
        away: Number(result.expectedAwayGoals.toFixed(2))
      },

      calculation_model: "neutral_ground",
      home_advantage: 0,
      historical_matches_used: 6,
      data_source: "API-Football"
    });
  }

  // Do not replace a previously generated file after a failed/empty
  // API response without first checking the API result.
  if (!Array.isArray(upcoming)) {
    throw new Error("Upcoming fixture response was invalid.");
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(predictions, null, 2) + "\n",
    "utf8"
  );

  console.log(`Predictions written: ${predictions.length}`);
  console.log(`Fixtures skipped for insufficient history: ${skipped}`);
  console.log(`Output saved to ${OUTPUT_FILE}`);
}

main().catch(error => {
  console.error("Prediction update failed:", error.message);
  process.exit(1);
});
