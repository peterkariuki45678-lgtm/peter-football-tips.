
"use strict";

const fs = require("fs");
const path = require("path");

const BASE =
  "https://raw.githubusercontent.com/openfootball/football.json/master";

const OUTPUT_FILE = path.join(__dirname, "predictions.json");
const TIME_ZONE = "Africa/Nairobi";
const DAYS_AHEAD = 7;
const HISTORY_LIMIT = 6;

const LEAGUES = [
  { name: "English Premier League", country: "England", code: "en.1" },
  { name: "Spanish La Liga", country: "Spain", code: "es.1" },
  { name: "Italian Serie A", country: "Italy", code: "it.1" },
  { name: "German Bundesliga", country: "Germany", code: "de.1" },
  { name: "French Ligue 1", country: "France", code: "fr.1" }
];

function kenyaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
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

async function fetchSeason(season, code) {
  const url = `${BASE}/${season}/${code}.json`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "PeterFootballTips/1.0" }
    });

    if (!response.ok) {
      console.log(`Unavailable source: ${season}/${code}.json`);
      return [];
    }

    const data = await response.json();

    if (!Array.isArray(data.matches)) return [];

    return data.matches.map(match => ({
      ...match,
      _season: season,
      _leagueCode: code
    }));
  } catch (error) {
    console.log(`Could not load ${season}/${code}.json: ${error.message}`);
    return [];
  }
}

function scoreOf(match) {
  const score = match.score || {};
  const ft = score.ft;

  if (
    Array.isArray(ft) &&
    ft.length >= 2 &&
    Number.isFinite(Number(ft[0])) &&
    Number.isFinite(Number(ft[1]))
  ) {
    return [Number(ft[0]), Number(ft[1])];
  }

  return null;
}

function validTeams(match) {
  return (
    typeof match.team1 === "string" &&
    match.team1.trim() &&
    typeof match.team2 === "string" &&
    match.team2.trim() &&
    match.team1.trim().toLowerCase() !==
      match.team2.trim().toLowerCase()
  );
}

function teamHistory(matches, team, beforeDate) {
  const wanted = team.trim().toLowerCase();

  return matches
    .filter(match => {
      if (!match.date || match.date >= beforeDate) return false;
      if (!validTeams(match) || !scoreOf(match)) return false;

      return (
        match.team1.trim().toLowerCase() === wanted ||
        match.team2.trim().toLowerCase() === wanted
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, HISTORY_LIMIT)
    .map(match => {
      const [goals1, goals2] = scoreOf(match);
      const home = match.team1.trim().toLowerCase() === wanted;

      const gf = home ? goals1 : goals2;
      const ga = home ? goals2 : goals1;

      return {
        gf,
        ga,
        result: gf > ga ? "W" : gf < ga ? "L" : "D",
        date: match.date
      };
    });
}

function poisson(lambda, goals) {
  let probability = Math.exp(-lambda);

  for (let i = 1; i <= goals; i++) {
    probability *= lambda / i;
  }

  return probability;
}

function calculate(homeHistory, awayHistory) {
  const average = (history, key) =>
    history.reduce((sum, item) => sum + item[key], 0) /
    history.length;

  const homeGF = average(homeHistory, "gf");
  const homeGA = average(homeHistory, "ga");
  const awayGF = average(awayHistory, "gf");
  const awayGA = average(awayHistory, "ga");

  // Neutral-ground model: no home advantage.
  const expectedHome = Math.max(0.15, (homeGF + awayGA) / 2);
  const expectedAway = Math.max(0.15, (awayGF + homeGA) / 2);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let under45 = 0;

  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const probability =
        poisson(expectedHome, h) * poisson(expectedAway, a);

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 2) over15 += probability;
      if (h + a <= 4) under45 += probability;
    }
  }

  const p = {
    "1": homeWin,
    X: draw,
    "2": awayWin,
    over15,
    under45,
    "1X": homeWin + draw,
    X2: draw + awayWin,
    "12": homeWin + awayWin
  };

  const markets = [
    ["Double Chance (1X)", p["1X"]],
    ["Double Chance (X2)", p.X2],
    ["Over 1.5 Goals", p.over15],
    ["Under 4.5 Goals", p.under45],
    ["Draw", p.X],
    ["Home Win", p["1"]],
    ["Away Win", p["2"]]
  ].sort((a, b) => b[1] - a[1]);

  return {
    safe_bet: markets[0][0],
    confidence: Number((markets[0][1] * 100).toFixed(1)),
    raw_probabilities: {
      "1": Number((homeWin * 100).toFixed(1)),
      X: Number((draw * 100).toFixed(1)),
      "2": Number((awayWin * 100).toFixed(1)),
      over15: Number((over15 * 100).toFixed(1)),
      under45: Number((under45 * 100).toFixed(1))
    },
    expected_goals: {
      home: Number(expectedHome.toFixed(2)),
      away: Number(expectedAway.toFixed(2))
    }
  };
}

async function main() {
  const today = kenyaDate();
  const lastDate = addDays(today, DAYS_AHEAD);

  console.log("Kenya date:", today);
  console.log(`Fixture window: ${today} to ${lastDate}`);
  console.log("Source: OpenFootball public JSON; no API key.");

  const currentYear = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const seasonStart = month >= 7 ? currentYear : currentYear - 1;
  const currentSeason = `${seasonStart}-${String(seasonStart + 1).slice(-2)}`;
  const previousSeason =
    `${seasonStart - 1}-${String(seasonStart).slice(-2)}`;

  const allMatches = [];
  const upcoming = [];

  for (const league of LEAGUES) {
    const [previous, current] = await Promise.all([
      fetchSeason(previousSeason, league.code),
      fetchSeason(currentSeason, league.code)
    ]);

    const combined = [...previous, ...current];

    allMatches.push(
      ...combined.map(match => ({
        ...match,
        _league: league.name,
        _country: league.country
      }))
    );

    for (const match of current) {
      if (
        !match.date ||
        match.date < today ||
        match.date > lastDate ||
        !validTeams(match)
      ) {
        continue;
      }

      if (scoreOf(match)) continue;

      upcoming.push({
        ...match,
        _league: league.name,
        _country: league.country
      });
    }
  }

  // Deduplicate only exact same league/date/team fixtures.
  const unique = new Map();

  for (const match of upcoming) {
    const key = [
      match._leagueCode,
      match.date,
      match.team1.toLowerCase(),
      match.team2.toLowerCase()
    ].join("|");

    unique.set(key, match);
  }

  const fixtures = [...unique.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const predictions = [];

  for (const match of fixtures) {
    const home = match.team1.trim();
    const away = match.team2.trim();

    const homeHistory = teamHistory(allMatches, home, match.date);
    const awayHistory = teamHistory(allMatches, away, match.date);

    // Do not invent a prediction if either team has no usable history.
    if (!homeHistory.length || !awayHistory.length) {
      console.log(`Skipped prediction: ${home} vs ${away} (no history)`);
      continue;
    }

    const prediction = calculate(homeHistory, awayHistory);

    predictions.push({
      fixtureId: [
        match._leagueCode,
        match.date,
        home,
        away
      ].join("-"),
      league: match._league,
      country: match._country,
      leagueId: match._leagueCode,
      season: currentSeason,
      home,
      away,
      utcTime: null,
      kickoff: "Time unavailable from source",
      date: match.date,
      homeLast6: homeHistory,
      awayLast6: awayHistory,
      ...prediction,
      calculation_model: "Neutral-ground goals model",
      home_advantage: 0,
      historical_matches_used: Math.min(
        homeHistory.length,
        awayHistory.length
      ),
      home_historical_matches_used: homeHistory.length,
      away_historical_matches_used: awayHistory.length,
      data_source: "OpenFootball public dataset"
    });
  }

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(predictions, null, 2) + "\n",
    "utf8"
  );

  console.log("Upcoming fixtures found:", fixtures.length);
  console.log("Predictions created:", predictions.length);
  console.log("Saved:", OUTPUT_FILE);

  if (!fixtures.length) {
    console.log(
      "No matching upcoming fixtures were present in the public source. " +
      "The updater will not create fictional matches."
    );
  }
}

main().catch(error => {
  console.error("Prediction update failed:", error);
  process.exitCode = 1;
});
