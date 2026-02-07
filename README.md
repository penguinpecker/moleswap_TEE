<p align="center">
  <img src="https://img.shields.io/badge/🎯_TILTSCOPE-ff0055?style=for-the-badge&labelColor=0a0a12" alt="TiltScope"/>
</p>

<h1 align="center">TILTSCOPE</h1>
<h3 align="center">"See the tilt before the scoreboard does"</h3>

<p align="center">
  <strong>AI-powered Comprehensive Assistant Coach that detects player "tilt" in real-time and predicts match outcomes using GRID Esports data</strong>
</p>

<p align="center">
  <a href="https://tiltscope-9m08nrxmh-penguinpeckers-projects.vercel.app/">🚀 Live Demo</a> •
  <a href="https://tiltscope-9m08nrxmh-penguinpeckers-projects.vercel.app/docs.html">📖 Documentation</a> •
  <a href="#-demo-video">🎬 Demo Video</a>
</p>

---

## 🏆 Sky's the Limit - Cloud9 x JetBrains Hackathon 2025

| | |
|---|---|
| **Category** | Category 1: Comprehensive Assistant Coach |
| **Game** | VALORANT |
| **Data Source** | GRID Esports API |
| **Live Demo** | [tiltscope.vercel.app](https://tiltscope-9m08nrxmh-penguinpeckers-projects.vercel.app/) |

---

## 🎯 What is TiltScope?

Inspired by **Moneyball's Peter Brand**, TiltScope is a comprehensive **Assistant Coach** that merges **micro-level player analytics** with **macro-level strategic review**.

Traditional stats like K/D ratios are **lagging indicators** — they show decline *after* it's too late. TiltScope solves this by detecting **player tilt in real-time** using statistical deviation analysis, then predicting its impact on match outcomes with ML.

### Core Innovation: Z-Score Tilt Detection

Instead of looking at raw K/D, we compare **current performance to each player's historical baseline**:

```
z_score = (current_kd - player_baseline_mean) / player_baseline_std
```

This reveals performance state **before** the scoreboard does.

---

## ⚡ Features (Matching Category 1 Requirements)

### ✅ 1. Personalized Player/Team Improvement Insights

TiltScope analyzes individual player data to identify **recurring mistakes and statistical outliers**:

| Player | Current K/D | Baseline K/D | Z-Score | State | Insight |
|--------|-------------|--------------|---------|-------|---------|
| OXY | 0.43 | 1.19 | -1.70 | 💀 TILTED | Performing 64% below baseline - mental reset needed |
| v1c | 0.50 | 1.08 | -1.61 | 💀 TILTED | Star player collapsed - review opening pathing |
| mada | 4.20 | 1.24 | +2.79 | 🔥 ON FIRE | Explosive carry - protect this player |

**Performance States:**
- 🔥 **ON FIRE** (z > +1.5): Player performing 50%+ above baseline
- 📈 **HOT** (+0.5 < z < +1.5): Above average performance
- ➖ **NORMAL** (-0.5 < z < +0.5): Playing at baseline
- 📉 **COLD** (-1.5 < z < -0.5): Below average - watch closely
- 💀 **TILTED** (z < -1.5): Player is tilting - intervene NOW

### ✅ 2. Automated Macro Game Review

TiltScope automatically generates **game review agendas** highlighting:

- **Team Z-Scores**: Overall team mental state comparison
- **Tilt Progression Tracker**: Track how player performance changes across games
- **Critical Moments**: Identify when tilt began affecting outcomes
- **Win Probability Impact**: Quantify how tilt affected match result

**Example Output (Cloud9 vs NRG - Game 2 Corrode):**
```
GAME REVIEW AGENDA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Map: Corrode | Score: 2-13 (Loss)
Team Z-Score: -0.97 (TEAM TILTED)

CRITICAL ISSUES:
• OXY (z=-1.70): Star player tilted - 64% below baseline
• v1c (z=-1.61): Secondary carry tilted - 54% below baseline
• Combined impact: 2 of 5 players in TILTED state

OPPONENT ADVANTAGE:
• mada (z=+2.79): ON FIRE - exploited C9 tilt
• NRG Team Z-Score: +1.02 (TEAM HOT)

RECOMMENDATION: Mental reset protocol before Game 3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### ✅ 3. Predict Hypothetical Outcomes (What-If Analysis)

TiltScope's **Monte Carlo simulation engine** answers strategic "what if" questions:

> **Query:** "What if OXY had performed at baseline instead of tilting in Game 2?"

**Monte Carlo Simulation (100 iterations):**
| Scenario | NRG Win Probability | Cloud9 Win Probability |
|----------|---------------------|------------------------|
| Actual (OXY tilted) | 96.8% | 3.2% |
| Simulated (OXY at baseline) | 62.3% | 37.7% |
| **Tilt Impact** | — | **+34.5% swing** |

**Insight:** OXY's tilt cost Cloud9 approximately 35% win probability. Recommend reviewing opening duel strategy and mental conditioning.

### ✅ 4. ML Win Prediction

**Ensemble Model Architecture:**
```python
prediction = (
    0.25 * LogisticRegression +    # Interpretable baseline
    0.35 * RandomForest +          # Non-linear patterns  
    0.40 * GradientBoosting        # Complex interactions
)
```

**Feature Engineering (20 features per game):**
- Team averages: `avg_kd`, `avg_z_score`, `total_kills`, `total_deaths`
- State counts: `tilted_count`, `hot_count`, `fire_count`
- Differentials: `kd_diff`, `z_score_diff`, `momentum`
- Context: `map_encoding`, `game_number`, `series_score`

**Performance:** 14/14 games predicted correctly in validation set

---

## 🎮 Case Study: Cloud9 vs NRG (VCT Americas 2025)

### Match Overview
| Game | Map | Score | Winner | C9 Z-Score | NRG Z-Score | Prediction |
|------|-----|-------|--------|------------|-------------|------------|
| 1 | Haven | 13-10 | Cloud9 | +0.62 | -0.30 | C9 97% ✅ |
| 2 | Corrode | 2-13 | NRG | **-0.97** | +1.02 | NRG 96.8% ✅ |
| 3 | Lotus | 10-13 | NRG | -0.24 | +0.16 | NRG 94.8% ✅ |

### Game 2 Deep Dive - The Tilt Game

**Cloud9 Players:**
| Player | Agent | K/D | Z-Score | State |
|--------|-------|-----|---------|-------|
| OXY | Neon | 0.43 | -1.70 | 💀 TILTED |
| v1c | Omen | 0.50 | -1.61 | 💀 TILTED |
| neT | Viper | 0.50 | -0.56 | 📉 COLD |
| Xeppaa | Vyse | 0.69 | -0.52 | 📉 COLD |
| mitch | Skye | 0.50 | -0.47 | ➖ NORMAL |

**NRG Players:**
| Player | Agent | K/D | Z-Score | State |
|--------|-------|-----|---------|-------|
| mada | Waylay | 4.20 | +2.79 | 🔥 ON FIRE |
| brawk | Sova | 2.57 | +1.24 | 📈 HOT |
| s0m | Omen | 1.17 | +0.94 | 📈 HOT |
| Ethan | Kay/O | 1.44 | +0.62 | 📈 HOT |
| skuba | Viper | 1.00 | -0.50 | ➖ NORMAL |

**TiltScope Prediction:** NRG 96.8% → ✅ **CORRECT**

### Tilt Progression Across Series

| Player | Game 1 | Game 2 | Game 3 | Trend |
|--------|--------|--------|--------|-------|
| v1c (C9) | 1.47 📈 | 0.50 💀 | 1.25 ➖ | Recovered |
| OXY (C9) | 1.50 📈 | 0.43 💀 | 1.16 ➖ | Recovered |
| mada (NRG) | 0.75 ➖ | 4.20 🔥 | 1.19 ➖ | Game 2 explosion |

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Backend** | Python 3.12, FastAPI, asyncio, httpx |
| **ML/Data** | scikit-learn, pandas, NumPy |
| **Frontend** | React 18, Vanilla CSS |
| **Deployment** | Vercel |
| **Data Source** | GRID Esports API (VALORANT) |
| **IDE** | JetBrains PyCharm |

---

## 📁 Project Structure

```
tiltscope/
├── backend/
│   ├── main.py                 # FastAPI REST API server
│   ├── api/
│   │   └── grid_client.py      # GRID Esports API integration
│   └── core/
│       ├── baseline.py         # Player baseline calculator (μ, σ)
│       ├── deviation.py        # Z-score tilt detection engine
│       ├── features.py         # ML feature engineering (20 features)
│       ├── predictor.py        # Ensemble ML predictor
│       └── whatif.py           # Monte Carlo "What-If" simulator
├── frontend/
│   ├── index.html              # Main dashboard (React)
│   └── docs.html               # Documentation page
├── requirements.txt            # Python dependencies
├── vercel.json                 # Deployment config
├── LICENSE                     # MIT License
└── README.md
```

---

## 🚀 Quick Start

### Prerequisites
- Python 3.10+
- GRID API Key ([Apply here](https://grid.gg/hackathon-application-form/))

### Backend Setup

```bash
# Clone repository
git clone https://github.com/penguinpecker/tiltscope.git
cd tiltscope

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Set environment variable
export GRID_API_KEY="your_api_key_here"

# Run server
cd backend
uvicorn main:app --reload --port 8000
```

### Frontend
```bash
# Open directly in browser
open frontend/index.html

# Or serve locally
cd frontend && python -m http.server 3000
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/initialize` | Initialize with team data |
| GET | `/api/matches` | List available matches |
| GET | `/api/match/{id}/analysis` | Full match analysis with tilt detection |
| GET | `/api/whatif/{id}/{game}` | Monte Carlo what-if scenarios |
| GET | `/api/demo` | Demo data (no API key needed) |

---

## 🎬 Demo Video

[**→ Watch 3-Minute Demo on YouTube**](YOUR_YOUTUBE_LINK_HERE)

---

## 🔗 Links

| Resource | URL |
|----------|-----|
| **Live Demo** | [tiltscope.vercel.app](https://tiltscope-9m08nrxmh-penguinpeckers-projects.vercel.app/) |
| **Documentation** | [tiltscope.vercel.app/docs](https://tiltscope-9m08nrxmh-penguinpeckers-projects.vercel.app/docs.html) |
| **GitHub Repository** | [github.com/penguinpecker/tiltscope](https://github.com/penguinpecker/tiltscope) |

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- **Cloud9** — For hosting this incredible hackathon
- **JetBrains** — For world-class developer tools and PyCharm IDE
- **GRID Esports** — For providing official VALORANT match data
- **Moneyball / Peter Brand** — For the inspiration that data can reveal what the eye cannot see

---

<p align="center">
  <strong>🎯 TILTSCOPE</strong><br>
  <em>"See the tilt before the scoreboard does"</em>
</p>

<p align="center">
  Built with ❤️ for the <strong>Cloud9 x JetBrains Hackathon 2025</strong>
</p>
