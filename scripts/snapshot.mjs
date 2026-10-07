// Computes power rankings from the Sleeper API and writes data/latest.json plus a per-week history file.
//
//   node scripts/snapshot.mjs              write a snapshot now
//   node scripts/snapshot.mjs --scheduled  only write if it's Thursday in Los Angeles and
//                                          today's scheduled snapshot hasn't been written yet
//
// Any failed API call throws, so a bad fetch never replaces the last good snapshot.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LEAGUE_ID = process.env.LEAGUE_ID || "1407795888671207424";
const TZ = "America/Los_Angeles";
const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const HISTORY = join(DATA, "history");

const API = "https://api.sleeper.app/v1";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF", "DL", "LB", "DB"];
const FLEX_ELIGIBLE = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};
const NON_STARTING = new Set(["BN", "IR", "TAXI"]);
// Fixed all season. Must sum to 1.
const W = { roster: 0.30, allPlay: 0.30, ppg: 0.25, winPct: 0.15 };

const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.json();
};

const projURL = (season, week) => {
  const q = POSITIONS.map(p => `position[]=${p}`).join("&");
  return `https://api.sleeper.app/projections/nfl/${season}${week ? "/" + week : ""}?season_type=regular&${q}`;
};

// Fantasy points under this league's scoring rules.
function scoreStats(stats, scoring) {
  if (!stats) return 0;
  let pts = 0;
  for (const [k, v] of Object.entries(scoring)) if (stats[k]) pts += stats[k] * v;
  // Projections bucket 50+ yard FGs together; leagues may split them.
  if (stats.fgm_50p && scoring.fgm_50p == null && scoring.fgm_50_59 != null) pts += stats.fgm_50p * scoring.fgm_50_59;
  return pts;
}

// player_id -> { name, pos: [...], team, pts, bye }. Players missing from the weekly list are on bye
// and fall back to their season-long per-game projection.
function buildProjections(weekly, season, scoring) {
  const out = {};
  for (const p of season) {
    const gp = p.stats?.gp || 0;
    if (!gp) continue;
    out[p.player_id] = playerInfo(p, scoreStats(p.stats, scoring) / gp, true);
  }
  for (const p of weekly) out[p.player_id] = playerInfo(p, scoreStats(p.stats, scoring), false);
  return out;
}
function playerInfo(p, pts, bye) {
  const pl = p.player || {};
  const name = pl.position === "DEF" ? `${pl.team || p.player_id} D/ST` : `${pl.first_name || ""} ${pl.last_name || ""}`.trim();
  return { name, pos: pl.fantasy_positions || [pl.position], team: pl.team, pts, bye };
}

// Fill strict slots first, then flex slots narrowest-first. Greedy is optimal for this slot shape.
function bestLineup(playerIds, slots, proj) {
  const pool = playerIds.map(id => ({ id, ...(proj[id] || { name: id, pos: [], pts: 0 }) }))
    .sort((a, b) => b.pts - a.pts);
  const used = new Set();
  const starting = slots.filter(s => !NON_STARTING.has(s));
  const strict = starting.filter(s => !FLEX_ELIGIBLE[s]);
  const flex = starting.filter(s => FLEX_ELIGIBLE[s]).sort((a, b) => FLEX_ELIGIBLE[a].length - FLEX_ELIGIBLE[b].length);
  const lineup = [];
  for (const slot of [...strict, ...flex]) {
    const ok = FLEX_ELIGIBLE[slot] || [slot];
    const pick = pool.find(p => !used.has(p.id) && p.pos.some(x => ok.includes(x)));
    if (pick) used.add(pick.id);
    lineup.push({ slot, player: pick || null });
  }
  return { lineup, total: lineup.reduce((s, l) => s + (l.player?.pts || 0), 0) };
}

const norm = (vals) => {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  return vals.map(v => (hi === lo ? 0.5 : (v - lo) / (hi - lo)));
};

// Rank teams using games in `weeks` plus projected lineups `lineups` (roster_id -> total or null).
function computeRankings(rosterIds, weekly, weeks, lineups) {
  const t = Object.fromEntries(rosterIds.map(id => [id, { pf: 0, w: 0, l: 0, tie: 0, apW: 0, apG: 0, g: 0 }]));
  for (const wk of weeks) {
    const games = weekly[wk];
    const pts = games.map(m => m.points || 0);
    const byMatch = {};
    for (const m of games) (byMatch[m.matchup_id] ||= []).push(m);
    for (const m of games) {
      const s = t[m.roster_id];
      if (!s) continue;
      s.pf += m.points || 0; s.g++;
      s.apW += pts.filter(p => p < m.points).length + 0.5 * (pts.filter(p => p === m.points).length - 1);
      s.apG += pts.length - 1;
      const opp = m.matchup_id != null && byMatch[m.matchup_id].find(o => o.roster_id !== m.roster_id);
      if (opp) {
        if (m.points > opp.points) s.w++; else if (m.points < opp.points) s.l++; else s.tie++;
      }
    }
  }
  const g = weeks.length;
  const haveRoster = lineups && rosterIds.every(id => lineups[id] != null);
  const rows = rosterIds.map(id => {
    const s = t[id];
    const games = s.w + s.l + s.tie;
    return {
      id, ...s,
      ppg: s.g ? s.pf / s.g : 0,
      apPct: s.apG ? s.apW / s.apG : 0,
      winPct: games ? (s.w + 0.5 * s.tie) / games : 0,
      expW: s.apG ? (s.apW / s.apG) * games : 0,
      proj: haveRoster ? lineups[id] : null,
    };
  });
  const nAp = norm(rows.map(r => r.apPct)), nPpg = norm(rows.map(r => r.ppg)), nWin = norm(rows.map(r => r.winPct));
  const nRos = haveRoster ? norm(rows.map(r => r.proj)) : rows.map(() => 0);
  rows.forEach((r, i) => {
    r.comp = { allPlay: nAp[i], ppg: nPpg[i], winPct: nWin[i], roster: nRos[i] };
    r.score = 100 * (W.roster * nRos[i] + W.allPlay * nAp[i] + W.ppg * nPpg[i] + W.winPct * nWin[i]);
  });
  rows.sort((a, b) => b.score - a.score || b.pf - a.pf);
  rows.forEach((r, i) => (r.rank = i + 1));
  return { rows, g };
}

const laDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
const laWeekday = (d) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
const readJSON = (f) => JSON.parse(readFileSync(f, "utf8"));
const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;

async function main() {
  const scheduled = process.argv.includes("--scheduled");
  const now = new Date();
  const today = laDate(now);
  if (scheduled) {
    // Cron fires at 07:00 and 08:00 UTC Thursday; exactly one of those is midnight Pacific, DST or not.
    if (laWeekday(now) !== "Thu") return console.log(`Not Thursday in ${TZ}; skipping.`);
    const latest = join(DATA, "latest.json");
    if (existsSync(latest) && readJSON(latest).scheduledFor === today) return console.log(`Snapshot for ${today} exists; skipping.`);
  }

  const [league, state, users, rosters] = await Promise.all([
    getJSON(`${API}/league/${LEAGUE_ID}`),
    getJSON(`${API}/state/nfl`),
    getJSON(`${API}/league/${LEAGUE_ID}/users`),
    getJSON(`${API}/league/${LEAGUE_ID}/rosters`),
  ]);
  const startWeek = league.settings.start_week || 1;
  const lastRegular = (league.settings.playoff_week_start || 15) - 1;
  const inRegular = state.season === league.season && state.season_type === "regular";
  const seasonOver = league.status === "complete" || state.season > league.season || (state.season === league.season && state.season_type === "post");
  // Weeks strictly before Sleeper's current week are final.
  const lastDone = seasonOver ? lastRegular : inRegular ? Math.min(state.week - 1, lastRegular) : startWeek - 1;
  const upcoming = inRegular && state.week <= lastRegular ? Math.max(state.week, startWeek) : null;

  const weekNums = [];
  for (let w = startWeek; w <= lastDone; w++) weekNums.push(w);
  const fetchWeeks = [...new Set([...weekNums, ...(upcoming ? [upcoming] : [])])];
  const weekly = Object.fromEntries(await Promise.all(
    fetchWeeks.map(async w => [w, await getJSON(`${API}/league/${LEAGUE_ID}/matchups/${w}`)])));
  const done = weekNums.filter(w => weekly[w].some(m => m.points > 0));
  const asOfWeek = done.length ? done[done.length - 1] : null;

  const rosterIds = rosters.map(r => r.roster_id);
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map(r => [r.roster_id, r]));

  let lineups = null;
  if (upcoming) {
    const [seasonProj, weekProj] = await Promise.all([getJSON(projURL(league.season)), getJSON(projURL(league.season, upcoming))]);
    if (!weekProj.length) throw new Error(`No Week ${upcoming} projections returned`);
    const proj = buildProjections(weekProj, seasonProj, league.scoring_settings);
    lineups = { totals: {}, detail: {} };
    for (const id of rosterIds) {
      const r = rosterById[id];
      const inactive = new Set([...(r.reserve || []), ...(r.taxi || [])]);
      const best = bestLineup((r.players || []).filter(p => !inactive.has(p)), league.roster_positions, proj);
      lineups.totals[id] = best.total; lineups.detail[id] = best.lineup;
    }
  }
  const ranked = computeRankings(rosterIds, weekly, done, lineups?.totals);

  // Movement compares against the most recent earlier week's snapshot.
  const prevFile = readdirSync(HISTORY).filter(f => f.endsWith(".json"))
    .map(f => readJSON(join(HISTORY, f)))
    .filter(s => s.league.season === league.season && (s.asOfWeek ?? 0) < (asOfWeek ?? 0))
    .sort((a, b) => (b.asOfWeek ?? 0) - (a.asOfWeek ?? 0))[0];
  const prevRank = prevFile ? Object.fromEntries(prevFile.teams.map(t => [t.id, t.rank])) : null;

  const teams = ranked.rows.map(r => {
    const u = userById[rosterById[r.id].owner_id] || {};
    return {
      id: r.id,
      rank: r.rank,
      prevRank: prevRank?.[r.id] ?? null,
      name: u.metadata?.team_name || u.display_name || `Team ${r.id}`,
      owner: u.display_name || "Open",
      avatar: u.metadata?.avatar || (u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null),
      score: r1(r.score),
      w: r.w, l: r.l, tie: r.tie,
      apW: r.apW, apL: r.apG - r.apW,
      pf: r1(r.pf), ppg: r1(r.ppg),
      luck: r1(r.w + 0.5 * r.tie - r.expW),
      proj: r.proj == null ? null : r1(r.proj),
      comp: Object.fromEntries(Object.entries(r.comp).map(([k, v]) => [k, r3(v)])),
      lineup: (lineups?.detail[r.id] || []).map(l => ({
        slot: l.slot, name: l.player?.name ?? null, pts: r1(l.player?.pts || 0), bye: !!l.player?.bye,
      })),
    };
  });

  const snapshot = {
    league: { id: LEAGUE_ID, name: league.name, season: league.season },
    generatedAt: now.toISOString(),
    scheduledFor: scheduled ? today : null,
    asOfWeek,
    projWeek: upcoming,
    prevWeek: prevFile?.asOfWeek ?? null,
    games: ranked.g,
    weights: {
      roster: W.roster,
      allPlay: W.allPlay,
      ppg: W.ppg,
      winPct: W.winPct,
    },
    teams,
  };
  const body = JSON.stringify(snapshot, null, 2) + "\n";
  writeFileSync(join(DATA, "latest.json"), body);
  writeFileSync(join(HISTORY, `${league.season}-week-${String(asOfWeek ?? 0).padStart(2, "0")}.json`), body);
  console.log(`Wrote snapshot: ${league.name} ${league.season}, after week ${asOfWeek ?? "none"}, projecting week ${upcoming ?? "none"}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
