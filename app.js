const API = "https://api.sleeper.app/v1";
const DEFAULT_USERNAME = "tfriedman10";

const statusEl = document.getElementById("status");
const leaguesEl = document.getElementById("leagues");
const usernameInput = document.getElementById("username-input");
const seasonInput = document.getElementById("season-input");
const loadBtn = document.getElementById("load-btn");
const usernameLabel = document.getElementById("username-label");
const seasonLabel = document.getElementById("season-label");

let playersCache = null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// Surface any uncaught JS errors directly in the status box,
// so users don't need F12 to see "stuck on Loading".
window.addEventListener("error", (e) => {
  const msg = e && e.message ? e.message : String(e);
  console.error("[FantasyCast] window.onerror", e);
  if (statusEl) setStatus(`JS error: ${msg} — hard-refresh (Ctrl+Shift+R) and check F12 Console.`, true);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[FantasyCast] unhandledrejection", e.reason);
});

async function fetchJson(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Request failed ${res.status}: ${url}`);
    return res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    // Network-level failure (offline, DNS, adblock, CORS) surfaces as TypeError in browsers
    if (err instanceof TypeError) throw new Error(`Network fetch failed for ${url} (${err.message}). Check internet / adblock / firewall.`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Players map is ~5MB. Cache in memory + localStorage (24h) to avoid refetching.
// Returns {} on failure so rosters can still render with IDs as fallback.
async function getPlayersMap(statusCb) {
  if (playersCache) return playersCache;
  const CACHE_KEY = "sleeper_players_nfl";
  const TIME_KEY = "sleeper_players_nfl_time";
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    const cachedTime = parseInt(localStorage.getItem(TIME_KEY) || "0", 10);
    if (cached && Date.now() - cachedTime < 24 * 60 * 60 * 1000) {
      playersCache = JSON.parse(cached);
      return playersCache;
    }
  } catch (e) {
    // localStorage may be full/blocked — fall through to network
    console.warn("Player cache read failed", e);
  }

  if (statusCb) statusCb("Downloading NFL player database (~5MB, once per day)…");
  try {
    const data = await fetchJson(`${API}/players/nfl`, 60000);
    playersCache = data;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(TIME_KEY, String(Date.now()));
    } catch (e) {
      console.warn("Player cache write failed (quota?), continuing without cache", e);
    }
    return playersCache;
  } catch (e) {
    console.error("Players fetch failed, continuing with IDs only", e);
    if (statusCb) statusCb(`Warning: player names unavailable (${e.message}). Showing IDs.`);
    playersCache = {};
    return playersCache;
  }
}

function describePlayer(playerId, players) {
  if (!playerId || playerId === "0") {
    return { name: "Empty", team: "—", pos: "—", injury: "", raw: null };
  }
  const p = players[playerId];
  if (p) {
    const name = (p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || playerId);
    return {
      name,
      team: p.team || "FA",
      pos: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || "—",
      injury: p.injury_status || "",
      raw: p,
    };
  }
  // Team defenses come through as e.g. "DEN", "KC" with no entry in players map
  if (/^[A-Z]{2,3}$/.test(playerId)) {
    return { name: `${playerId} Defense`, team: playerId, pos: "DEF", injury: "", raw: null };
  }
  return { name: `Unknown (${playerId})`, team: "—", pos: "—", injury: "", raw: null };
}

function starterSlots(league, roster) {
  // roster_positions includes BN at the end; starters[] aligns with non-BN slots.
  const positions = league.roster_positions || [];
  const starters = roster.starters || [];
  const slots = [];
  let si = 0;
  for (const pos of positions) {
    if (pos === "BN") continue;
    const pid = starters[si] || null;
    slots.push({ slot: pos, playerId: pid });
    si++;
    if (si >= starters.length && slots.length >= starters.length) {
      // keep going only if more non-BN slots (shouldn't happen)
      if (positions.filter((x) => x !== "BN").length <= slots.length) break;
    }
  }
  return slots;
}

function benchIds(roster) {
  const starters = new Set(roster.starters || []);
  return (roster.players || []).filter((id) => !starters.has(id));
}

// ---- Game schedule (opponent + kickoff) via free ESPN scoreboard, no key ----
// Sleeper uses WAS, ESPN uses WSH for the Commanders — normalize both sides.
function normTeam(abbr) {
  if (!abbr) return null;
  const a = String(abbr).toUpperCase().trim();
  if (a === "WSH") return "WAS";
  if (a === "JAC") return "JAX";
  if (a === "LA") return "LAR";
  if (a === "FA" || a === "—" || a === "-" || a === "EMPTY") return null;
  if (!/^[A-Z]{2,3}$/.test(a)) return null;
  return a;
}

let scheduleCache = { key: null, data: null };

async function getSchedule(season, week, seasonType) {
  const espnType = seasonType === "post" ? 3 : seasonType === "pre" ? 1 : 2;
  const key = `${season}-${espnType}-${week}`;
  if (scheduleCache.key === key && scheduleCache.data) return scheduleCache.data;
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${encodeURIComponent(season)}&seasontype=${espnType}&week=${encodeURIComponent(week)}`;
  const data = await fetchJson(url, 20000);
  const map = {};
  const games = {}; // gameId -> { id, away, home, awayScore, homeScore, state, detail, clock, period, date, label, weekday, special }
  const teamToGame = {};
  const etDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
  const etHour24 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
  const etLabelFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  for (const ev of data.events || []) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp || !comp.competitors || comp.competitors.length < 2) continue;
    const date = new Date(ev.date);
    if (isNaN(date)) continue;
    const weekday = etDay.format(date); // Sun, Mon, Thu...
    const hour = parseInt(etHour24.format(date), 10);
    // Normal = Sunday 1pm or 4pm ET kickoffs. Everything else (Thu, SNF, Mon,
    // Sat, Fri, London 9:30am) counts as a special standalone window.
    const special = !(weekday === "Sun" && (hour === 13 || hour === 16));
    const label = `${etLabelFmt.format(date)} ET`;
    const teams = comp.competitors.map((c) => ({
      abbr: normTeam(c.team && c.team.abbreviation),
      homeAway: c.homeAway, // "home" | "away"
      score: c.score != null && c.score !== "" ? parseInt(c.score, 10) : null,
    }));
    if (!teams[0].abbr || !teams[1].abbr) continue;
    // Live state: prefer event status, fall back to competition status.
    const st = (ev.status && ev.status.type) || (comp.status && comp.status.type) || {};
    const fullStatus = ev.status || comp.status || {};
    const state = st.state || "pre"; // "pre" | "in" | "post"
    let detail = st.shortDetail || st.description || "";
    if (fullStatus.displayClock && state === "in") detail = `${detail} · ${fullStatus.displayClock}`.trim();
    if (!detail) detail = state === "post" ? "Final" : state === "in" ? "Live" : label;
    const home = teams.find((t) => t.homeAway === "home") || teams[1];
    const away = teams.find((t) => t.homeAway === "away") || teams[0];
    const gameId = ev.id || `${away.abbr}@${home.abbr}`;
    const game = {
      id: String(gameId),
      away: away.abbr,
      home: home.abbr,
      awayScore: Number.isFinite(away.score) ? away.score : null,
      homeScore: Number.isFinite(home.score) ? home.score : null,
      state,
      detail: detail || label,
      clock: fullStatus.displayClock || "",
      period: fullStatus.period || 0,
      date,
      label,
      weekday,
      special,
    };
    games[game.id] = game;
    for (let i = 0; i < 2; i++) {
      const me = teams[i], opp = teams[1 - i];
      map[me.abbr] = { opp: opp.abbr, homeAway: me.homeAway, date, label, weekday, special, gameId: game.id };
      teamToGame[me.abbr] = game.id;
    }
  }
  const result = { map, games, teamToGame, week, season, count: Object.keys(map).length };
  scheduleCache = { key, data: result };
  return result;
}

function gamePillHtml(nflTeam, schedule) {
  const t = normTeam(nflTeam);
  if (!t) return "";
  if (!schedule || !schedule.map) return "";
  const g = schedule.map[t];
  if (!g) return `<span class="game-pill game-bye" title="No game scheduled this week">Bye</span>`;
  const matchup = g.homeAway === "home" ? `vs ${g.opp}` : `@ ${g.opp}`;
  if (g.special) {
    return `<span class="game-pill game-special" title="Standalone window — not Sun 1pm/4pm ET">🌙 ${matchup} · ${g.label}</span>`;
  }
  return `<span class="game-pill" title="${g.label}">${matchup} · ${g.label}</span>`;
}

// ---------------- Unified league store ----------------
// Sleeper + ESPN cards share one grid. Per-league visibility toggles persist.
const leagueStore = new Map(); // key -> { key, platform, name, card }

function getHiddenLeagues() {
  try {
    const v = JSON.parse(localStorage.getItem("fc_hidden") || "[]");
    return new Set(Array.isArray(v) ? v : []);
  } catch (e) {
    return new Set();
  }
}

function setHiddenLeagues(set) {
  try {
    localStorage.setItem("fc_hidden", JSON.stringify([...set]));
  } catch (e) {}
}

function tagCard(card, platform, label) {
  const meta = card.querySelector(".league-meta");
  if (meta) meta.insertAdjacentHTML("afterbegin", `<span class="pill platform-${platform}">${label}</span>`);
}

function sortedLeagues() {
  return [...leagueStore.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function syncLeagues() {
  const hidden = getHiddenLeagues();
  const items = sortedLeagues();
  leaguesEl.innerHTML = "";
  let shown = 0;
  for (const it of items) {
    if (hidden.has(it.key)) continue;
    leaguesEl.appendChild(it.card);
    shown++;
  }
  const countEl = document.getElementById("visible-count");
  if (countEl) countEl.textContent = items.length === 0 ? "No leagues loaded yet." : `Showing ${shown} of ${items.length} leagues. Uncheck to hide.`;
  const box = document.getElementById("league-toggles");
  if (!box) return;
  box.innerHTML = "";
  for (const it of items) {
    const label = document.createElement("label");
    label.className = "toggle-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hidden.has(it.key);
    cb.addEventListener("change", () => {
      const h = getHiddenLeagues();
      if (cb.checked) h.delete(it.key);
      else h.add(it.key);
      setHiddenLeagues(h);
      syncLeagues();
      renderGameday();
    });
    const span = document.createElement("span");
    span.textContent = `${it.name} (${it.platform === "espn" ? "ESPN" : "Sleeper"})`;
    label.appendChild(cb);
    label.appendChild(span);
    box.appendChild(label);
  }
}

// ---------------- GameDay shared state ----------------
// Starters-only tracker grouped by NFL game. Benches excluded.
// Chopped/guillotine leagues (e.g. "Shotgun League") have no fixed opponent.
let gdSleeperData = []; // [{ league, roster, user, rosters, users, matchups, myRosterId }]
let gdPlayers = {};
let gdSchedule = null;
let gdWeek = null;
let gdSeason = null;

function isChoppedLeague(name) {
  return /shotgun|chopped|guillotine/i.test(String(name || ""));
}

// Which no-opponent format is it, for display ("No opponent (guillotine)").
function choppedKind(name) {
  const n = String(name || "");
  if (/guillotine/i.test(n)) return "guillotine";
  if (/shotgun/i.test(n)) return "shotgun";
  return "chopped";
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtPts(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(1);
}

function renderLeague(league, roster, user, players, schedule) {
  const teamName =
    (user && user.metadata && user.metadata.team_name) ||
    (user && user.display_name) ||
    `Roster #${roster.roster_id}`;
  const s = roster.settings || {};
  const record = `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ""}`;
  const fpts = s.fpts_decimal != null ? `${s.fpts ?? 0}.${String(s.fpts_decimal).padStart(2, "0")}` : (s.fpts ?? "—");

  const slots = starterSlots(league, roster);
  const bench = benchIds(roster);
  const weekPill = schedule && schedule.week ? `<span class="pill">NFL W${schedule.week}</span>` : "";

  const playerCell = (d, playerId) => `
    <div class="player-name ${!playerId || playerId === "0" ? "empty" : ""}">${d.name}</div>
    <div class="player-sub">${d.pos} · ${d.team}</div>
    ${d.injury ? `<div class="injury ${d.injury}">${d.injury}</div>` : ""}
    ${gamePillHtml(d.team, schedule)}
  `;

  const starterRows = slots
    .map(({ slot, playerId }) => {
      const d = describePlayer(playerId, players);
      return `<tr>
        <td class="slot">${slot}</td>
        <td>${playerCell(d, playerId)}</td>
      </tr>`;
    })
    .join("");

  const benchRows =
    bench.length === 0
      ? `<tr><td class="empty">Bench is empty</td></tr>`
      : bench
          .map((pid) => {
            const d = describePlayer(pid, players);
            return `<tr>
              <td class="slot">${d.pos}</td>
              <td>${playerCell(d, pid)}</td>
            </tr>`;
          })
          .join("");

  // Taxi / IR / Reserve extras (dynasty leagues)
  const extras = [];
  for (const key of ["taxi", "reserve", "injured_reserve"]) {
    if (Array.isArray(roster[key]) && roster[key].length > 0) {
      const names = roster[key].map((pid) => describePlayer(pid, players).name).join(", ");
      extras.push(`<div class="player-sub"><strong>${key.toUpperCase()}:</strong> ${names}</div>`);
    }
  }

  const card = document.createElement("div");
  card.className = "league-card";
  card.innerHTML = `
    <div class="league-head">
      <h2>${league.name}</h2>
      <div class="league-meta">
        <span class="pill">${teamName}</span>
        <span class="pill">Record ${record}</span>
        <span class="pill">${league.total_rosters}-team · ${league.season}</span>
        <span class="pill">${fpts} pts</span>
        ${weekPill}
      </div>
      <div class="player-sub" style="margin-top:6px">🌙 = special window (anything other than Sun 1pm / 4pm ET: Thu, SNF, Mon, Sat, London)</div>
    </div>
    <div class="section">
      <h3>Starting lineup</h3>
      <table><tbody>${starterRows}</tbody></table>
    </div>
    <div class="section">
      <h3>Bench (${bench.length})</h3>
      <table><tbody>${benchRows}</tbody></table>
      ${extras.join("")}
    </div>
  `;
  return card;
}

async function load() {
  const username = usernameInput.value.trim() || DEFAULT_USERNAME;
  const season = seasonInput.value;
  usernameLabel.textContent = username;
  seasonLabel.textContent = `season ${season}`;
  setStatus(`Looking up Sleeper user "${username}"…`);
  console.log("[FantasyCast] load start", { username, season });

  try {
    const user = await fetchJson(`${API}/user/${encodeURIComponent(username)}`);
    if (!user || !user.user_id) throw new Error(`User "${username}" not found.`);
    console.log("[FantasyCast] user", user.user_id, user.display_name);

    let nflState = null;
    try {
      nflState = await fetchJson(`${API}/state/nfl`);
      seasonLabel.textContent = `season ${season} · NFL week ${nflState.display_week ?? nflState.week} (${nflState.season_type})`;
    } catch (e) {
      console.warn("NFL state fetch failed", e);
    }

    setStatus(`Fetching ${season} leagues for ${user.display_name || username}…`);
    const leagues = await fetchJson(`${API}/user/${user.user_id}/leagues/nfl/${season}`);
    console.log("[FantasyCast] leagues", leagues && leagues.length);
    if (!leagues || leagues.length === 0) {
      setStatus(`No leagues found for ${username} in ${season}. Try another season (2025?). Open DevTools Console (F12) for details.`, true);
      return;
    }

    // Phase 1: load rosters + users first so something renders even if players DB fails.
    setStatus(`Found ${leagues.length} league(s). Loading rosters…`);
    const leagueData = [];
    for (const league of leagues) {
      try {
        const [rosters, users] = await Promise.all([
          fetchJson(`${API}/league/${league.league_id}/rosters`),
          fetchJson(`${API}/league/${league.league_id}/users`),
        ]);
        const myRoster = rosters.find(
          (r) => r.owner_id === user.user_id || (Array.isArray(r.co_owners) && r.co_owners.includes(user.user_id))
        );
        if (!myRoster) {
          console.warn(`No roster for ${user.user_id} in ${league.league_id} (${league.name})`);
          continue;
        }
        const leagueUser = users.find((u) => u.user_id === myRoster.owner_id);
        leagueData.push({ league, roster: myRoster, user: leagueUser, rosters, users, matchups: null });
      } catch (e) {
        console.error(`Failed loading league ${league.league_id} (${league.name})`, e);
      }
    }

    if (leagueData.length === 0) {
      setStatus("Found leagues but could not load any of your rosters. Open DevTools Console (F12) and look for failed requests.", true);
      return;
    }

    // Render immediately with empty players map (IDs as fallback), then enrich.
    const renderAll = (players, schedule) => {
      for (const key of [...leagueStore.keys()]) {
        if (key.startsWith("sleeper:")) leagueStore.delete(key);
      }
      for (const d of leagueData) {
        const card = renderLeague(d.league, d.roster, d.user, players, schedule);
        tagCard(card, "sleeper", "Sleeper");
        const key = `sleeper:${d.league.league_id}`;
        leagueStore.set(key, {
          key,
          platform: "sleeper",
          name: d.league.name || d.league.league_id,
          card,
        });
      }
      syncLeagues();
    };
    renderAll({}, null);
    setStatus(`Showing ${leagueData.length} team(s). Loading player names + game times…`);

    // Phase 2: player names + schedule in parallel (neither blocks roster structure).
    // Schedule week follows Sleeper's display_week so it matches the fantasy week.
    const schedWeek = (nflState && (nflState.display_week ?? nflState.week)) || 1;
    const schedSeason = (nflState && nflState.season) || season;
    const schedType = (nflState && nflState.season_type) || "regular";
    const [players, schedule] = await Promise.all([
      getPlayersMap(),
      getSchedule(schedSeason, schedWeek, schedType).catch((e) => {
        console.error("Schedule fetch failed, continuing without game times", e);
        return null;
      }),
    ]);
    renderAll(players, schedule);

    // Phase 3: weekly matchups for GameDay (my starters vs opponent starters, live points).
    gdSleeperData = leagueData;
    gdPlayers = players;
    gdSchedule = schedule;
    gdWeek = schedWeek;
    gdSeason = schedSeason;
    setStatus(`Loading week ${schedWeek} matchups for GameDay…`);
    await Promise.all(
      leagueData.map(async (d) => {
        try {
          d.matchups = await fetchJson(`${API}/league/${d.league.league_id}/matchups/${schedWeek}`);
        } catch (e) {
          console.warn(`Matchups failed for ${d.league.name}`, e);
          d.matchups = null;
        }
      })
    );
    renderGameday();

    const namesAvailable = Object.keys(players).length > 0;
    const schedNote = schedule ? ` Games: NFL W${schedule.week} (${schedule.count / 2} games).` : " Schedule unavailable.";
    if (namesAvailable) setStatus(`Showing ${leagueData.length} team(s) for ${user.display_name || username} · ${season}.${schedNote}`);
    else setStatus(`Showing ${leagueData.length} team(s) with player IDs only (player database failed to load).${schedNote}`, true);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message} — open DevTools (F12) > Console for the failing URL.`, true);
  }
}

loadBtn.addEventListener("click", load);
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") load();
});

// Auto-load default user on open. Defer one tick so the "Loading…" paint
// is visible and any script-load failure is distinguishable from fetch failure.
console.log("[FantasyCast] app.js loaded, scheduling initial load");
setStatus("Starting… if this never changes, app.js failed to run (hard-refresh Ctrl+Shift+R).");
setTimeout(load, 50);

// ---------------- ESPN fantasy leagues ----------------
// Public leagues need only the numeric League ID. Private leagues also need
// the SWID + espn_s2 cookies (ESPN site → F12 → Application → Cookies).
// Requests go through the local /api/espn proxy (server.py) when available,
// falling back to a direct reads-host call (works if you're logged into ESPN
// in this browser).
const ESPN_READS = "https://lm-api-reads.fantasy.espn.com";
const ESPN_SLOT_NAMES = { 0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP", 16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BN", 21: "IR", 23: "FLEX" };
const ESPN_SLOT_ORDER = ["QB", "RB", "RB/WR", "WR", "WR/TE", "TE", "FLEX", "OP", "TQB", "DT", "DE", "LB", "DL", "CB", "S", "DB", "DP", "D/ST", "K", "P", "HC"];
const ESPN_PRO_TEAMS = { 0: null, 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };
const ESPN_POSITIONS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

const espnLeagueInput = document.getElementById("espn-league-input");
const espnSeasonInput = document.getElementById("espn-season-input");
const espnWeekInput = document.getElementById("espn-week-input");
const espnTeamInput = document.getElementById("espn-team-input");
const espnSwidInput = document.getElementById("espn-swid-input");
const espnS2Input = document.getElementById("espn-s2-input");
const espnLoadBtn = document.getElementById("espn-load-btn");
const espnStatusEl = document.getElementById("espn-status");

let lastEspn = null; // { leagueName, season, week, teams, members, schedule }

function espnStatus(msg, isError = false) {
  espnStatusEl.textContent = msg;
  espnStatusEl.classList.toggle("error", isError);
}

function hasEspnData(j) {
  return !!(j && (j.teams || j.settings || j.status));
}

async function espnApi(season, leagueId, views, params = {}) {
  const q = new URLSearchParams();
  views.forEach((v) => q.append("view", v));
  for (const [k, v] of Object.entries(params)) q.append(k, String(v));
  const query = q.toString();
  let proxyError = null;
  // 1) Same-origin proxy (server.py). Carries pasted SWID/espn_s2 for private leagues.
  try {
    const headers = {};
    const s2 = espnS2Input.value.trim();
    const sw = espnSwidInput.value.trim();
    if (s2) headers["X-ESPN-S2"] = s2;
    if (sw) headers["X-ESPN-SWID"] = sw;
    const res = await fetch(`/api/espn?season=${encodeURIComponent(season)}&leagueId=${encodeURIComponent(leagueId)}&${query}`, { headers });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* proxy absent (other server) → fall through */ }
    if (j && hasEspnData(j)) return j;
    if (j && j.error) proxyError = new Error(j.error + (j.detail ? ` ESPN says: ${j.detail.slice(0, 200)}` : ""));
    else if (!j) proxyError = new Error(`Local proxy missing (got HTTP ${res.status}).`);
    else proxyError = new Error("Local proxy returned unexpected data.");
  } catch (e) {
    proxyError = proxyError || e;
    console.warn("[FantasyCast] ESPN proxy failed, trying direct", e);
  }
  // 2) Direct reads-host call (public leagues; private only if ESPN login cookies are sent).
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    let res, j;
    try {
      res = await fetch(`${ESPN_READS}/apis/v3/games/ffl/seasons/${encodeURIComponent(season)}/segments/0/leagues/${encodeURIComponent(leagueId)}?${query}`, { signal: ctrl.signal, credentials: "include" });
      j = await res.json();
    } finally {
      clearTimeout(t);
    }
    if (hasEspnData(j)) return j;
    throw new Error(`ESPN rejected the request (HTTP ${res.status}). ${res.status === 401 || res.status === 403 ? "Private league: paste SWID + espn_s2 above, or log into ESPN in this browser and retry." : "Check League ID / season."}`);
  } catch (e) {
    console.error("[FantasyCast] ESPN direct failed", e);
    throw proxyError && /SWID|Private|league ID/i.test(proxyError.message) ? proxyError : e;
  }
}

function espnOwnerName(team, members) {
  const ownerId = team.owners && team.owners[0];
  if (!ownerId || !Array.isArray(members)) return "";
  const norm = String(ownerId).replace(/[{}]/g, "").toLowerCase();
  const m = members.find((x) => String(x.id || "").replace(/[{}]/g, "").toLowerCase() === norm);
  return m ? (m.displayName || `${m.firstName || ""} ${m.lastName || ""}`.trim()) : "";
}

function renderEspnCard(leagueName, season, week, team, members, schedule) {
  const entries = (team.roster && team.roster.entries) || [];
  const rec = (team.record && team.record.overall) || {};
  const owner = espnOwnerName(team, members);
  const orderIdx = (slot) => espnSlotRank(slot);
  const info = (e) => {
    const p = (e.playerPoolEntry && e.playerPoolEntry.player) || {};
    const name = p.fullName || `Player ${e.playerId}`;
    const nfl = ESPN_PRO_TEAMS[p.proTeamId] || "FA";
    const pos = ESPN_POSITIONS[p.defaultPositionId] || p.defaultPositionId || "—";
    const injury = p.injuryStatus && p.injuryStatus !== "ACTIVE" ? p.injuryStatus : "";
    return { name, nfl, pos, injury };
  };
  const cell = (d) => `
    <div class="player-name">${d.name}</div>
    <div class="player-sub">${d.pos} · ${d.nfl}</div>
    ${d.injury ? `<div class="injury">${d.injury}</div>` : ""}
    ${gamePillHtml(d.nfl, schedule)}
  `;
  const starters = entries.filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21).sort((a, b) => orderIdx(a.lineupSlotId) - orderIdx(b.lineupSlotId));
  const bench = entries.filter((e) => e.lineupSlotId === 20);
  const ir = entries.filter((e) => e.lineupSlotId === 21);
  const starterRows = starters.map((e) => {
    const d = info(e);
    return `<tr><td class="slot">${ESPN_SLOT_NAMES[e.lineupSlotId] || "—"}</td><td>${cell(d)}</td></tr>`;
  }).join("") || `<tr><td class="empty">No starters found</td></tr>`;
  const benchRows = bench.length === 0
    ? `<tr><td class="empty">Bench is empty</td></tr>`
    : bench.map((e) => {
        const d = info(e);
        return `<tr><td class="slot">${d.pos}</td><td>${cell(d)}</td></tr>`;
      }).join("");
  const card = document.createElement("div");
  card.className = "league-card";
  card.innerHTML = `
    <div class="league-head">
      <h2>${leagueName} <span style="color:var(--muted);font-weight:400;font-size:13px">(ESPN)</span></h2>
      <div class="league-meta">
        <span class="pill">${team.name || team.abbrev || `Team ${team.id}`}${owner ? ` · ${owner}` : ""}</span>
        <span class="pill">Record ${rec.wins ?? 0}-${rec.losses ?? 0}${rec.ties ? `-${rec.ties}` : ""}</span>
        <span class="pill">${season} · W${week}</span>
      </div>
      <div class="player-sub" style="margin-top:6px">🌙 = special window (anything other than Sun 1pm / 4pm ET: Thu, SNF, Mon, Sat, London)</div>
    </div>
    <div class="section">
      <h3>Starting lineup</h3>
      <table><tbody>${starterRows}</tbody></table>
    </div>
    <div class="section">
      <h3>Bench (${bench.length})</h3>
      <table><tbody>${benchRows}</tbody></table>
      ${ir.length ? `<div class="player-sub"><strong>IR:</strong> ${ir.map((e) => info(e).name).join(", ")}</div>` : ""}
    </div>
  `;
  return card;
}

function renderEspn() {
  if (!lastEspn) return;
  const team = lastEspn.teams.find((t) => String(t.id) === String(espnTeamInput.value)) || lastEspn.teams[0];
  if (!team) {
    espnStatus("League loaded but no teams found.", true);
    return;
  }
  const card = renderEspnCard(lastEspn.leagueName, lastEspn.season, lastEspn.week, team, lastEspn.members, lastEspn.schedule);
  tagCard(card, "espn", "ESPN");
  const key = `espn:${lastEspn.leagueId}`;
  leagueStore.set(key, {
    key,
    platform: "espn",
    name: lastEspn.leagueName,
    card,
  });
  syncLeagues();
  renderGameday();
}

async function loadEspn() {
  const leagueId = espnLeagueInput.value.trim();
  const season = espnSeasonInput.value;
  if (!/^\d+$/.test(leagueId)) {
    espnStatus("Enter a numeric ESPN League ID (see the hint above for where to find it).", true);
    return;
  }
  try {
    localStorage.setItem("espn_league", leagueId);
    localStorage.setItem("espn_season", season);
    if (espnSwidInput.value.trim()) localStorage.setItem("espn_swid", espnSwidInput.value.trim());
    if (espnS2Input.value.trim()) localStorage.setItem("espn_s2", espnS2Input.value.trim());
  } catch (e) { /* private-mode browser: persistence optional */ }

  espnStatus(`Contacting ESPN for league ${leagueId}…`);
  console.log("[FantasyCast] ESPN load", { leagueId, season });
  try {
    // Week auto-detect from league status unless the user typed one.
    let week = parseInt(espnWeekInput.value, 10);
    const st = await espnApi(season, leagueId, ["mStatus"]);
    const autoWeek = st.status && st.status.currentMatchupPeriod;
    if (!week || week < 1) {
      week = autoWeek || 1;
      espnWeekInput.value = week;
    }
    espnStatus(`Loading week ${week} roster…`);
    let boxErr = "";
    const [league, box] = await Promise.all([
      espnApi(season, leagueId, ["mTeam", "mRoster", "mSettings"], { scoringPeriodId: week }),
      espnApi(season, leagueId, ["mMatchup", "mBoxscore"], { scoringPeriodId: week }).catch((e) => {
        console.warn("[FantasyCast] ESPN boxscore failed, opponent points unavailable", e);
        boxErr = (e && e.message) || String(e);
        return null;
      }),
    ]);
    const teams = league.teams || [];
    if (teams.length === 0) throw new Error("ESPN returned no teams. Check League ID / season.");
    const leagueName = (league.settings && league.settings.name) || `ESPN League ${leagueId}`;

    // Populate team picker, keep previous selection when possible.
    const prevTeam = espnTeamInput.value || localStorage.getItem("espn_team") || "";
    espnTeamInput.innerHTML = "";
    for (const t of teams) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      const owner = espnOwnerName(t, league.members);
      opt.textContent = `${t.name || t.abbrev || `Team ${t.id}`}${owner ? ` (${owner})` : ""}`;
      espnTeamInput.appendChild(opt);
    }
    if (prevTeam && teams.some((t) => String(t.id) === String(prevTeam))) espnTeamInput.value = prevTeam;

    lastEspn = { leagueId, leagueName, season, week, teams, members: league.members || [], schedule: null, boxscore: box && box.schedule ? box.schedule : [], boxscoreError: boxErr };
    // If the week-scoped boxscore has no entry for my team, try the
    // full-season schedule to at least identify the opponent.
    await backfillEspnMatchupItem();
    renderEspn();
    espnStatus(`Showing ${leagueName}. Loading game times…`);

    const schedule = await getSchedule(season, week, "regular").catch((e) => {
      console.error("Schedule fetch failed", e);
      return null;
    });
    lastEspn.schedule = schedule;
    renderEspn();
    renderGameday();
    espnStatus(`Showing ${leagueName} · week ${week} (${teams.length} teams).${schedule ? "" : " Game times unavailable."}`);
    try { localStorage.setItem("espn_team", espnTeamInput.value); } catch (e) {}
  } catch (err) {
    console.error("[FantasyCast] ESPN load failed", err);
    espnStatus(`Error: ${err.message}`, true);
  }
}

espnLoadBtn.addEventListener("click", loadEspn);
espnTeamInput.addEventListener("change", () => {
  try { localStorage.setItem("espn_team", espnTeamInput.value); } catch (e) {}
  renderEspn();
});

// Prefill saved ESPN settings (league ID / creds stay in this browser only).
try {
  if (localStorage.getItem("espn_league")) espnLeagueInput.value = localStorage.getItem("espn_league");
  if (localStorage.getItem("espn_season")) espnSeasonInput.value = localStorage.getItem("espn_season");
  if (localStorage.getItem("espn_swid")) espnSwidInput.value = localStorage.getItem("espn_swid");
  if (localStorage.getItem("espn_s2")) espnS2Input.value = localStorage.getItem("espn_s2");
} catch (e) {}

// Collapsible setup panel (state persists across visits).
const panelEl = document.getElementById("control-panel");
const panelToggleBtn = document.getElementById("panel-toggle");
function setPanelCollapsed(collapsed) {
  if (!panelEl || !panelToggleBtn) return;
  panelEl.classList.toggle("collapsed", collapsed);
  panelToggleBtn.textContent = collapsed ? "Show setup ▼" : "Hide setup ▲";
  try {
    localStorage.setItem("fc_panel_collapsed", collapsed ? "1" : "0");
  } catch (e) {}
}
if (panelToggleBtn) {
  panelToggleBtn.addEventListener("click", () => {
    setPanelCollapsed(!panelEl.classList.contains("collapsed"));
  });
}
try {
  if (localStorage.getItem("fc_panel_collapsed") === "1") setPanelCollapsed(true);
} catch (e) {}

// Show all / Hide all league toggles.
document.getElementById("show-all-btn").addEventListener("click", () => {
  setHiddenLeagues(new Set());
  syncLeagues();
  renderGameday();
});
document.getElementById("hide-all-btn").addEventListener("click", () => {
  setHiddenLeagues(new Set([...leagueStore.keys()]));
  syncLeagues();
  renderGameday();
});

// ---------------- Tabs ----------------
const tabBtns = [...document.querySelectorAll(".tab")];
const viewLeagues = document.getElementById("view-leagues");
const viewGameday = document.getElementById("view-gameday");
function setTab(name) {
  for (const b of tabBtns) {
    const active = b.dataset.tab === name;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  }
  if (viewLeagues) viewLeagues.hidden = name !== "leagues";
  if (viewGameday) viewGameday.hidden = name !== "gameday";
  try { localStorage.setItem("fc_tab", name); } catch (e) {}
  if (name === "gameday") renderGameday();
}
for (const b of tabBtns) b.addEventListener("click", () => setTab(b.dataset.tab));
try {
  const saved = localStorage.getItem("fc_tab");
  if (saved === "gameday") setTab("gameday");
} catch (e) {}

// ---------------- GameDay: starters grouped by NFL game ----------------
function sleeperTeamLabel(rosters, users, rosterId) {
  const r = (rosters || []).find((x) => String(x.roster_id) === String(rosterId));
  if (!r) return `Roster #${rosterId}`;
  const u = (users || []).find((x) => x.user_id === r.owner_id);
  return (u && (u.metadata?.team_name || u.display_name)) || `Roster #${rosterId}`;
}

function collectSleeperEntries() {
  const out = [];
  const hidden = getHiddenLeagues();
  for (const d of gdSleeperData) {
    if (hidden.has(`sleeper:${d.league.league_id}`)) continue;
    const leagueName = d.league.name || d.league.league_id;
    const chopped = isChoppedLeague(d.league.name); // include my starters, just no opponents
    const myRosterId = d.roster.roster_id;
    if (Array.isArray(d.matchups) && d.matchups.length > 0) {
      const mine = d.matchups.find((m) => String(m.roster_id) === String(myRosterId));
      if (!mine) continue;
      const opps = d.matchups.filter(
        (m) => String(m.matchup_id) === String(mine.matchup_id) && String(m.roster_id) !== String(myRosterId)
      );
      const slots = starterSlots(d.league, { starters: mine.starters || [] });
      (mine.starters || []).forEach((pid, idx) => {
        const desc = describePlayer(pid, gdPlayers);
        const pts = mine.starters_points && mine.starters_points[idx] != null
          ? mine.starters_points[idx]
          : (mine.players_points && mine.players_points[pid] != null ? mine.players_points[pid] : null);
        // Dynasty fallback: if live points missing (pre-kickoff), fall back to 0.0
        // but keep the row so the game grouping still shows the player.
        out.push({
          leagueName, platform: "sleeper", side: "mine",
          teamLabel: sleeperTeamLabel(d.rosters, d.users, myRosterId),
          slot: (slots[idx] && slots[idx].slot) || "—",
          playerName: desc.name, pos: desc.pos, nflTeam: normTeam(desc.team),
          fantasyPts: pts != null ? Number(pts) : null,
        });
      });
      for (const opp of opps) {
        if (chopped) break; // chopped/guillotine: my starters only, no opponents
        const oppLabel = sleeperTeamLabel(d.rosters, d.users, opp.roster_id);
        const oppSlots = starterSlots(d.league, { starters: opp.starters || [] });
        (opp.starters || []).forEach((pid, idx) => {
          const desc = describePlayer(pid, gdPlayers);
          const pts = opp.starters_points && opp.starters_points[idx] != null
            ? opp.starters_points[idx]
            : (opp.players_points && opp.players_points[pid] != null ? opp.players_points[pid] : null);
          out.push({
            leagueName, platform: "sleeper", side: "opp",
            teamLabel: oppLabel,
            slot: (oppSlots[idx] && oppSlots[idx].slot) || "—",
            playerName: desc.name, pos: desc.pos, nflTeam: normTeam(desc.team),
            fantasyPts: pts != null ? Number(pts) : null,
          });
        });
      }
    } else {
      // No matchup data (e.g. offseason): fall back to current roster starters, 0 pts.
      const slots = starterSlots(d.league, d.roster);
      for (const { slot, playerId } of slots) {
        const desc = describePlayer(playerId, gdPlayers);
        out.push({
          leagueName, platform: "sleeper", side: "mine",
          teamLabel: sleeperTeamLabel(d.rosters, d.users, myRosterId),
          slot, playerName: desc.name, pos: desc.pos, nflTeam: normTeam(desc.team),
          fantasyPts: null,
        });
      }
    }
  }
  return out;
}

function espnEntryInfo(e) {
  const p = (e.playerPoolEntry && e.playerPoolEntry.player) || {};
  const rawAbbr = ESPN_PRO_TEAMS[p.proTeamId] || "FA";
  return {
    name: p.fullName || `Player ${e.playerId}`,
    nfl: normTeam(rawAbbr),
    pos: ESPN_POSITIONS[p.defaultPositionId] || "—",
    pts: e.playerPoolEntry && e.playerPoolEntry.appliedStatTotal != null
      ? Number(e.playerPoolEntry.appliedStatTotal) : null,
  };
}

function espnSlotRank(slotId) {
  const i = ESPN_SLOT_ORDER.indexOf(ESPN_SLOT_NAMES[slotId] || "");
  return i === -1 ? 99 : i;
}

// Boxscore/roster entries come back in API order (effectively random), so
// sort starters into regular lineup order: QB, RB, WR, TE, FLEX, …; ties by name.
function espnStarterSort(a, b) {
  const r = espnSlotRank(a.lineupSlotId) - espnSlotRank(b.lineupSlotId);
  if (r !== 0) return r;
  const an = (a.playerPoolEntry && a.playerPoolEntry.player && a.playerPoolEntry.player.fullName) || "";
  const bn = (b.playerPoolEntry && b.playerPoolEntry.player && b.playerPoolEntry.player.fullName) || "";
  return an.localeCompare(bn);
}

// ESPN v3 schedule entries nest team IDs under home/away objects
// ({ home: { teamId }, away: { teamId } }); some responses also carry
// top-level homeTeamId/awayTeamId. Accept either shape.
function espnSchedIds(s) {
  if (!s) return [null, null];
  const h = s.homeTeamId != null ? s.homeTeamId : (s.home && s.home.teamId);
  const a = s.awayTeamId != null ? s.awayTeamId : (s.away && s.away.teamId);
  return [h != null ? String(h) : null, a != null ? String(a) : null];
}

// Find my team's boxscore matchup. Prefers the current-week entry, but falls
// back to any entry containing my team so a week-number mismatch (e.g.
// scoringPeriod vs matchupPeriod in playoffs) doesn't hide the opponent.
function findEspnBoxItem(boxList, myTeamId, week) {
  if (!Array.isArray(boxList) || boxList.length === 0) return null;
  const want = String(myTeamId);
  const containsMe = (s) => {
    const [h, a] = espnSchedIds(s);
    return h === want || a === want;
  };
  const exact = boxList.find((s) => {
    if (s.matchupPeriodId != null && Number(s.matchupPeriodId) !== Number(week)) return false;
    return containsMe(s);
  });
  if (exact) return exact;
  return boxList.find(containsMe) || null;
}

// Last-resort opponent lookup: fetch the full-season matchup schedule
// (no scoringPeriodId) and append my team's week entry to the boxscore
// list. Only identifies the opponent (live per-player points still need
// the week boxscore); the roster fallback then supplies their starters.
async function backfillEspnMatchupItem() {
  if (!lastEspn || !Array.isArray(lastEspn.teams) || lastEspn.teams.length === 0) return false;
  const myId = String(espnTeamInput.value || (lastEspn.teams[0] && lastEspn.teams[0].id));
  if (findEspnBoxItem(lastEspn.boxscore, myId, lastEspn.week)) return false;
  try {
    const full = await espnApi(lastEspn.season, lastEspn.leagueId, ["mMatchup"]);
    const sched = full && full.schedule;
    if (!Array.isArray(sched) || sched.length === 0) return false;
    const containsMe = (s) => {
      const [h, a] = espnSchedIds(s);
      return h === myId || a === myId;
    };
    const hit = sched.find((s) => Number(s.matchupPeriodId) === Number(lastEspn.week) && containsMe(s))
      || sched.find(containsMe);
    if (!hit) {
      const summarize = (list) => (list || []).slice(0, 8).map((s) => {
        const [h, a] = espnSchedIds(s);
        return { mp: s.matchupPeriodId, h, a };
      });
      console.warn("[FantasyCast] ESPN matchup debug: my team in no schedule entry", {
        myTeamId: myId,
        myTeamIdType: typeof myId,
        week: lastEspn.week,
        season: lastEspn.season,
        leagueTeamIds: (lastEspn.teams || []).map((t) => t.id),
        weekBoxscoreEntries: summarize(lastEspn.boxscore),
        weekBoxscoreCount: (lastEspn.boxscore || []).length,
        seasonEntriesSample: summarize(sched),
        seasonEntriesCount: sched.length,
        firstSeasonEntryKeys: sched[0] ? Object.keys(sched[0]) : [],
      });
      return false;
    }
    lastEspn.boxscore = [...(lastEspn.boxscore || []), hit];
    console.log("[FantasyCast] ESPN backfill: opponent identified from season schedule");
    return true;
  } catch (e) {
    console.warn("[FantasyCast] ESPN full-season matchup backfill failed", e);
    return false;
  }
}

function collectEspnEntries() {
  const out = [];
  if (!lastEspn || !Array.isArray(lastEspn.teams) || lastEspn.teams.length === 0) return out;
  if (getHiddenLeagues().has(`espn:${lastEspn.leagueId}`)) return out;
  const chopped = isChoppedLeague(lastEspn.leagueName); // include my starters, just no opponents
  const myId = String(espnTeamInput.value || (lastEspn.teams[0] && lastEspn.teams[0].id));
  const myTeam = lastEspn.teams.find((t) => String(t.id) === myId) || lastEspn.teams[0];
  const leagueName = lastEspn.leagueName;
  const boxList = Array.isArray(lastEspn.boxscore) ? lastEspn.boxscore : [];
  const item = findEspnBoxItem(boxList, myTeam.id, lastEspn.week);
  const [itemHomeId, itemAwayId] = espnSchedIds(item);
  const isHome = item && itemHomeId === String(myTeam.id);
  const myBox = item ? (isHome ? item.home : item.away) : null;
  const oppBox = item ? (isHome ? item.away : item.home) : null;
  const oppTeamId = item ? (isHome ? itemAwayId : itemHomeId) : null;
  const oppTeam = (lastEspn.teams || []).find((t) => String(t.id) === String(oppTeamId));
  const isStarter = (e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21;
  if (myBox && myBox.rosterForCurrentScoringPeriod) {
    for (const e of (myBox.rosterForCurrentScoringPeriod.entries || []).filter(isStarter).sort(espnStarterSort)) {
      const d = espnEntryInfo(e);
      out.push({
        leagueName, platform: "espn", side: "mine",
        teamLabel: myTeam.name || `Team ${myTeam.id}`,
        slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
        playerName: d.name, pos: d.pos, nflTeam: d.nfl, fantasyPts: d.pts,
      });
    }
  } else {
    // Fallback to roster view (no live points yet).
    for (const e of ((myTeam.roster && myTeam.roster.entries) || []).filter(isStarter).sort(espnStarterSort)) {
      const d = espnEntryInfo(e);
      out.push({
        leagueName, platform: "espn", side: "mine",
        teamLabel: myTeam.name || `Team ${myTeam.id}`,
        slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
        playerName: d.name, pos: d.pos, nflTeam: d.nfl, fantasyPts: null,
      });
    }
  }
  if (!chopped) {
    const oppLabel = (oppTeam && oppTeam.name) || (oppTeamId ? `Team ${oppTeamId}` : "Opponent");
    if (oppBox && oppBox.rosterForCurrentScoringPeriod) {
      for (const e of (oppBox.rosterForCurrentScoringPeriod.entries || []).filter(isStarter).sort(espnStarterSort)) {
        const d = espnEntryInfo(e);
        out.push({
          leagueName, platform: "espn", side: "opp",
          teamLabel: oppLabel,
          slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
          playerName: d.name, pos: d.pos, nflTeam: d.nfl, fantasyPts: d.pts,
        });
      }
    } else if (oppTeam && oppTeam.roster && Array.isArray(oppTeam.roster.entries)) {
      // Boxscore missing (not yet live / fetch failed): fall back to the
      // opponent's roster starters so the matchup still shows both sides.
      for (const e of oppTeam.roster.entries.filter(isStarter).sort(espnStarterSort)) {
        const d = espnEntryInfo(e);
        out.push({
          leagueName, platform: "espn", side: "opp",
          teamLabel: oppLabel,
          slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
          playerName: d.name, pos: d.pos, nflTeam: d.nfl, fantasyPts: null,
        });
      }
    }
  }
  return out;
}

// ---------------- GameDay group mode: NFL game vs fantasy matchup ----------------
let gdGroupMode = "nfl"; // "nfl" | "matchup"
let gdMatchupLeagueKey = "";
try {
  const g = localStorage.getItem("fc_gameday_group");
  if (g === "matchup" || g === "nfl") gdGroupMode = g;
  gdMatchupLeagueKey = localStorage.getItem("fc_gameday_matchup_league") || "";
} catch (e) {}

function getGamedayLeagueOptions() {
  const hidden = getHiddenLeagues();
  return sortedLeagues()
    .filter((it) => !hidden.has(it.key))
    .map((it) => ({ key: it.key, name: it.name, platform: it.platform }));
}

function syncGamedayLeaguePicker() {
  const groupInput = document.getElementById("gameday-group-input");
  const leagueWrap = document.getElementById("gameday-league-wrap");
  const leagueInput = document.getElementById("gameday-league-input");
  if (groupInput && groupInput.value !== gdGroupMode) groupInput.value = gdGroupMode;
  if (leagueWrap) leagueWrap.hidden = gdGroupMode !== "matchup";
  if (!leagueInput) return;
  const opts = getGamedayLeagueOptions();
  const prev = gdMatchupLeagueKey || leagueInput.value;
  leagueInput.innerHTML = "";
  if (opts.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "(no visible leagues)";
    leagueInput.appendChild(o);
    gdMatchupLeagueKey = "";
    return;
  }
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o.key;
    el.textContent = `${o.name} (${o.platform === "espn" ? "ESPN" : "Sleeper"})`;
    leagueInput.appendChild(el);
  }
  if (prev && opts.some((o) => o.key === prev)) {
    leagueInput.value = prev;
    gdMatchupLeagueKey = prev;
  } else {
    leagueInput.value = opts[0].key;
    gdMatchupLeagueKey = opts[0].key;
  }
}

function parseClockToMins(clock) {
  if (!clock) return null;
  const m = String(clock).trim().match(/(\d+):(\d{1,2})/);
  if (!m) return null;
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
}

// Aggregate "minutes remaining" per NFL game for the matchup header.
// Pre-kickoff = full 60, final = 0, live = derived from quarter + clock.
function minutesRemainingForGame(game) {
  if (!game) return 0;
  if (game.state === "pre") return 60;
  if (game.state === "post") return 0;
  if (game.state !== "in") return 0;
  const detail = String(game.detail || "");
  if (/half/i.test(detail)) return 30;
  const clockMins = parseClockToMins(game.clock);
  const p = Number(game.period) || 0;
  if (p >= 1 && p <= 4) {
    const c = clockMins != null ? clockMins : 0;
    return Math.max(0, (4 - p) * 15 + c);
  }
  if (p > 4) return clockMins != null ? Math.max(0, clockMins) : 0; // OT
  return clockMins != null ? Math.max(0, clockMins) : 0;
}

// Plain game score/state line for matchup rows (no special-window highlight).
function gameLineFor(game) {
  if (!game) return "Bye";
  if (game.state === "pre") return `${game.away} @ ${game.home} · ${game.label}`;
  if (game.state === "post") {
    if (game.awayScore != null && game.homeScore != null) return `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore} · Final`;
    return `${game.away} @ ${game.home} · Final`;
  }
  // Live
  const score = game.awayScore != null && game.homeScore != null
    ? `${game.away} ${game.awayScore} @ ${game.home} ${game.homeScore}`
    : `${game.away} @ ${game.home}`;
  return game.detail ? `${score} · ${game.detail}` : score;
}

function matchupGameFor(nflTeam, sched) {
  if (!nflTeam || !sched || !sched.teamToGame || !sched.games) return null;
  const gid = sched.teamToGame[nflTeam];
  return (gid && sched.games[gid]) || null;
}

// Points counted toward the "scored to date" header: pre-kickoff games count 0.
function matchupCountablePts(entry) {
  if (entry.game && entry.game.state === "pre") return 0;
  const n = Number(entry.fantasyPts);
  return Number.isFinite(n) ? n : 0;
}

function matchupDisplayPts(entry) {
  if (entry.game && entry.game.state === "pre") return "—";
  if (entry.game && (entry.game.state === "in" || entry.game.state === "post")) return fmtPts(entry.fantasyPts ?? 0);
  return entry.fantasyPts != null ? fmtPts(entry.fantasyPts) : "—";
}

function buildSleeperMatchup(leagueKey, sched) {
  const d = gdSleeperData.find((x) => `sleeper:${x.league.league_id}` === leagueKey);
  if (!d) return null;
  const leagueName = d.league.name || d.league.league_id;
  const chopped = isChoppedLeague(d.league.name);
  const myRosterId = d.roster.roster_id;
  const my = [];
  const opp = [];
  let myLabel = sleeperTeamLabel(d.rosters, d.users, myRosterId);
  let oppLabel = null;
  const pushStarter = (arr, pid, idx, slots, pointsArr, playersPoints) => {
    const desc = describePlayer(pid, gdPlayers);
    const nflTeam = normTeam(desc.team);
    let pts = pointsArr && pointsArr[idx] != null ? Number(pointsArr[idx]) : null;
    if (pts == null && playersPoints && playersPoints[pid] != null) pts = Number(playersPoints[pid]);
    arr.push({
      slot: (slots[idx] && slots[idx].slot) || "—",
      playerName: desc.name, pos: desc.pos, nflTeam,
      fantasyPts: pts,
      game: matchupGameFor(nflTeam, sched),
    });
  };
  if (Array.isArray(d.matchups) && d.matchups.length > 0) {
    const mine = d.matchups.find((m) => String(m.roster_id) === String(myRosterId));
    if (!mine) return null;
    const slots = starterSlots(d.league, { starters: mine.starters || [] });
    (mine.starters || []).forEach((pid, idx) => pushStarter(my, pid, idx, slots, mine.starters_points, mine.players_points));
    if (!chopped) {
      const opps = d.matchups.filter(
        (m) => String(m.matchup_id) === String(mine.matchup_id) && String(m.roster_id) !== String(myRosterId)
      );
      const first = opps[0];
      if (first) {
        oppLabel = sleeperTeamLabel(d.rosters, d.users, first.roster_id);
        const oppSlots = starterSlots(d.league, { starters: first.starters || [] });
        (first.starters || []).forEach((pid, idx) => pushStarter(opp, pid, idx, oppSlots, first.starters_points, first.players_points));
      }
    }
  } else {
    const slots = starterSlots(d.league, d.roster);
    for (const { slot, playerId } of slots) {
      const desc = describePlayer(playerId, gdPlayers);
      const nflTeam = normTeam(desc.team);
      my.push({ slot, playerName: desc.name, pos: desc.pos, nflTeam, fantasyPts: null, game: matchupGameFor(nflTeam, sched) });
    }
  }
  let oppReason = "ok";
  if (chopped) oppReason = "chopped";
  else if (opp.length > 0) oppReason = "ok";
  else oppReason = "no-matchup";
  return { leagueName, platform: "sleeper", myLabel, oppLabel, chopped, my, opp, oppReason };
}

function buildEspnMatchup(leagueKey, sched) {
  if (!lastEspn || `espn:${lastEspn.leagueId}` !== leagueKey) return null;
  if (!Array.isArray(lastEspn.teams) || lastEspn.teams.length === 0) return null;
  const leagueName = lastEspn.leagueName;
  const chopped = isChoppedLeague(lastEspn.leagueName);
  const myId = String(espnTeamInput.value || (lastEspn.teams[0] && lastEspn.teams[0].id));
  const myTeam = lastEspn.teams.find((t) => String(t.id) === myId) || lastEspn.teams[0];
  const boxList = Array.isArray(lastEspn.boxscore) ? lastEspn.boxscore : [];
  const item = findEspnBoxItem(boxList, myTeam.id, lastEspn.week);
  const [itemHomeId, itemAwayId] = espnSchedIds(item);
  const isHome = item && itemHomeId === String(myTeam.id);
  const myBox = item ? (isHome ? item.home : item.away) : null;
  const oppBox = item ? (isHome ? item.away : item.home) : null;
  const oppTeamId = item ? (isHome ? itemAwayId : itemHomeId) : null;
  const oppTeam = (lastEspn.teams || []).find((t) => String(t.id) === String(oppTeamId));
  const isStarter = (e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21;
  const toEntry = (e) => {
    const dd = espnEntryInfo(e);
    return {
      slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
      playerName: dd.name, pos: dd.pos, nflTeam: dd.nfl,
      fantasyPts: dd.pts,
      game: matchupGameFor(dd.nfl, sched),
    };
  };
  const my = myBox && myBox.rosterForCurrentScoringPeriod
    ? (myBox.rosterForCurrentScoringPeriod.entries || []).filter(isStarter).sort(espnStarterSort).map(toEntry)
    : ((myTeam.roster && myTeam.roster.entries) || []).filter(isStarter).sort(espnStarterSort).map(toEntry);
  let opp = [];
  let oppLabel = (oppTeam && oppTeam.name) || (oppTeamId ? `Team ${oppTeamId}` : null);
  if (chopped) {
    opp = [];
    oppLabel = null;
  } else if (oppBox && oppBox.rosterForCurrentScoringPeriod) {
    opp = (oppBox.rosterForCurrentScoringPeriod.entries || []).filter(isStarter).sort(espnStarterSort).map(toEntry);
  } else if (oppTeam && oppTeam.roster && Array.isArray(oppTeam.roster.entries)) {
    // Boxscore missing (not yet live / fetch failed): fall back to the
    // opponent's roster starters so the matchup still shows both sides.
    opp = oppTeam.roster.entries.filter(isStarter).sort(espnStarterSort).map(toEntry);
  }
  let oppReason = "ok";
  if (chopped) oppReason = "chopped";
  else if (opp.length > 0) oppReason = "ok";
  else if (!item) oppReason = (boxList.length === 0 ? (lastEspn.boxscoreError ? "boxscore-error" : "boxscore-empty") : "no-matchup");
  else oppReason = "no-opp-starters";
  return { leagueName, platform: "espn", myLabel: myTeam.name || `Team ${myTeam.id}`, oppLabel, chopped, my, opp, oppReason };
}

function buildMatchupData(leagueKey, sched) {
  if (!leagueKey) return null;
  if (leagueKey.startsWith("sleeper:")) return buildSleeperMatchup(leagueKey, sched);
  if (leagueKey.startsWith("espn:")) return buildEspnMatchup(leagueKey, sched);
  return null;
}

function gameKeyForEntry(entry) {
  if (!entry.nflTeam || !gdSchedule || !gdSchedule.teamToGame) return null;
  return gdSchedule.teamToGame[entry.nflTeam] || null;
}

function fmtMins(n) {
  const r = Math.round(Number(n) || 0);
  return `${r} min left`;
}

let lastOppWarnKey = "";

function renderGamedayMatchup(wrap, status, sched, weekLabel) {
  const opts = getGamedayLeagueOptions();
  if (opts.length === 0) {
    status.textContent = "No visible leagues for a fantasy matchup. Load a league or re-check one in Setup → Leagues.";
    wrap.innerHTML = "";
    return;
  }
  if (!gdMatchupLeagueKey || !opts.some((o) => o.key === gdMatchupLeagueKey)) {
    gdMatchupLeagueKey = opts[0].key;
    syncGamedayLeaguePicker();
  }
  const m = buildMatchupData(gdMatchupLeagueKey, sched);
  if (!m || (m.my.length === 0 && m.opp.length === 0)) {
    status.textContent = `No starters found for ${opts.find((o) => o.key === gdMatchupLeagueKey)?.name || "this league"} (matchups haven't loaded yet).`;
    wrap.innerHTML = "";
    return;
  }
  const myPts = m.my.reduce((a, e) => a + matchupCountablePts(e), 0);
  const oppPts = m.opp.reduce((a, e) => a + matchupCountablePts(e), 0);
  const myMins = m.my.reduce((a, e) => a + minutesRemainingForGame(e.game), 0);
  const oppMins = m.opp.reduce((a, e) => a + minutesRemainingForGame(e.game), 0);
  const hasOpp = !m.chopped && m.opp.length > 0 && m.oppLabel;
  const oppUnavailableText = () => {
    if (m.chopped) return `no opponent (${choppedKind(m.leagueName)})`;
    switch (m.oppReason) {
      case "boxscore-error":
        return "opponent unavailable (ESPN matchup data failed to load — private league? check SWID + espn_s2, then Refresh scores)";
      case "boxscore-empty":
        return "opponent unavailable (ESPN returned no matchup data — hit Refresh scores)";
      case "no-matchup":
        return `opponent unavailable (no Week ${weekLabel} matchup found for your team — check the Week field, then Refresh scores)`;
      case "no-opp-starters":
        return `opponent unavailable (no starters listed for ${m.oppLabel || "opponent"})`;
      default:
        return "opponent unavailable — hit “Refresh scores”";
    }
  };
  const oppNote = hasOpp ? `${m.oppLabel} ${fmtPts(oppPts)}` : oppUnavailableText();
  status.textContent = `Week ${weekLabel} · ${m.leagueName} (${m.platform === "espn" ? "ESPN" : "Sleeper"}) · ${m.myLabel} ${fmtPts(myPts)} vs ${oppNote}.`;
  if (!hasOpp && !m.chopped) {
    // Dedupe: renders happen often (toggles, refreshes); log once per cause.
    const warnKey = `${gdMatchupLeagueKey}|${weekLabel}|${m.oppReason}`;
    if (warnKey !== lastOppWarnKey) {
      lastOppWarnKey = warnKey;
      console.warn("[FantasyCast] matchup opponent missing", {
        league: m.leagueName, platform: m.platform, reason: m.oppReason,
        week: weekLabel, boxscoreEntries: lastEspn && lastEspn.boxscore ? lastEspn.boxscore.length : null,
        boxscoreError: (lastEspn && lastEspn.boxscoreError) || null,
      });
    }
  }

  const rowHtml = (e) => {
    const mins = minutesRemainingForGame(e.game);
    return `<div class="mu-player">
      <div class="mu-line1"><span class="slot-inline">${escHtml(e.slot)}</span><span class="player-name">${escHtml(e.playerName)}</span><span class="fpts-cell">${matchupDisplayPts(e)}</span></div>
      <div class="player-sub">${escHtml(e.pos)} · ${escHtml(e.nflTeam || "—")}</div>
      <div class="player-sub mu-game">${escHtml(gameLineFor(e.game))} · ${fmtMins(mins)}</div>
    </div>`;
  };

  const n = Math.max(m.my.length, m.opp.length);
  let rows = "";
  for (let i = 0; i < n; i++) {
    const me = m.my[i];
    const op = hasOpp ? m.opp[i] : undefined;
    rows += `<tr class="mu-row"><td class="mu-cell mine">${me ? rowHtml(me) : `<span class="empty">—</span>`}</td><td class="mu-cell opp">${op ? rowHtml(op) : `<span class="empty">—</span>`}</td></tr>`;
  }

  wrap.innerHTML = "";
  const card = document.createElement("div");
  card.className = "gd-game mu-card";
  card.innerHTML = `
    <div class="mu-header">
      <div class="mu-team mine"><div class="mu-team-name">${escHtml(m.myLabel)}</div><div class="mu-team-score">${fmtPts(myPts)} <span class="player-sub">· ${fmtMins(myMins)}</span></div></div>
      <div class="mu-vs">vs</div>
      <div class="mu-team opp">${hasOpp ? `<div class="mu-team-name">${escHtml(m.oppLabel)}</div><div class="mu-team-score">${fmtPts(oppPts)} <span class="player-sub">· ${fmtMins(oppMins)}</span></div>` : `<div class="mu-team-name empty">${m.chopped ? `No opponent (${choppedKind(m.leagueName)})` : escHtml(oppUnavailableText())}</div>`}</div>
    </div>
    <div class="gd-body">
      <table class="mu-table">
        <thead><tr><th>${escHtml(m.myLabel)} — starters</th>${hasOpp ? `<th>${escHtml(m.oppLabel)} — starters</th>` : `<th></th>`}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  wrap.appendChild(card);
}

function renderGameday() {
  const wrap = document.getElementById("gameday");
  const status = document.getElementById("gameday-status");
  if (!wrap || !status) return;
  // Runs on every render so the League picker hides/shows with the mode
  // no matter which path (tab switch, toggle, refresh) got us here.
  syncGamedayLeaguePicker();
  const sched = gdSchedule || (lastEspn && lastEspn.schedule) || null;
  if (sched && !gdSchedule) gdSchedule = sched;
  const weekLabel = gdWeek || (lastEspn && lastEspn.week) || "—";
  if (gdGroupMode === "matchup") {
    renderGamedayMatchup(wrap, status, gdSchedule, weekLabel);
    return;
  }
  const entries = [...collectSleeperEntries(), ...collectEspnEntries()];
  if (entries.length === 0) {
    status.textContent = gdSleeperData.length === 0 && !lastEspn
      ? "Load your leagues first, then open this tab."
      : "No starters found for GameDay (matchups haven't loaded yet, or all visible leagues are on bye).";
    wrap.innerHTML = "";
    return;
  }
  // Group by NFL game.
  const groups = new Map(); // gameId -> { game, entries }
  const BYE = "__BYE__";
  for (const e of entries) {
    const gk = gameKeyForEntry(e) || BYE;
    if (!groups.has(gk)) groups.set(gk, { game: gk === BYE ? null : ((gdSchedule && gdSchedule.games) || {})[gk] || null, entries: [] });
    groups.get(gk).entries.push(e);
  }
  // Sort: live first, then scheduled by date, then final, bye last.
  const rank = (g) => {
    if (!g.game) return 99;
    if (g.game.state === "in") return 0;
    if (g.game.state === "pre") return 1;
    return 2;
  };
  const sorted = [...groups.entries()].sort((a, b) => {
    const ra = a[0] === BYE ? 99 : rank(a[1]);
    const rb = b[0] === BYE ? 99 : rank(b[1]);
    if (ra !== rb) return ra - rb;
    const da = a[1].game ? a[1].game.date.getTime() : Infinity;
    const db = b[1].game ? b[1].game.date.getTime() : Infinity;
    return da - db;
  });
  status.textContent = `Week ${weekLabel} · ${entries.length} starters (you + opponents) across ${sorted.length} NFL game group(s). Scores refresh with “Refresh scores”. Half-PPR comparable; per-league live scoring shown.`;

  const gameTitle = (g) => {
    // ESPN returns 0-0 for pre-game scores — suppress until kickoff.
    if (g.state !== "pre" && g.awayScore != null && g.homeScore != null) return `${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}`;
    return `${g.away} @ ${g.home}`;
  };

  // Display rule: game hasn't started → "—" (even if a platform reports 0).
  // Game live/final → numeric, treating missing points as 0.0.
  // No schedule/game info → fall back to API value (null → "—").
  const fptsFor = (e) => {
    const gk = gameKeyForEntry(e);
    const g = gk && gdSchedule && gdSchedule.games ? gdSchedule.games[gk] : null;
    if (g && g.state === "pre") return "—";
    if (g && (g.state === "in" || g.state === "post")) return fmtPts(e.fantasyPts ?? 0);
    return e.fantasyPts != null ? fmtPts(e.fantasyPts) : "—";
  };

  wrap.innerHTML = "";
  for (const [gk, g] of sorted) {
    const game = g.game;
    const mine = g.entries.filter((e) => e.side === "mine");
    const opp = g.entries.filter((e) => e.side === "opp");
    const countLabel = (arr) => {
      const leagues = new Set(arr.map((e) => e.leagueName)).size;
      const p = arr.length === 1 ? "player" : "players";
      const l = leagues === 1 ? "league" : "leagues";
      return `${arr.length} ${p} (${leagues} ${l})`;
    };
    const isLive = game && game.state === "in";
    const stateText = !game ? "No game" : (game.state === "post" ? "Final" : game.state === "in" ? game.detail : game.label);
    const card = document.createElement("div");
    card.className = "gd-game" + (isLive ? " live" : "");
    const rows = [...mine, ...opp]
      .sort((a, b) => (a.side === b.side ? (b.fantasyPts ?? 0) - (a.fantasyPts ?? 0) : a.side === "mine" ? -1 : 1))
      .map((e) => `
        <tr>
          <td><span class="side ${e.side}">${e.side === "mine" ? "ME" : "OPP"}</span></td>
          <td>
            <div class="player-name">${escHtml(e.playerName)}</div>
            <div class="player-sub">${escHtml(e.pos)} · ${escHtml(e.nflTeam || "—")}</div>
          </td>
          <td><span class="league-tag">${escHtml(e.leagueName)}</span><div class="player-sub">${e.platform === "espn" ? "ESPN" : "Sleeper"} · ${escHtml(e.teamLabel)}</div></td>
          <td class="fpts-cell">${fptsFor(e)}</td>
        </tr>`).join("");
    card.innerHTML = `
      <details ${isLive ? "open" : ""}>
        <summary>
          <div class="gd-top">
            <span class="gd-matchup">${game ? escHtml(gameTitle(game)) : "Bye / no game"}</span>
            <span class="gd-state ${isLive ? "live" : ""}">${escHtml(stateText)}${game && game.special && game.state === "pre" ? " 🌙" : ""}</span>
          </div>
          <div class="gd-fpts">
            <span class="mine">My starters: ${countLabel(mine)}</span>
            ${opp.length > 0 ? `<span class="opp">Opp starters: ${countLabel(opp)}</span>` : ""}
            <span class="player-sub">click to ${isLive ? "collapse" : "expand"} · ${g.entries.length} players</span>
          </div>
        </summary>
        <div class="gd-body">
          <table>
            <thead><tr><th>Side</th><th>Player</th><th>League</th><th style="text-align:right">Fpts</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>`;
    wrap.appendChild(card);
  }
}

async function refreshGameday() {
  const status = document.getElementById("gameday-status");
  try {
    if (status) status.textContent = "Refreshing live scores + fantasy points…";
    const week = gdWeek || (lastEspn && lastEspn.week) || 1;
    const season = gdSeason || (lastEspn && lastEspn.season) || new Date().getFullYear();
    // Bypass the getSchedule memory cache so scores actually update.
    scheduleCache = { key: null, data: null };
    const fresh = await getSchedule(season, week, "regular").catch((e) => {
      console.error("GameDay schedule refresh failed", e);
      return gdSchedule;
    });
    if (fresh) {
      gdSchedule = fresh;
      if (lastEspn) lastEspn.schedule = fresh;
    }
    await Promise.all(
      gdSleeperData.map(async (d) => {
        try {
          d.matchups = await fetchJson(`${API}/league/${d.league.league_id}/matchups/${week}`);
        } catch (e) {
          console.warn(`GameDay matchup refresh failed for ${d.league.name}`, e);
        }
      })
    );
    if (lastEspn) {
      try {
        const box = await espnApi(lastEspn.season, lastEspn.leagueId, ["mMatchup", "mBoxscore"], { scoringPeriodId: lastEspn.week });
        if (box && box.schedule) {
          lastEspn.boxscore = box.schedule;
          lastEspn.boxscoreError = "";
        }
      } catch (e) {
        console.warn("GameDay ESPN boxscore refresh failed", e);
        lastEspn.boxscoreError = (e && e.message) || String(e);
      }
      await backfillEspnMatchupItem();
    }
    // Re-render league cards too so game pills pick up fresh times.
    renderGameday();
    if (status && status.textContent.startsWith("Refreshing")) renderGameday();
  } catch (e) {
    console.error("GameDay refresh failed", e);
    if (status) status.textContent = `Refresh failed: ${e.message}`;
  }
}

document.getElementById("gameday-refresh-btn").addEventListener("click", refreshGameday);

const gdGroupInput = document.getElementById("gameday-group-input");
const gdLeagueInput = document.getElementById("gameday-league-input");
if (gdGroupInput) {
  gdGroupInput.value = gdGroupMode;
  gdGroupInput.addEventListener("change", () => {
    gdGroupMode = gdGroupInput.value === "matchup" ? "matchup" : "nfl";
    try { localStorage.setItem("fc_gameday_group", gdGroupMode); } catch (e) {}
    renderGameday();
  });
}
if (gdLeagueInput) {
  gdLeagueInput.addEventListener("change", () => {
    gdMatchupLeagueKey = gdLeagueInput.value;
    try { localStorage.setItem("fc_gameday_matchup_league", gdMatchupLeagueKey); } catch (e) {}
    renderGameday();
  });
}

// Auto-load on open (each fires exactly once via setTimeout).
console.log("[FantasyCast] app.js loaded, scheduling initial loads");
setStatus("Starting… if this never changes, app.js failed to run (hard-refresh Ctrl+Shift+R).");
setTimeout(load, 50);
// ESPN auto-loads too, but only when a league ID was saved from a previous
// visit — otherwise the ESPN panel keeps its "enter a League ID" prompt.
setTimeout(() => {
  try {
    if (/^\d+$/.test(espnLeagueInput.value.trim())) loadEspn();
  } catch (e) {
    console.warn("[FantasyCast] ESPN auto-load skipped", e);
  }
}, 300);
