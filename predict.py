import json
import math

# Live Team profiles using raw xG/Form data (Attacking vs Defensive weights)
TEAM_STATS = {
    "Real Madrid":   {"att": 1.80, "def": 0.75}, "Barcelona":     {"att": 1.75, "def": 0.80},
    "Bayern Munich": {"att": 1.90, "def": 0.85}, "Leverkusen":    {"att": 1.60, "def": 0.90},
    "Liverpool":     {"att": 1.85, "def": 0.80}, "Arsenal":       {"att": 1.70, "def": 0.75},
    "Man City":      {"att": 1.95, "def": 0.85}, "Aston Villa":   {"att": 1.40, "def": 1.20},
    "Inter Milan":   {"att": 1.65, "def": 0.70}, "Juventus":      {"att": 1.30, "def": 0.65},
    "PSG":           {"att": 1.75, "def": 0.95}, "Monaco":        {"att": 1.45, "def": 1.10},
}

# Current active match matrix
UPCOMING_MATCHES = [
    {"home": "Real Madrid", "away": "Barcelona"},
    {"home": "Arsenal", "away": "Liverpool"},
    {"home": "Man City", "away": "Aston Villa"},
    {"home": "Inter Milan", "away": "Juventus"}
]

LEAGUE_AVG_HOME = 1.50
LEAGUE_AVG_AWAY = 1.20

def poisson_prob(k, lamb):
    return (math.exp(-lamb) * (lamb ** k)) / math.factorial(k)

def evaluate_fixture(home, away):
    h_stats = TEAM_STATS.get(home, {"att": 1.0, "def": 1.0})
    a_stats = TEAM_STATS.get(away, {"att": 1.0, "def": 1.0})
    
    exp_home = h_stats["att"] * a_stats["def"] * LEAGUE_AVG_HOME
    exp_away = a_stats["att"] * h_stats["def"] * LEAGUE_AVG_AWAY
    
    max_g = 6
    h_probs = [poisson_prob(g, exp_home) for g in range(max_g)]
    a_probs = [poisson_prob(g, exp_away) for g in range(max_g)]
    
    w, d, l = 0.0, 0.0, 0.0
    for h in range(max_g):
        for a in range(max_g):
            p = h_probs[h] * a_probs[a]
            if h > a: w += p
            elif h == a: d += p
            else: l += p

    # Safety Filter Logic (Minimizes Risk)
    if (w + d) >= 0.76:
        pick, conf = "Home Win or Draw (1X)", (w + d)
    elif (l + d) >= 0.76:
        pick, conf = "Away Win or Draw (X2)", (l + d)
    else:
        pick, conf = "Draw No Bet (Refund on Draw)", max(w, l)

    return {
        "match": f"{home} vs {away}",
        "safe_bet": pick,
        "confidence": f"{round(conf * 100, 1)}%"
    }

if __name__ == "__main__":
    output = [evaluate_fixture(m["home"], m["away"]) for m in UPCOMING_MATCHES]
    with open("predictions.json", "w") as f:
        json.dump(output, f, indent=4)
