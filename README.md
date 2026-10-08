# Sleeper Power Rankings

Weekly power rankings for a Sleeper fantasy football league, hosted on GitHub Pages.

- `scripts/snapshot.mjs` pulls the league from the public Sleeper API, computes rankings, and writes `data/latest.json` plus `data/history/<season>-week-NN.json`.
- `.github/workflows/snapshot.yml` runs it every Thursday at 12:07 AM Pacific, commits the snapshot, and deploys the site. Run it manually from the Actions tab ("Run workflow") to refresh mid-week.
- `index.html` only renders `data/latest.json`, so every visitor sees the same rankings all week.
- League: `1407795888671207424` (override with the `LEAGUE_ID` env var). Weights live at the top of `scripts/snapshot.mjs`.
- Manager Report: strikes for neglect (dead starters, 10+ point bench blunders, 3 idle weeks), status from the last 4 weeks. `node scripts/snapshot.mjs --report-only` refreshes it without touching rankings.
