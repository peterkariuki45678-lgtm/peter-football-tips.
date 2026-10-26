
"use strict";

const fs = require("fs");
const path = require("path");

const API_URL = "https://v3.football.api-sports.io";
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;

const OUTPUT_FILE = path.join(__dirname, "predictions.json");
const TIMEZONE = "Africa/Nairobi";
const DAYS_AHEAD = 7;
const FORM_MATCHES = 8;
const MAX_FORM_TEAMS = 60;
const MAX_GOALS = 10;

function kenyaDate(date) {
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

async function api(endpoint, params = {}) {
  const url = new URL(`${API_URL}/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error(`API returned invalid JSON for ${endpoint}.`);
  }

  if (!response.ok) {
    throw new Error(
      `API HTTP ${response.status}: ${JSON.stringify(body.errors || body)}`
    );
  }

  if (body.errors && Object.keys(body.errors).length > 0) {
    throw new Error(`API error: ${JSON.stringify(body.errors)}`);
  }

  if (!Array.isArray(body.response)) {
    throw new Error(`Unexpected API response from ${endpoint}.`);
  }

  return body.response;
}

function poisson(lambda, goals) {
  let probability = Math.exp(-lambda);

  for (let i = 1; i <= goals; i++) {
    probability *= lambda / i;
  }

  // P(0 goals) must be exp(-lambda).
  if (goals === 0) return Math.exp(-lambda);

  return probability;
}

function calculatePredictions(homeExpected, awayExpected) {
  const homeXg = Math.max(0.15, Math.min(4.5, homeExpected));
  const awayXg = Math.max(0.15, Math.min(4.5, awayExpected));

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
  let bttsNo = 0;
  let totalMass = 0;
  let highestScoreProbability = -1;
  let predictedScore = "1-1";

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const probability = poisson(homeXg, h) * poisson(awayXg, a);
      totalMass += probability;

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 2) over15 += probability;
      if (h + a >= 3) over25 += probability;
      if (h + a >= 4) over35 += probability;

      if (h + a <= 2) under25 += probability;
      if (h + a <= 3) under35 += probability;
      if (h + a <= 4) under45 += probability;

      if (h > 0 && a > 0) bttsYes += probability;
      else bttsNo += probability;

      if (probability > highestScoreProbability) {
        highestScoreProbability = probability;
        predictedScore = `${h}-${a}`;
      }
    }
  }

  // Normalize for the small probability mass beyond 10 goals.
  const pct = value =>
    Number((100 * value / totalMass).toFixed(1));

  const markets = {
    "Home Win": pct(homeWin),
    "Draw": pct(draw),
    "Away Win": pct(awayWin),
    "1X": pct(homeWin + draw),
    "X2": pct(draw + awayWin),
    "12": pct(homeWin + awayWin),
    "Over 1.5": pct(over15),
    "Under 2.5": pct(under25),
    "Over 2.5": pct(over25),
    "Under 3.5": pct(under35),
    "Over 3.5": pct(over35),
    "Under 4.5": pct(under45),
    "BTTS Yes": pct(bttsYes),
    "BTTS No": pct(bttsNo)
  };

  const candidates = [
    ["Over 1.5", markets["Over 1.5"]],
    ["Under 4.5", markets["Under 4.5"]],
    ["1X", markets["1X"]],
    ["X2", markets["X2"]],
    ["Under 3.5", markets["Under 3.5"]],
    ["BTTS No", markets["BTTS No"]],
    ["Over 2.5", markets["Over 2.5"]]
  ];

  candidates.sort((a, b) => b[1] - a[1]);

  return {
    expectedGoalsHome: Number(homeXg.toFixed(2)),
    expectedGoalsAway: Number(awayXg.toFixed(2)),
    predictedScore,
    probabilities: {
      homeWin: markets["Home Win"],
      draw: markets["Draw"],
      awayWin: markets["Away Win"]
    },
    markets,
    bestPick: candidates[0][0],
    bestPickProbability: candidates[0][1]
  };
}

function isCompleted(fixture) {
  return ["FT", "AET", "PEN"].includes(
    fixture.fixture?.status?.short
  );
}

function validResult(fixture) {
  return (
    isCompleted(fixture) &&
    Number.isFinite(fixture.goals?.home) &&
    Number.isFinite(fixture.goals?.away)
  );
}

function getTeamForm(fixtures, teamId) {
  const scored = [];
  const conceded = [];

  for (const fixture of fixtures) {
    if (!validResult(fixture)) continue;

    if (fixture.teams.home.id === teamId) {
      scored.push(fixture.goals.home);
      conceded.push(fixture.goals.away);
    } else if (fixture.teams.away.id === teamId) {
      scored.push(fixture.goals.away);
      conceded.push(fixture.goals.home);
    }
  }

  const count = scored.length;

  return {
    played: count,
    scored: count
      ? scored.reduce((sum, goals) => sum + goals, 0) / count
      : null,
    conceded: count
      ? conceded.reduce((sum, goals) => sum + goals, 0) / count
      : null
  };
}

function fallbackExpectedGoals() {
  // Clearly marked fallback when team results are unavailable.
  // These are estimates, not retrieved team statistics.
  return {
    home: 1.35,
    away: 1.20
  };
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "Missing FOOTBALL_DATA_API_KEY. Check GitHub repository Settings > Secrets and variables > Actions, and ensure the workflow passes secrets.FOOTBALL_DATA_API_KEY to this script."
    );
  }

  const today = kenyaDate(new Date());
  const endDate = addDays(today, DAYS_AHEAD);

  console.log(`Kenya date: ${today}`);
  console.log(`Fixture window: ${today} to ${endDate}`);
  console.log("Model: neutral ground; no home-advantage bonus.");

  const fixtures = await api("fixtures", {
    from: today,
    to: endDate,
    timezone: TIMEZONE
  });

  const upcoming = fixtures
    .filter(fixture =>
      Number.isInteger(fixture.fixture?.id) &&
      fixture.teams?.home?.id &&
      fixture.teams?.away?.id &&
      fixture.teams?.home?.name &&
      fixture.teams?.away?.name &&
      fixture.teams.home.id !== fixture.teams.away.id &&
      fixture.fixture?.date &&
      ["NS", "TBD"].includes(fixture.fixture.status.short)
    )
    .sort(
      (a, b) =>
        new Date(a.fixture.date) - new Date(b.fixture.date)
    );

  if (upcoming.length === 0) {
    throw new Error(
      `No upcoming fixtures were returned by API-Football for ${today} to ${endDate}. Existing predictions.json has not been changed.`
    );
  }

  console.log(`Valid upcoming API fixtures: ${upcoming.length}`);

  const teamIds = [
    ...new Set(
      upcoming.flatMap(fixture => [
        fixture.teams.home.id,
        fixture.teams.away.id
      ])
    )
  ];

  const formCache = new Map();
  const teamsToFetch = teamIds.slice(0, MAX_FORM_TEAMS);

  for (const teamId of teamsToFetch) {
    try {
      const recentFixtures = await api("fixtures", {
        team: teamId,
        last: FORM_MATCHES,
        timezone: TIMEZONE
      });

      formCache.set(teamId, getTeamForm(recentFixtures, teamId));
    } catch (error) {
      console.error(
        `Could not load recent results for team ${teamId}: ${error.message}`
      );

      formCache.set(teamId, {
        played: 0,
        scored: null,
        conceded: null
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const output = [];

  for (const fixture of upcoming) {
    const homeId = fixture.teams.home.id;
    const awayId = fixture.teams.away.id;

    const homeForm = formCache.get(homeId) || {
      played: 0,
      scored: null,
      conceded: null
    };

    const awayForm = formCache.get(awayId) || {
      played: 0,
      scored: null,
      conceded: null
    };

    const hasUsableForm =
      homeForm.played >= 3 &&
      awayForm.played >= 3 &&
      Number.isFinite(homeForm.scored) &&
      Number.isFinite(homeForm.conceded) &&
      Number.isFinite(awayForm.scored) &&
      Number.isFinite(awayForm.conceded);

    let expectedHome;
    let expectedAway;
    let method;

    if (hasUsableForm) {
      // Same calculation for both teams; no home-ground adjustment.
      expectedHome = (homeForm.scored + awayForm.conceded) / 2;
      expectedAway = (awayForm.scored + homeForm.conceded) / 2;

      method =
        "Recent results, symmetric neutral-ground Poisson model";
    } else {
      const fallback = fallbackExpectedGoals();

      expectedHome = fallback.home;
      expectedAway = fallback.away;

      method =
        "Fallback estimate; insufficient recent team results; neutral-ground Poisson model";
    }

    const prediction = calculatePredictions(
      expectedHome,
      expectedAway
    );

    const kickoff = new Date(fixture.fixture.date);

    output.push({
      fixtureId: fixture.fixture.id,
      date: fixture.fixture.date,
      timestamp: Math.floor(kickoff.getTime() / 1000),

      kickoffKenya: new Intl.DateTimeFormat("en-GB", {
        timeZone: TIMEZONE,
        dateStyle: "medium",
        timeStyle: "short"
      }).format(kickoff),

      league: fixture.league.name,
      competitionCode: String(fixture.league.id),
      leagueId: fixture.league.id,
      country: fixture.league.country || "",
      season: fixture.league.season,

      home: fixture.teams.home.name,
      away: fixture.teams.away.name,
      homeTeamId: homeId,
      awayTeamId: awayId,

      status: fixture.fixture.status.short,
      predictionAvailable: true,

      expectedGoalsHome: prediction.expectedGoalsHome,
      expectedGoalsAway: prediction.expectedGoalsAway,
      predictedScore: prediction.predictedScore,
      probabilities: prediction.probabilities,
      markets: prediction.markets,

      bestPick: prediction.bestPick,
      bestPickProbability: prediction.bestPickProbability,

      calculationMethod: method,
      neutralGround: true,
      homeAdvantage: 0,

      historyMatchesUsed: {
        home: homeForm.played,
        away: awayForm.played
      },

      source: "API-Football",
      generatedAt
    });
  }

  // Deduplicate by the actual fixture ID returned by the API.
  const uniqueFixtures = [
    ...new Map(
      output.map(fixture => [fixture.fixtureId, fixture])
    ).values()
  ];

  // Write a JSON array to retain compatibility with websites
  // that iterate directly over predictions.json.
  const temporaryFile = `${OUTPUT_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(uniqueFixtures, null, 2) + "\n",
    "utf8"
  );

  fs.renameSync(temporaryFile, OUTPUT_FILE);

  console.log(
    `Successfully wrote ${uniqueFixtures.length} fixtures to predictions.json.`
  );
  console.log(`Generated at: ${generatedAt}`);
  console.log(`Recent team-form requests: ${teamsToFetch.length}`);
  console.log(
    `Fixtures without sufficient form: ${
      uniqueFixtures.filter(f =>
        f.calculationMethod.startsWith("Fallback estimate")
      ).length
    }`
  );
}

main().catch(error => {
  console.error("Prediction update failed:", error.message);
  process.exitCode = 1;
});
