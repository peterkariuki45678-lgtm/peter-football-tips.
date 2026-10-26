
const fs = require("fs");
const path = require("path");

const API_URL = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY;
const OUTPUT_FILE = path.join(__dirname, "predictions.json");

const TIMEZONE = "Africa/Nairobi";
const DAYS_AHEAD = 7;
const MAX_FORM_TEAMS = 60;
const FORM_MATCHES = 8;
const MAX_GOALS = 10;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function dateInKenya(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function api(endpoint, params = {}) {
  const url = new URL(`${API_URL}/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { "x-apisports-key": API_KEY }
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`API HTTP ${response.status}: ${JSON.stringify(body.errors || body)}`);
  }

  if (body.errors && Object.keys(body.errors).length) {
    throw new Error(`API error: ${JSON.stringify(body.errors)}`);
  }

  if (!Array.isArray(body.response)) {
    throw new Error(`Unexpected API response for ${endpoint}`);
  }

  return body.response;
}

function poisson(lambda, goals) {
  if (goals === 0) return Math.exp(-lambda);

  let p = Math.exp(-lambda);
  for (let i = 1; i <= goals; i++) p *= lambda / i;
  return p;
}

function buildModel(homeXg, awayXg) {
  const home = Math.max(0.15, Math.min(4.5, homeXg));
  const away = Math.max(0.15, Math.min(4.5, awayXg));

  const matrix = [];
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let under45 = 0;
  let btts = 0;
  let totalMass = 0;
  let bestScore = "1-1";
  let bestScoreProbability = -1;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poisson(home, h) * poisson(away, a);
      totalMass += p;
      matrix.push({ h, a, p });

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (h + a >= 2) over15 += p;
      if (h + a >= 3) over25 += p;
      if (h + a >= 4) over35 += p;
      if (h + a <= 4) under45 += p;
      if (h > 0 && a > 0) btts += p;

      if (p > bestScoreProbability) {
        bestScoreProbability = p;
        bestScore = `${h}-${a}`;
      }
    }
  }

  // Normalize for the tiny probability tail beyond MAX_GOALS.
  const pct = p => Number((100 * p / totalMass).toFixed(1));

  const markets = {
    "Home Win": pct(homeWin),
    "Draw": pct(draw),
    "Away Win": pct(awayWin),
    "1X": pct(homeWin + draw),
    "X2": pct(draw + awayWin),
    "12": pct(homeWin + awayWin),
    "Over 1.5": pct(over15),
    "Over 2.5": pct(over25),
    "Over 3.5": pct(over35),
    "Under 4.5": pct(under45),
    "BTTS Yes": pct(btts),
    "BTTS No": pct(1 - btts)
  };

  // Select only from the markets calculated above.
  const eligible = [
    ["Over 1.5", markets["Over 1.5"]],
    ["Under 4.5", markets["Under 4.5"]],
    ["1X", markets["1X"]],
    ["X2", markets["X2"]],
    ["BTTS No", markets["BTTS No"]],
    ["Over 2.5", markets["Over 2.5"]]
  ].sort((a, b) => b[1] - a[1]);

  return {
    expectedGoalsHome: Number(home.toFixed(2)),
    expectedGoalsAway: Number(away.toFixed(2)),
    predictedScore: bestScore,
    probabilities: {
      homeWin: markets["Home Win"],
      draw: markets.Draw,
      awayWin: markets["Away Win"]
    },
    markets,
    bestPick: eligible[0][0],
    bestPickProbability: eligible[0][1],
    calculationMethod: "Neutral-ground independent Poisson model; no home-advantage bonus"
  };
}

function completed(f) {
  return ["FT", "AET", "PEN"].includes(f.fixture?.status?.short);
}

function validScore(f) {
  return completed(f) &&
    Number.isFinite(f.goals?.home) &&
    Number.isFinite(f.goals?.away);
}

function teamForm(fixtures, teamId) {
  const scored = [];
  const conceded = [];

  for (const f of fixtures) {
    if (!validScore(f)) continue;

    if (f.teams?.home?.id === teamId) {
      scored.push(f.goals.home);
      conceded.push(f.goals.away);
    } else if (f.teams?.away?.id === teamId) {
      scored.push(f.goals.away);
      conceded.push(f.goals.home);
    }
  }

  return {
    played: scored.length,
    scored: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
    conceded: conceded.length ? conceded.reduce((a, b) => a + b, 0) / conceded.length : null
  };
}

function leagueBaseline(fixture) {
  // Conservative fallback when recent team results are unavailable.
  // This is explicitly marked as an estimate, not real team form.
  const name = (fixture.league?.name || "").toLowerCase();

  if (name.includes("women") || name.includes("youth") || name.includes("u19")) {
    return { home: 1.35, away: 1.20 };
  }

  return { home: 1.35, away: 1.20 };
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "Missing API_FOOTBALL_KEY. Add it in GitHub repository Settings > Secrets and variables > Actions."
    );
  }

  const today = dateInKenya(new Date());
  const lastDate = addDays(today, DAYS_AHEAD);

  console.log(`Kenya date: ${today}`);
  console.log(`Loading actual API fixtures from ${today} to ${lastDate}`);

  const fixtures = await api("fixtures", {
    from: today,
    to: lastDate,
    timezone: TIMEZONE
  });

  // Only upcoming fixtures with real API IDs and two identified teams.
  const upcoming = fixtures
    .filter(f =>
      Number.isInteger(f.fixture?.id) &&
      f.teams?.home?.id &&
      f.teams?.away?.id &&
      f.teams?.home?.name &&
      f.teams?.away?.name &&
      ["NS", "TBD"].includes(f.fixture?.status?.short) &&
      f.teams.home.id !== f.teams.away.id
    )
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  if (!upcoming.length) {
    throw new Error(
      `API returned no eligible upcoming fixtures for ${today} to ${lastDate}. Existing predictions.json was not overwritten.`
    );
  }

  // Fetch recent team results, caching each team to avoid duplicate API calls.
  const teamIds = [...new Set(
    upcoming.flatMap(f => [f.teams.home.id, f.teams.away.id])
  )];

  const formCache = new Map();
  let formCalls = 0;

  for (const teamId of teamIds) {
    if (formCalls >= MAX_FORM_TEAMS) break;

    try {
      const recent = await api("fixtures", {
        team: teamId,
        last: FORM_MATCHES,
        status: "FT-AET-PEN",
        timezone: TIMEZONE
      });

      formCache.set(teamId, teamForm(recent, teamId));
      formCalls++;
      await sleep(120);
    } catch (error) {
      console.error(`Form unavailable for team ${teamId}: ${error.message}`);
      formCache.set(teamId, { played: 0, scored: null, conceded: null });
    }
  }

  const output = [];

  for (const f of upcoming) {
    const homeId = f.teams.home.id;
    const awayId = f.teams.away.id;
    const homeForm = formCache.get(homeId) || {
      played: 0, scored: null, conceded: null
    };
    const awayForm = formCache.get(awayId) || {
      played: 0, scored: null, conceded: null
    };

    const baseline = leagueBaseline(f);
    const usableForm =
      homeForm.played >= 3 &&
      awayForm.played >= 3 &&
      Number.isFinite(homeForm.scored) &&
      Number.isFinite(homeForm.conceded) &&
      Number.isFinite(awayForm.scored) &&
      Number.isFinite(awayForm.conceded);

    let homeXg;
    let awayXg;
    let method;

    if (usableForm) {
      // Symmetric formula: both teams use the same attack/defence method.
      // No home-field multiplier or home-team bonus is applied.
      homeXg = (homeForm.scored + awayForm.conceded) / 2;
      awayXg = (awayForm.scored + homeForm.conceded) / 2;
      method = "Recent team results; neutral-ground independent Poisson model";
    } else {
      homeXg = baseline.home;
      awayXg = baseline.away;
      method = "Fallback goal estimate; neutral-ground independent Poisson model; team form unavailable";
    }

    const model = buildModel(homeXg, awayXg);
    const kickoff = new Date(f.fixture.date);

    output.push({
      fixtureId: f.fixture.id,
      date: f.fixture.date,
      timestamp: Math.floor(kickoff.getTime() / 1000),
      kickoffKenya: new Intl.DateTimeFormat("en-GB", {
        timeZone: TIMEZONE,
        dateStyle: "medium",
        timeStyle: "short"
      }).format(kickoff),
      league: f.league.name,
      competitionCode: String(f.league.id),
      leagueId: f.league.id,
      country: f.league.country || "",
      season: f.league.season,
      home: f.teams.home.name,
      away: f.teams.away.name,
      homeTeamId: homeId,
      awayTeamId: awayId,
      status: f.fixture.status.short,
      predictionAvailable: true,
      expectedGoalsHome: model.expectedGoalsHome,
      expectedGoalsAway: model.expectedGoalsAway,
      predictedScore: model.predictedScore,
      probabilities: model.probabilities,
      markets: model.markets,
      bestPick: model.bestPick,
      bestPickProbability: model.bestPickProbability,
      calculationMethod: method,
      neutralGround: true,
      homeAdvantage: 0,
      historyMatchesUsed: {
        home: homeForm.played,
        away: awayForm.played
      },
      source: "API-Football",
      generatedAt: new Date().toISOString()
    });
  }

  // Never publish duplicate fixture IDs.
  const unique = [...new Map(output.map(f => [f.fixtureId, f])).values()];

  const document = {
    generatedAt: new Date().toISOString(),
    timezone: TIMEZONE,
    dateFrom: today,
    dateTo: lastDate,
    source: "API-Football",
    model: "Neutral-ground independent Poisson model",
    homeAdvantage: 0,
    fixtureCount: unique.length,
    fixtures: unique
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(document, null, 2) + "\n");

  console.log(`Saved ${unique.length} real API fixture records to predictions.json`);
  console.log(`Recent team-form API calls: ${formCalls}`);
  console.log("Neutral-ground model enabled. No home-advantage bonus applied.");
}

main().catch(error => {
  console.error("Prediction update failed:", error.message);
  process.exitCode = 1;
});
