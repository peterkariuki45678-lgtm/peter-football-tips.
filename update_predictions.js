
const fs = require("fs");

const API_URL = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY;

const OUTPUT_FILE = "predictions.json";
const TIMEZONE = "Africa/Nairobi";
const HISTORY_DAYS = 90;
const FUTURE_DAYS = 7;
const MAX_FIXTURES = 100;

function formatDate(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
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

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(
      "API-Football error: " + JSON.stringify(data.errors)
    );
  }

  if (!Array.isArray(data.response)) {
    throw new Error("API returned an invalid response.");
  }

  return data.response;
}

function isFinished(fixture) {
  return ["FT", "AET", "PEN"].includes(
    fixture.fixture?.status?.short
  );
}

function getLastSix(fixtures, teamId) {
  return fixtures
    .filter(f =>
      isFinished(f) &&
      (f.teams?.home?.id === teamId ||
       f.teams?.away?.id === teamId) &&
      Number.isInteger(f.goals?.home) &&
      Number.isInteger(f.goals?.away)
    )
    .sort((a, b) =>
      new Date(b.fixture.date) - new Date(a.fixture.date)
    )
    .slice(0, 6)
    .map(f => {
      const home = f.teams.home.id === teamId;
      const gf = home ? f.goals.home : f.goals.away;
      const ga = home ? f.goals.away : f.goals.home;

      return {
        gf,
        ga,
        result: gf > ga ? "W" : gf === ga ? "D" : "L",
        date: f.fixture.date
      };
    });
}

function averageStats(matches) {
  if (matches.length !== 6) return null;

  return matches.reduce(
    (s, m) => ({
      scored: s.scored + m.gf / 6,
      conceded: s.conceded + m.ga / 6
    }),
    { scored: 0, conceded: 0 }
  );
}

function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function poisson(k, lambda) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function calculate(homeStats, awayStats) {
  // Neutral-ground model: no home advantage multiplier.
  const homeGoals = Math.max(
    0.1,
    Math.min(5, (homeStats.scored + awayStats.conceded) / 2)
  );

  const awayGoals = Math.max(
    0.1,
    Math.min(5, (awayStats.scored + homeStats.conceded) / 2)
  );

  let home = 0, draw = 0, away = 0;
  let over15 = 0, under45 = 0, total = 0;

  for (let h = 0; h <= 12; h++) {
    for (let a = 0; a <= 12; a++) {
      const p = poisson(h, homeGoals) * poisson(a, awayGoals);
      total += p;

      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;

      if (h + a >= 2) over15 += p;
      if (h + a <= 4) under45 += p;
    }
  }

  const normalize = p => p / total;

  return {
    home: normalize(home),
    draw: normalize(draw),
    away: normalize(away),
    over15: normalize(over15),
    under45: normalize(under45),
    expectedHomeGoals: homeGoals,
    expectedAwayGoals: awayGoals
  };
}

function chooseMarket(p) {
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
      "API_FOOTBALL_KEY is missing. Check the GitHub Actions secret and workflow."
    );
  }

  const today = formatDate(new Date());
  const yesterday = addDays(today, -1);
  const historyStart = addDays(today, -HISTORY_DAYS);
  const futureEnd = addDays(today, FUTURE_DAYS);

  console.log(`Kenya date: ${today}`);
  console.log(`Loading history: ${historyStart} to ${yesterday}`);

  const history = await apiRequest("fixtures", {
    from: historyStart,
    to: yesterday,
    timezone: TIMEZONE
  });

  console.log(`Historical fixtures returned: ${history.length}`);

  console.log(`Loading upcoming fixtures: ${today} to ${futureEnd}`);

  const upcoming = await apiRequest("fixtures", {
    from: today,
    to: futureEnd,
    timezone: TIMEZONE
  });

  console.log(`Upcoming fixtures returned: ${upcoming.length}`);

  const finishedHistory = history.filter(isFinished);

  const fixtures = upcoming
    .filter(f =>
      ["NS", "TBD"].includes(f.fixture?.status?.short) &&
      f.teams?.home?.id &&
      f.teams?.away?.id
    )
    .sort((a, b) =>
      new Date(a.fixture.date) - new Date(b.fixture.date)
    );

  const predictions = [];
  let skipped = 0;

  for (const f of fixtures) {
    if (predictions.length >= MAX_FIXTURES) break;

    const homeLast6 = getLastSix(
      finishedHistory, f.teams.home.id
    );
    const awayLast6 = getLastSix(
      finishedHistory, f.teams.away.id
    );

    const homeStats = averageStats(homeLast6);
    const awayStats = averageStats(awayLast6);

    if (!homeStats || !awayStats) {
      skipped++;
      continue;
    }

    const p = calculate(homeStats, awayStats);
    const best = chooseMarket(p);

    predictions.push({
      fixtureId: f.fixture.id,
      league: f.league.name,
      country: f.league.country,
      leagueId: f.league.id,
      season: f.league.season,
      home: f.teams.home.name,
      away: f.teams.away.name,
      utcTime: new Intl.DateTimeFormat("en-GB", {
        timeZone: TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(f.fixture.date)),
      kickoff: f.fixture.date,
      homeLast6,
      awayLast6,
      safe_bet: best.name,
      confidence: (best.probability * 100).toFixed(1) + "%",
      raw_probabilities: {
        "1": (p.home * 100).toFixed(1),
        "X": (p.draw * 100).toFixed(1),
        "2": (p.away * 100).toFixed(1),
        over15: (p.over15 * 100).toFixed(1),
        under45: (p.under45 * 100).toFixed(1)
      },
      expected_goals: {
        home: Number(p.expectedHomeGoals.toFixed(2)),
        away: Number(p.expectedAwayGoals.toFixed(2))
      },
      calculation_model: "neutral_ground",
      home_advantage: 0,
      historical_matches_used: 6,
      data_source: "API-Football_KEY"
    });
  }

  if (predictions.length === 0) {
    throw new Error(
      `No eligible predictions generated. Upcoming fixtures: ${fixtures.length}; skipped for insufficient six-match history: ${skipped}. Check API coverage, date range and fixture availability. Existing predictions.json was not overwritten.`
    );
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(predictions, null, 2) + "\n",
    "utf8"
  );

  console.log(`Predictions generated: ${predictions.length}`);
  console.log(`Fixtures skipped for insufficient history: ${skipped}`);
  console.log(`Successfully saved ${OUTPUT_FILE}`);
}

main().catch(error => {
  console.error("Prediction update failed:", error.message);
  process.exit(1);
});
