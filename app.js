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

function gameForTeam(nflTeam, schedule) {
  const t = normTeam(nflTeam);
  if (!t || !schedule || !schedule.map || !schedule.games) return null;
  const m = schedule.map[t];
  if (!m) return null;
  return (m.gameId && schedule.games[m.gameId]) || null;
}

function isGameStarted(nflTeam, schedule) {
  const g = gameForTeam(nflTeam, schedule);
  return !!g && g.state !== "pre";
}

function lockForTeam(nflTeam, schedule) {
  return isGameStarted(nflTeam, schedule)
    ? `<div class="lock" title="Game started — lineup locked">🔒</div>`
    : "";
}

// Slot cell with the lock stacked below the position (not beside it).
// The td also gets a "locked" class so the row can be dimmed via CSS.
function slotCell(label, nflTeam, schedule) {
  const locked = isGameStarted(nflTeam, schedule);
  return `<td class="slot${locked ? " locked" : ""}"><div class="slot-pos">${label}</div>${locked ? lockForTeam(nflTeam, schedule) : ""}</td>`;
}

function lockedRowClass(nflTeam, schedule) {
  return isGameStarted(nflTeam, schedule) ? "locked" : "";
}

function gamePillHtml(nflTeam, schedule) {
  const t = normTeam(nflTeam);
  if (!t) return "";
  if (!schedule || !schedule.map) return "";
  const g = schedule.map[t];
  if (!g) return `<span class="game-pill game-bye" title="No game scheduled this week">Bye</span>`;
  const matchup = g.homeAway === "home" ? `vs ${g.opp}` : `@ ${g.opp}`;
  const game = gameForTeam(t, schedule);
  // Once a game has started, never highlight the standalone window —
  // show live/final detail as a plain pill instead.
  if (game && game.state !== "pre") {
    const detail = game.detail || g.label;
    return `<span class="game-pill" title="${detail}">${matchup} · ${detail}</span>`;
  }
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
    span.textContent = `${it.name} (${it.platform === "espn" ? "ESPN" : it.platform === "yahoo" ? "Yahoo" : "Sleeper"})`;
    label.appendChild(cb);
    label.appendChild(span);
    box.appendChild(label);
  }
  updateLeaguesHeader();
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
// Note: "Shotgun" is just one league's name for the guillotine format,
// so it also displays as guillotine.
function choppedKind(name) {
  const n = String(name || "");
  if (/guillotine|shotgun/i.test(n)) return "guillotine";
  return "chopped";
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtPts(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(1);
}

function updateLeaguesHeader() {
  // Week number + moon legend shown once at the top (not per card).
  const el = document.getElementById("leagues-header");
  if (!el) return;
  const week = gdWeek || (lastEspn && lastEspn.week) || (gdSchedule && gdSchedule.week) || null;
  const hasLeagues = leagueStore.size > 0;
  if (!hasLeagues) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = `${week ? `NFL Week ${week} · ` : ""}🌙 = special window (anything other than Sun 1pm / 4pm ET: Thu, SNF, Mon, Sat, London) · 🔒 = player's NFL game has started (lineup locked)`;
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
  // Non-standard bench spots (IR / Taxi / Reserve) live apart from the bench.
  const nonStandard = new Map(); // pid -> label
  for (const [key, label] of [["taxi", "Taxi"], ["reserve", "Reserve"], ["injured_reserve", "IR"]]) {
    if (Array.isArray(roster[key])) {
      for (const pid of roster[key]) nonStandard.set(String(pid), label);
    }
  }
  const benchAll = benchIds(roster);
  const bench = benchAll.filter((pid) => !nonStandard.has(String(pid)));
  const grouped = new Map(); // label -> [pid]
  for (const pid of benchAll) {
    const label = nonStandard.get(String(pid));
    if (!label) continue;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(pid);
  }

  const playerCell = (d, playerId) => `
    <div class="player-name ${!playerId || playerId === "0" ? "empty" : ""}">${d.name}</div>
    <div class="player-sub">${d.pos} · ${d.team}</div>
    ${d.injury ? `<div class="injury ${d.injury}">${d.injury}</div>` : ""}
    ${gamePillHtml(d.team, schedule)}
  `;

  const starterRows = slots
    .map(({ slot, playerId }) => {
      const d = describePlayer(playerId, players);
      return `<tr class="${lockedRowClass(d.team, schedule)}">
        ${slotCell(slot, d.team, schedule)}
        <td class="player-cell">${playerCell(d, playerId)}</td>
      </tr>`;
    })
    .join("");

  const benchRows =
    bench.length === 0
      ? `<tr><td class="empty">Bench is empty</td></tr>`
      : bench
          .map((pid) => {
            const d = describePlayer(pid, players);
            return `<tr class="${lockedRowClass(d.team, schedule)}">
              ${slotCell(d.pos, d.team, schedule)}
              <td class="player-cell">${playerCell(d, pid)}</td>
            </tr>`;
          })
          .join("");

  const extraSections = [...grouped.entries()]
    .map(([label, ids]) => {
      const rows = ids
        .map((pid) => {
          const d = describePlayer(pid, players);
          return `<tr class="${lockedRowClass(d.team, schedule)}">
            ${slotCell(d.pos, d.team, schedule)}
            <td class="player-cell">${playerCell(d, pid)}</td>
          </tr>`;
        })
        .join("");
      return `<div class="section">
        <h3>${label} (${ids.length})</h3>
        <table><tbody>${rows}</tbody></table>
      </div>`;
    })
    .join("");

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
      </div>
    </div>
    <div class="section">
      <h3>Starting lineup</h3>
      <table><tbody>${starterRows}</tbody></table>
    </div>
    <div class="section">
      <h3>Bench (${bench.length})</h3>
      <table><tbody>${benchRows}</tbody></table>
    </div>
    ${extraSections}
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
    // Q1: ESPN week defaults to the Sleeper week — prefill the input when the
    // user hasn't typed one so Add ESPN league picks it up automatically.
    // Same for the Yahoo manual week (used for week-gating pastes).
    try {
      const espnWeekEl = document.getElementById("espn-week-input");
      if (espnWeekEl && !espnWeekEl.value) {
        espnWeekEl.value = schedWeek;
        espnWeekEl.placeholder = `auto (${schedWeek})`;
      }
      const yahooWeekEl = document.getElementById("yahoo-week-input");
      if (yahooWeekEl && !yahooWeekEl.value) {
        yahooWeekEl.placeholder = `auto (${schedWeek})`;
      }
    } catch (e) {}
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
    updateLeaguesHeader();
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

// ---------------- ESPN fantasy leagues (public leagues only) ----------------
// Public leagues need only the numeric League ID.
// Requests go through the local /api/espn proxy (server.py) when available,
// falling back to a direct reads-host call.
const ESPN_READS = "https://lm-api-reads.fantasy.espn.com";
const ESPN_SLOT_NAMES = { 0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP", 16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BN", 21: "IR", 23: "FLEX" };
const ESPN_SLOT_ORDER = ["QB", "RB", "RB/WR", "WR", "WR/TE", "TE", "FLEX", "OP", "TQB", "DT", "DE", "LB", "DL", "CB", "S", "DB", "DP", "D/ST", "K", "P", "HC"];
const ESPN_PRO_TEAMS = { 0: null, 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };
const ESPN_POSITIONS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

const espnLeagueInput = document.getElementById("espn-league-input");
const espnSeasonInput = document.getElementById("espn-season-input");
const espnWeekInput = document.getElementById("espn-week-input");
const espnTeamInput = document.getElementById("espn-team-input");
const espnLoadBtn = document.getElementById("espn-load-btn");
const espnStatusEl = document.getElementById("espn-status");

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
  // 1) Same-origin proxy (server.py) to avoid browser CORS issues.
  try {
    const res = await fetch(`/api/espn?season=${encodeURIComponent(season)}&leagueId=${encodeURIComponent(leagueId)}&${query}`);
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
  // 2) Direct reads-host call (public leagues).
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    let res, j;
    try {
      res = await fetch(`${ESPN_READS}/apis/v3/games/ffl/seasons/${encodeURIComponent(season)}/segments/0/leagues/${encodeURIComponent(leagueId)}?${query}`, { signal: ctrl.signal });
      j = await res.json();
    } finally {
      clearTimeout(t);
    }
    if (hasEspnData(j)) return j;
    throw new Error(`ESPN rejected the request (HTTP ${res.status}). ${res.status === 401 || res.status === 403 ? "This looks like a private league, which isn't supported. Check League ID / season." : "Check League ID / season."}`);
  } catch (e) {
    console.error("[FantasyCast] ESPN direct failed", e);
    throw proxyError && /Private|league ID/i.test(proxyError.message) ? proxyError : e;
  }
}

function espnOwnerName(team, members) {
  const ownerId = team.owners && team.owners[0];
  if (!ownerId || !Array.isArray(members)) return "";
  const norm = String(ownerId).replace(/[{}]/g, "").toLowerCase();
  const m = members.find((x) => String(x.id || "").replace(/[{}]/g, "").toLowerCase() === norm);
  return m ? (m.displayName || `${m.firstName || ""} ${m.lastName || ""}`.trim()) : "";
}

function renderEspnCard({ leagueId, leagueName, season, week, team, teams, members, schedule }) {
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
    return `<tr class="${lockedRowClass(d.nfl, schedule)}">${slotCell(ESPN_SLOT_NAMES[e.lineupSlotId] || "—", d.nfl, schedule)}<td class="player-cell">${cell(d)}</td></tr>`;
  }).join("") || `<tr><td class="empty">No starters found</td></tr>`;
  const benchRows = bench.length === 0
    ? `<tr><td class="empty">Bench is empty</td></tr>`
    : bench.map((e) => {
        const d = info(e);
        return `<tr class="${lockedRowClass(d.nfl, schedule)}">${slotCell(d.pos, d.nfl, schedule)}<td class="player-cell">${cell(d)}</td></tr>`;
      }).join("");
  const irRows = ir.map((e) => {
    const d = info(e);
    return `<tr class="${lockedRowClass(d.nfl, schedule)}">${slotCell(d.pos, d.nfl, schedule)}<td class="player-cell">${cell(d)}</td></tr>`;
  }).join("");
  const teamOptions = (teams || []).map((t) => {
    const o = espnOwnerName(t, members);
    const label = `${t.name || t.abbrev || `Team ${t.id}`}${o ? ` (${o})` : ""}`;
    const sel = String(t.id) === String(team.id) ? " selected" : "";
    return `<option value="${t.id}"${sel}>${label}</option>`;
  }).join("");
  const card = document.createElement("div");
  card.className = "league-card";
  card.innerHTML = `
    <div class="league-head">
      <h2>${leagueName} <span style="color:var(--muted);font-weight:400;font-size:13px">(ESPN)</span></h2>
      <div class="league-meta">
        <span class="pill">${team.name || team.abbrev || `Team ${team.id}`}${owner ? ` · ${owner}` : ""}</span>
        <span class="pill">Record ${rec.wins ?? 0}-${rec.losses ?? 0}${rec.ties ? `-${rec.ties}` : ""}</span>
        <span class="pill">${season} · ${teams ? teams.length : "?"}-team</span>
      </div>
      <label class="player-sub" style="display:block;margin-top:6px">My team:
        <select class="espn-team-picker controls" data-league="${leagueId}" style="margin-left:6px;max-width:100%">${teamOptions}</select>
      </label>
    </div>
    <div class="section">
      <h3>Starting lineup</h3>
      <table><tbody>${starterRows}</tbody></table>
    </div>
    <div class="section">
      <h3>Bench (${bench.length})</h3>
      <table><tbody>${benchRows}</tbody></table>
    </div>
    ${ir.length ? `<div class="section"><h3>IR (${ir.length})</h3><table><tbody>${irRows}</tbody></table></div>` : ""}
  `;
  return card;
}

// Multiple ESPN leagues: each Add appends to this map (keyed by leagueId).
// lastEspn stays as an alias to the most-recently-loaded entry so week
// headers / GameDay fallbacks keep working with older persisted state.
const espnDataById = new Map();
let lastEspn = null; // most recent entry in espnDataById

function getEspnList() {
  return [...espnDataById.values()];
}

function persistEspnLeagues() {
  try {
    const arr = getEspnList().map((d) => ({ leagueId: d.leagueId, season: d.season, teamId: d.selectedTeamId }));
    localStorage.setItem("espn_leagues", JSON.stringify(arr));
  } catch (e) { /* persistence optional */ }
}

function syncEspnLoadedList() {
  const box = document.getElementById("espn-loaded-list");
  if (!box) return;
  box.innerHTML = "";
  for (const d of getEspnList()) {
    const label = document.createElement("label");
    label.className = "toggle-row";
    const span = document.createElement("span");
    span.textContent = `${d.leagueName} (${d.season} · W${d.week})`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.style.marginLeft = "8px";
    btn.addEventListener("click", () => removeEspnLeague(d.leagueId));
    label.appendChild(span);
    label.appendChild(btn);
    box.appendChild(label);
  }
}

function removeEspnLeague(leagueId) {
  espnDataById.delete(String(leagueId));
  leagueStore.delete(`espn:${leagueId}`);
  if (lastEspn && String(lastEspn.leagueId) === String(leagueId)) {
    const rest = getEspnList();
    lastEspn = rest.length ? rest[rest.length - 1] : null;
  }
  persistEspnLeagues();
  syncEspnLoadedList();
  syncLeagues();
  renderGameday();
  espnStatus(getEspnList().length ? `Removed ${leagueId}. ${getEspnList().length} ESPN league(s) still loaded.` : "No ESPN leagues loaded. Add one above.");
}

function selectedEspnTeam(d) {
  if (!d || !Array.isArray(d.teams) || d.teams.length === 0) return null;
  return d.teams.find((t) => String(t.id) === String(d.selectedTeamId)) || d.teams[0];
}

function renderEspn() {
  if (espnDataById.size === 0) return;
  // Clear stale ESPN cards, then re-render one card per loaded league.
  for (const key of [...leagueStore.keys()]) {
    if (key.startsWith("espn:")) leagueStore.delete(key);
  }
  for (const d of getEspnList()) {
    const team = selectedEspnTeam(d);
    if (!team) continue;
    const card = renderEspnCard({
      leagueId: d.leagueId,
      leagueName: d.leagueName,
      season: d.season,
      week: d.week,
      team,
      teams: d.teams,
      members: d.members,
      schedule: d.schedule,
    });
    tagCard(card, "espn", "ESPN");
    const key = `espn:${d.leagueId}`;
    leagueStore.set(key, { key, platform: "espn", name: d.leagueName, card });
  }
  syncLeagues();
  renderGameday();
}

function resolveEspnWeek(typedWeek, autoWeek) {
  // Q1: week is automatic. Priority: typed input > Sleeper week (gdWeek) >
  // ESPN status currentMatchupPeriod > 1. The input stays blank for auto.
  const typed = parseInt(typedWeek, 10);
  if (typed && typed >= 1) return typed;
  if (gdWeek && gdWeek >= 1) return gdWeek;
  if (autoWeek && autoWeek >= 1) return autoWeek;
  return 1;
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
  } catch (e) { /* incognito browser: persistence optional */ }

  espnStatus(`Contacting ESPN for league ${leagueId}…`);
  console.log("[FantasyCast] ESPN load", { leagueId, season });
  try {
    const st = await espnApi(season, leagueId, ["mStatus"]);
    const autoWeek = st.status && st.status.currentMatchupPeriod;
    const week = resolveEspnWeek(espnWeekInput.value, autoWeek);
    if (!espnWeekInput.value) espnWeekInput.value = week;
    const weekNote = gdWeek && week === gdWeek ? " (from Sleeper week)" : "";
    espnStatus(`Loading week ${week} roster${weekNote}…`);
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

    // Team selection: keep per-league pick when re-adding; otherwise fall
    // back to the global picker / saved team for a familiar single-league UX.
    const existing = espnDataById.get(String(leagueId));
    const prevTeam = (existing && existing.selectedTeamId)
      || espnTeamInput.value
      || (() => { try { return localStorage.getItem("espn_team") || ""; } catch (e) { return ""; } })();
    let selectedTeamId = prevTeam && teams.some((t) => String(t.id) === String(prevTeam))
      ? String(prevTeam)
      : String(teams[0].id);

    // Keep the global "My team" picker populated for single-league users.
    espnTeamInput.innerHTML = "";
    for (const t of teams) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      const owner = espnOwnerName(t, league.members);
      opt.textContent = `${t.name || t.abbrev || `Team ${t.id}`}${owner ? ` (${owner})` : ""}`;
      espnTeamInput.appendChild(opt);
    }
    espnTeamInput.value = selectedTeamId;

    const entry = {
      leagueId: String(leagueId), leagueName, season, week, teams,
      members: league.members || [], schedule: (existing && existing.schedule) || null,
      boxscore: box && box.schedule ? box.schedule : [], boxscoreError: boxErr,
      selectedTeamId,
    };
    espnDataById.set(String(leagueId), entry);
    lastEspn = entry;
    persistEspnLeagues();
    syncEspnLoadedList();
    // If the week-scoped boxscore has no entry for my team, try the
    // full-season schedule to at least identify the opponent.
    await backfillEspnMatchupItem(entry);
    renderEspn();
    espnStatus(`Showing ${leagueName}. Loading game times…`);

    // Reuse the Sleeper schedule when week/season already match (avoids a
    // duplicate ESPN scoreboard fetch); otherwise fetch this league's week.
    let schedule = null;
    if (gdSchedule && Number(gdSchedule.week) === Number(week) && String(gdSeason) === String(season)) {
      schedule = gdSchedule;
    } else {
      schedule = await getSchedule(season, week, "regular").catch((e) => {
        console.error("Schedule fetch failed", e);
        return null;
      });
    }
    entry.schedule = schedule;
    renderEspn();
    renderGameday();
    const total = espnDataById.size;
    espnStatus(`Showing ${total} ESPN league(s) · latest: ${leagueName} · week ${week}${weekNote} (${teams.length} teams).${schedule ? "" : " Game times unavailable."}`);
    try { localStorage.setItem("espn_team", selectedTeamId); } catch (e) {}
  } catch (err) {
    console.error("[FantasyCast] ESPN load failed", err);
    espnStatus(`Error: ${err.message}`, true);
  }
}

espnLoadBtn.addEventListener("click", loadEspn);
espnTeamInput.addEventListener("change", () => {
  // Global picker edits the most-recent league (single-league shortcut);
  // per-card pickers below handle each league individually.
  try { localStorage.setItem("espn_team", espnTeamInput.value); } catch (e) {}
  if (lastEspn && espnDataById.has(String(lastEspn.leagueId))) {
    lastEspn.selectedTeamId = espnTeamInput.value;
    persistEspnLeagues();
  }
  renderEspn();
});

// Per-card team pickers (one per ESPN league card) — event delegation so it
// survives re-renders.
document.addEventListener("change", (e) => {
  const sel = e && e.target && e.target.classList && e.target.classList.contains("espn-team-picker")
    ? e.target
    : null;
  if (!sel) return;
  const lid = sel.getAttribute("data-league");
  const d = espnDataById.get(String(lid));
  if (!d) return;
  d.selectedTeamId = sel.value;
  if (lastEspn && String(lastEspn.leagueId) === String(lid)) lastEspn = d;
  persistEspnLeagues();
  renderEspn();
});

// Prefill saved ESPN settings (league ID stays in this browser only).
// Supports the multi-league list ("espn_leagues") plus the legacy single key.
function loadEspnPersistedIntoInputs() {
  try {
    let list = [];
    try { list = JSON.parse(localStorage.getItem("espn_leagues") || "[]"); } catch (e) { list = []; }
    if (Array.isArray(list) && list.length > 0 && list[0].leagueId) {
      espnLeagueInput.value = list[0].leagueId;
      if (list[0].season) espnSeasonInput.value = list[0].season;
    } else if (localStorage.getItem("espn_league")) {
      espnLeagueInput.value = localStorage.getItem("espn_league");
    }
    if (localStorage.getItem("espn_season")) espnSeasonInput.value = localStorage.getItem("espn_season");
  } catch (e) {}
}
loadEspnPersistedIntoInputs();

async function autoLoadPersistedEspnLeagues() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem("espn_leagues") || "[]"); } catch (e) { list = []; }
  if ((!Array.isArray(list) || list.length === 0)) {
    // Legacy single-league key migration.
    try {
      const single = localStorage.getItem("espn_league");
      if (/^\d+$/.test(single || "")) list = [{ leagueId: single, season: localStorage.getItem("espn_season") || espnSeasonInput.value }];
    } catch (e) {}
  }
  if (!Array.isArray(list) || list.length === 0) return;
  for (const saved of list.slice(0, 5)) {
    if (!saved || !/^\d+$/.test(String(saved.leagueId || ""))) continue;
    espnLeagueInput.value = String(saved.leagueId);
    if (saved.season) espnSeasonInput.value = String(saved.season);
    // Preserve the saved team pick so the right roster shows after reload.
    if (saved.teamId) {
      try { localStorage.setItem("espn_team", String(saved.teamId)); } catch (e) {}
      espnTeamInput.value = String(saved.teamId);
    }
    try {
      await loadEspn();
    } catch (e) {
      console.warn("[FantasyCast] persisted ESPN auto-load failed", saved, e);
    }
  }
  // Leave the input on the most recent league for the next manual Add.
  try {
    const last = list[list.length - 1];
    if (last && last.leagueId) espnLeagueInput.value = String(last.leagueId);
  } catch (e) {}
}

// ---------------- Yahoo manual leagues (paste-only, GameDay only) ----------------
// No OAuth / API: user pastes the Yahoo web matchup table; we parse starters
// (Fan Pts actuals only, projections dropped) and feed GameDay collectors.
// Entries are static snapshots gated on week: a saved Yahoo week only shows
// when it matches the current auto week (Sleeper gdWeek, else ESPN week).
// With no auto week (Yahoo-only), all saved Yahoo leagues show.

// -- Pure parser (no DOM; unit-tested in tests/pure.js) --

function parseYahooNumber(tok) {
  if (tok == null) return null;
  const t = String(tok).trim();
  if (t === "" || t === "-" || t === "—" || t === "–") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Player block looks like "J. BurrowCin - QB" (no space before team),
// "J. Cook IIIBuf - RB", "BroncosDen - DEF", "K. MurrayMin - QB Q".
function parseYahooPlayerBlock(line) {
  if (!line) return null;
  const m = String(line).trim().match(/^(.+?)([A-Z][A-Za-z]{1,2})\s*-\s*(QB|RB|WR|TE|K|DEF)\b\s*(Q|PUP-R|PUP|IR|O|D|SUSP|OUT)?$/);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  const abbr = m[2].toUpperCase();
  const pos = m[3].toUpperCase();
  return {
    playerName: pos === "DEF" ? `${abbr} Defense` : name,
    nfl: normTeam(abbr),
    rawAbbr: abbr,
    pos,
  };
}

function normYahooSlot(t) {
  const u = String(t || "").trim().toUpperCase();
  if (u === "WRT") return "W/R/T";
  return u;
}

function isYahooSlotToken(t) {
  return ["QB", "RB", "WR", "TE", "W/R/T", "WRT", "K", "DEF", "BN", "IR"].includes(
    String(t || "").trim().toUpperCase()
  );
}

function isYahooStarterSlot(t) {
  return ["QB", "RB", "WR", "TE", "W/R/T", "K", "DEF"].includes(normYahooSlot(t));
}

const YAHOO_JUNK_RES = [
  /image-/i, /\.png/i, /players remaining/i, /underdog/i, /favorite/i,
  /orig proj/i, /proj pts/i, /^total$/i, /^note:/i, /stat corrections/i,
  /^stats\s+player/i,
];

// Parse the Yahoo web matchup paste. Columns are mirrored around the center
// Pos slot: left [Proj, Fan], right [Fan, Proj]. Returns starters only
// (BN/IR skipped); projections are dropped — Fan Pts only per spec.
function parseYahooMatchupPaste(text) {
  const warnings = [];
  const left = [];
  const right = [];
  const rawLines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const lines = rawLines.filter((s) => !YAHOO_JUNK_RES.some((re) => re.test(s)));
  const isNumTok = (s) => /^-?\d+\.\d{1,2}$/.test(s) || /^[-—–]$/.test(s);
  for (let i = 0; i < lines.length; i++) {
    if (!isYahooSlotToken(lines[i])) continue;
    const slot = normYahooSlot(lines[i]);
    const starter = isYahooStarterSlot(lines[i]);
    const leftNums = [];
    for (let k = i - 1; k >= 0 && leftNums.length < 2 && i - k <= 8; k--) {
      if (isYahooSlotToken(lines[k])) break;
      if (isNumTok(lines[k])) leftNums.unshift(lines[k]);
    }
    const rightNums = [];
    for (let k = i + 1; k < lines.length && rightNums.length < 2 && k - i <= 8; k++) {
      if (isYahooSlotToken(lines[k])) break;
      if (isNumTok(lines[k])) rightNums.push(lines[k]);
    }
    let leftPlayer = null;
    for (let k = i - 1; k >= 0 && i - k <= 8; k--) {
      if (isYahooSlotToken(lines[k])) break;
      const p = parseYahooPlayerBlock(lines[k]);
      if (p) { leftPlayer = p; break; }
    }
    let rightPlayer = null;
    for (let k = i + 1; k < lines.length && k - i <= 8; k++) {
      if (isYahooSlotToken(lines[k])) break;
      const p = parseYahooPlayerBlock(lines[k]);
      if (p) { rightPlayer = p; break; }
    }
    if (!starter) continue; // BN/IR bench rows: not used by GameDay
    if (!leftPlayer && !rightPlayer) {
      warnings.push(`A "${slot}" row had no parseable players and was skipped.`);
      continue;
    }
    // Left order is [Proj, Fan]; right order is [Fan, Proj]. Keep Fan only.
    const leftFan = leftNums.length >= 2
      ? parseYahooNumber(leftNums[1])
      : leftNums.length === 1 ? parseYahooNumber(leftNums[0]) : null;
    const rightFan = rightNums.length >= 1 ? parseYahooNumber(rightNums[0]) : null;
    if (leftPlayer) {
      left.push({
        slot,
        playerName: leftPlayer.playerName,
        pos: leftPlayer.pos,
        nflTeam: leftPlayer.nfl,
        fantasyPts: leftFan,
      });
    }
    if (rightPlayer) {
      right.push({
        slot,
        playerName: rightPlayer.playerName,
        pos: rightPlayer.pos,
        nflTeam: rightPlayer.nfl,
        fantasyPts: rightFan,
      });
    }
  }
  if (left.length === 0 && right.length === 0) {
    warnings.push("No starters parsed. Paste the Yahoo web matchup table (with the Pos column).");
  }
  if (left.length > 14 || right.length > 14) {
    warnings.push("Unusually many starters — bench rows may have leaked in.");
  }
  if (left.length > 0 && right.length > 0 && Math.abs(left.length - right.length) > 2) {
    warnings.push("Sides have different starter counts; check the paste.");
  }
  return { left, right, warnings };
}

// Header metadata from a full-page Yahoo paste. The league line looks like
// "One league to rule them all (ID# 482639)", each side's team name sits two
// lines above its "W-L-T" record line, week from "Week 1: ...". All fields
// are nullable — a table-only paste yields all nulls and the form values
// (or generic fallbacks) are used instead.
function parseYahooMatchupMeta(text) {
  const out = { leagueName: null, leftTeam: null, rightTeam: null, week: null };
  const head = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  // Only the pre-table header carries our matchup's names; the page footer
  // repeats other matchups, so stop at the first table header row.
  let end = head.findIndex((s) => /^stats\s+player/i.test(s));
  if (end === -1) end = head.length;
  const region = head.slice(0, end);
  for (const s of region) {
    const lm = s.match(/^(.*?)\s*\(ID#\s*\d+\)\s*$/);
    if (lm && lm[1].trim()) { out.leagueName = lm[1].trim(); break; }
  }
  for (const s of region) {
    const wm = s.match(/\bWeek\s+(\d{1,2})\b/);
    if (wm) {
      const w = parseInt(wm[1], 10);
      if (w >= 1) out.week = w;
      break;
    }
  }
  const isRecord = (s) => /^\d+\s*-\s*\d+\s*-\s*\d+$/.test(s);
  const isNameLike = (s) =>
    s.length >= 1 && s.length <= 60 &&
    !/^vs\.?$/i.test(s) && !/^total$/i.test(s) &&
    !/orig proj|proj pts|players remaining|underdog|favorite|matchups/i.test(s) &&
    !/^-?\d+\.\d{1,2}$/.test(s) && !/^[-—–]$/.test(s) &&
    !isYahooSlotToken(s) && !parseYahooPlayerBlock(s);
  const teams = [];
  for (let i = 0; i < region.length; i++) {
    if (!isRecord(region[i]) || i < 2) continue;
    const name = region[i - 2];
    if (isNameLike(name)) teams.push(name);
    if (teams.length === 2) break;
  }
  if (teams[0]) out.leftTeam = teams[0];
  if (teams[1]) out.rightTeam = teams[1];
  return out;
}

// -- Store ( mirrors espnDataById pattern, app.js:760 ) --

const yahooDataById = new Map(); // id -> { id, key, leagueName, week, mySide, myTeamLabel, oppTeamLabel, my, opp }
let lastYahooParse = null; // { left, right, warnings } from the preview step
let lastYahooMeta = null; // { leagueName, leftTeam, rightTeam, week } detected from the paste header

function yahooSlug(s) {
  const slug = String(s || "league").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "league";
}

function getYahooList() {
  return [...yahooDataById.values()];
}

function persistYahooLeagues() {
  try {
    localStorage.setItem("yahoo_leagues", JSON.stringify(getYahooList()));
  } catch (e) { /* persistence optional */ }
}

// Week gate (open Q2): a saved Yahoo week shows only when it matches the
// current auto week. With no auto week (Yahoo-only view), everything shows.
function yahooAutoWeek() {
  if (gdWeek && gdWeek >= 1) return gdWeek;
  const ew = (typeof firstEspnWeek === "function" && firstEspnWeek()) || null;
  if (ew && ew >= 1) return ew;
  return null;
}

function yahooIncludedEntries() {
  const auto = yahooAutoWeek();
  const included = [];
  const skipped = [];
  for (const e of getYahooList()) {
    if (getHiddenLeagues().has(e.key)) continue;
    if (auto != null && Number(e.week) !== Number(auto)) skipped.push(e);
    else included.push(e);
  }
  return { auto, included, skipped };
}

function yahooStatusNote() {
  const { auto, skipped } = yahooIncludedEntries();
  if (auto != null && skipped.length > 0) {
    const names = skipped.map((e) => `"${e.leagueName}" (saved W${e.week})`).join(", ");
    return ` Yahoo hidden for week mismatch (now W${auto}): ${names} — re-paste or change the week.`;
  }
  return "";
}

// -- GameDay collectors ( mirror collectEspnEntriesFor, app.js:1257 ) --

function collectYahooEntries() {
  const out = [];
  for (const e of yahooIncludedEntries().included) {
    const chopped = isChoppedLeague(e.leagueName);
    for (const p of e.my || []) {
      out.push({
        leagueName: e.leagueName, platform: "yahoo", side: "mine",
        teamLabel: e.myTeamLabel, slot: p.slot,
        playerName: p.playerName, pos: p.pos, nflTeam: p.nflTeam,
        fantasyPts: p.fantasyPts,
      });
    }
    if (chopped) continue;
    for (const p of e.opp || []) {
      out.push({
        leagueName: e.leagueName, platform: "yahoo", side: "opp",
        teamLabel: e.oppTeamLabel, slot: p.slot,
        playerName: p.playerName, pos: p.pos, nflTeam: p.nflTeam,
        fantasyPts: p.fantasyPts,
      });
    }
  }
  return out;
}

function buildYahooMatchup(leagueKey, sched) {
  const e = yahooDataById.get(String(leagueKey || "").replace(/^yahoo:/, ""));
  if (!e) return null;
  const toEntry = (p) => ({
    slot: p.slot, playerName: p.playerName, pos: p.pos, nflTeam: p.nflTeam,
    fantasyPts: p.fantasyPts,
    game: matchupGameFor(p.nflTeam, sched),
  });
  const chopped = isChoppedLeague(e.leagueName);
  const my = (e.my || []).map(toEntry);
  const opp = chopped ? [] : (e.opp || []).map(toEntry);
  let oppReason = "ok";
  if (chopped) oppReason = "chopped";
  else if (opp.length === 0) oppReason = "no-matchup";
  return {
    leagueName: e.leagueName, platform: "yahoo",
    myLabel: e.myTeamLabel, oppLabel: chopped ? null : e.oppTeamLabel,
    chopped, my, opp, oppReason,
  };
}

// -- Info card (GameDay-only: no roster detail, just provenance) --

function renderYahooInfoCard(entry) {
  const card = document.createElement("div");
  card.className = "league-card";
  card.innerHTML = `
    <div class="league-head">
      <h2>${escHtml(entry.leagueName)} <span style="color:var(--muted);font-weight:400;font-size:13px">(Yahoo)</span></h2>
      <div class="league-meta">
        <span class="pill">${escHtml(entry.myTeamLabel)} vs ${escHtml(entry.oppTeamLabel)}</span>
        <span class="pill">Week ${escHtml(entry.week)}</span>
        <span class="pill">${(entry.my || []).length + (entry.opp || []).length} starters</span>
      </div>
    </div>
    <div class="section">
      <p class="player-sub" style="margin:0">Manual paste · GameDay only — re-paste to update. Hidden in the Lineups view by design; toggle visibility in Setup → Leagues.</p>
    </div>
  `;
  return card;
}

function renderYahoo() {
  for (const key of [...leagueStore.keys()]) {
    if (key.startsWith("yahoo:")) leagueStore.delete(key);
  }
  for (const e of getYahooList()) {
    const card = renderYahooInfoCard(e);
    tagCard(card, "yahoo", "Yahoo");
    leagueStore.set(e.key, { key: e.key, platform: "yahoo", name: e.leagueName, card });
  }
  syncLeagues();
  renderGameday();
}

// -- Setup-panel UI --

const yahooLeagueInput = document.getElementById("yahoo-league-input");
const yahooWeekInput = document.getElementById("yahoo-week-input");
const yahooSideInput = document.getElementById("yahoo-side-input");
const yahooMyTeamInput = document.getElementById("yahoo-my-team-input");
const yahooOppTeamInput = document.getElementById("yahoo-opp-team-input");
const yahooPasteInput = document.getElementById("yahoo-paste-input");
const yahooParseBtn = document.getElementById("yahoo-parse-btn");
const yahooSaveBtn = document.getElementById("yahoo-save-btn");
const yahooPreviewEl = document.getElementById("yahoo-preview");
const yahooStatusEl = document.getElementById("yahoo-status");

function yahooStatus(msg, isError = false) {
  if (!yahooStatusEl) return;
  yahooStatusEl.textContent = msg;
  yahooStatusEl.classList.toggle("error", isError);
}

function yahooResolveWeek(meta) {
  const typed = parseInt(yahooWeekInput && yahooWeekInput.value, 10);
  if (typed && typed >= 1) return typed;
  if (meta && meta.week && meta.week >= 1) return meta.week;
  if (lastYahooMeta && lastYahooMeta.week && lastYahooMeta.week >= 1) return lastYahooMeta.week;
  const auto = yahooAutoWeek();
  if (auto && auto >= 1) return auto;
  return 1;
}

function renderYahooPreview() {
  if (!yahooPreviewEl) return;
  const p = lastYahooParse;
  if (!p || (p.left.length === 0 && p.right.length === 0)) {
    yahooPreviewEl.innerHTML = "";
    return;
  }
  const rowHtml = (side, r, idx) => `
    <tr data-side="${side}" data-idx="${idx}">
      <td>${side === "left" ? "Left" : "Right"}</td>
      <td>${escHtml(r.slot)}</td>
      <td><input class="yahoo-name" value="${escHtml(r.playerName)}" spellcheck="false" /></td>
      <td class="player-sub">${escHtml(r.pos)}</td>
      <td><input class="yahoo-nfl" value="${escHtml(r.nflTeam || "")}" maxlength="3" spellcheck="false" /></td>
      <td><input class="yahoo-pts" value="${r.fantasyPts != null ? r.fantasyPts : ""}" placeholder="—" inputmode="decimal" /></td>
    </tr>`;
  const rows = [
    ...p.left.map((r, i) => rowHtml("left", r, i)),
    ...p.right.map((r, i) => rowHtml("right", r, i)),
  ].join("");
  const warns = (p.warnings || []).map((w) => `<div class="player-sub">⚠ ${escHtml(w)}</div>`).join("");
  yahooPreviewEl.innerHTML = `
    <div class="player-sub">Preview (editable — fix names/teams/points before saving; projections dropped):</div>
    ${warns}
    <table class="yahoo-preview-table">
      <thead><tr><th>Side</th><th>Slot</th><th>Player</th><th>Pos</th><th>NFL</th><th>Fan</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function readYahooPreview() {
  // Save reads the edited preview table so user fixes land in GameDay.
  if (!yahooPreviewEl || !lastYahooParse) return null;
  const trs = yahooPreviewEl.querySelectorAll
    ? yahooPreviewEl.querySelectorAll("tr[data-side]")
    : [];
  if (!trs || trs.length === 0) return lastYahooParse;
  const getVal = (tr, cls) => {
    const inp = tr.querySelector ? tr.querySelector(`input.${cls}`) : null;
    return inp ? inp.value : "";
  };
  const parsePts = (v) => {
    const t = String(v == null ? "" : v).trim();
    if (t === "" || t === "-" || t === "—") return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  };
  const left = [];
  const right = [];
  const src = lastYahooParse;
  for (const tr of trs) {
    const side = tr.getAttribute ? tr.getAttribute("data-side") : null;
    const idx = parseInt(tr.getAttribute ? tr.getAttribute("data-idx") : "", 10);
    const base = (side === "left" ? src.left : src.right) || [];
    const b = base[idx];
    if (!b) continue;
    const name = String(getVal(tr, "yahoo-name") || "").trim() || b.playerName;
    const nflRaw = String(getVal(tr, "yahoo-nfl") || "").trim().toUpperCase() || b.nflTeam || "";
    const entry = {
      slot: b.slot,
      playerName: name,
      pos: b.pos,
      nflTeam: normTeam(nflRaw) || (nflRaw === "" ? null : b.nflTeam),
      fantasyPts: parsePts(getVal(tr, "yahoo-pts")),
    };
    (side === "left" ? left : right).push(entry);
  }
  return { left, right, warnings: src.warnings || [] };
}

function syncYahooLoadedList() {
  const box = document.getElementById("yahoo-loaded-list");
  if (!box) return;
  box.innerHTML = "";
  for (const d of getYahooList()) {
    const label = document.createElement("label");
    label.className = "toggle-row";
    const span = document.createElement("span");
    span.textContent = `${d.leagueName} (W${d.week} · ${d.myTeamLabel} vs ${d.oppTeamLabel})`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.style.marginLeft = "8px";
    btn.addEventListener("click", () => removeYahooLeague(d.id));
    label.appendChild(span);
    label.appendChild(btn);
    box.appendChild(label);
  }
}

function removeYahooLeague(id) {
  const d = yahooDataById.get(String(id));
  yahooDataById.delete(String(id));
  leagueStore.delete(`yahoo:${String(id)}`);
  persistYahooLeagues();
  syncYahooLoadedList();
  renderYahoo();
  yahooStatus(getYahooList().length
    ? `Removed ${d ? d.leagueName : id}. ${getYahooList().length} Yahoo league(s) still saved.`
    : "No Yahoo leagues saved. Paste one above.");
}

function saveYahooLeague() {
  const paste = (yahooPasteInput && yahooPasteInput.value) || "";
  if (!paste.trim() && !lastYahooParse) {
    yahooStatus("Paste your Yahoo matchup table first, then Parse & preview.", true);
    return;
  }
  if (!lastYahooParse) {
    try {
      lastYahooParse = parseYahooMatchupPaste(paste);
    } catch (e) {
      yahooStatus(`Parse failed: ${e.message}`, true);
      return;
    }
  }
  // Header meta: cached from the Parse step, else detected fresh now.
  // League / team names are optional — detected values, then fallbacks.
  let meta = lastYahooMeta;
  if ((!meta || (!meta.leagueName && !meta.leftTeam && !meta.week)) && paste.trim()) {
    try {
      meta = parseYahooMatchupMeta(paste);
      lastYahooMeta = meta;
    } catch (e) { meta = lastYahooMeta; }
  }
  const leagueName = (yahooLeagueInput && yahooLeagueInput.value.trim())
    || (meta && meta.leagueName)
    || "Yahoo league";
  const edited = readYahooPreview() || lastYahooParse;
  if (edited.left.length === 0 && edited.right.length === 0) {
    yahooStatus(`No starters parsed. ${(edited.warnings || []).join(" ")}`, true);
    renderYahooPreview();
    return;
  }
  const week = yahooResolveWeek(meta);
  const mySide = (yahooSideInput && yahooSideInput.value === "right") ? "right" : "left";
  const metaMy = meta ? (mySide === "left" ? meta.leftTeam : meta.rightTeam) : null;
  const metaOpp = meta ? (mySide === "left" ? meta.rightTeam : meta.leftTeam) : null;
  const myTeamLabel = (yahooMyTeamInput && yahooMyTeamInput.value.trim())
    || metaMy
    || (mySide === "left" ? "Left team" : "Right team");
  const oppTeamLabel = (yahooOppTeamInput && yahooOppTeamInput.value.trim())
    || metaOpp
    || (mySide === "left" ? "Right team" : "Left team");
  const my = (mySide === "left" ? edited.left : edited.right).map((r) => ({ ...r }));
  const opp = (mySide === "left" ? edited.right : edited.left).map((r) => ({ ...r }));
  const id = `${yahooSlug(leagueName)}-w${week}`;
  const entry = {
    id, key: `yahoo:${id}`,
    leagueName, week, mySide, myTeamLabel, oppTeamLabel, my, opp,
  };
  yahooDataById.set(id, entry);
  persistYahooLeagues();
  syncYahooLoadedList();
  renderYahoo();
  const { auto } = yahooIncludedEntries();
  const gated = auto != null && Number(week) !== Number(auto);
  yahooStatus(gated
    ? `Saved "${leagueName}" for W${week}, but the current week is W${auto} — hidden until weeks match.${yahooStatusNote()}`
    : `Saved "${leagueName}" (W${week}): ${my.length}+${opp.length} starters → GameDay.${yahooStatusNote()}`);
}

function loadYahooPersisted() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem("yahoo_leagues") || "[]"); } catch (e) { list = []; }
  if (!Array.isArray(list) || list.length === 0) return;
  for (const e of list.slice(0, 10)) {
    if (!e || !e.leagueName || !Array.isArray(e.my)) continue;
    const week = parseInt(e.week, 10) || 1;
    const id = e.id || `${yahooSlug(e.leagueName)}-w${week}`;
    yahooDataById.set(String(id), {
      id: String(id), key: `yahoo:${id}`,
      leagueName: String(e.leagueName), week,
      mySide: e.mySide === "right" ? "right" : "left",
      myTeamLabel: String(e.myTeamLabel || "My team"),
      oppTeamLabel: String(e.oppTeamLabel || "Opponent"),
      my: e.my, opp: Array.isArray(e.opp) ? e.opp : [],
    });
  }
  // Leave the league-name input on the most recent entry for re-pasting.
  try {
    const last = getYahooList()[getYahooList().length - 1];
    if (last && yahooLeagueInput && !yahooLeagueInput.value) yahooLeagueInput.value = last.leagueName;
    if (last && yahooWeekInput && !yahooWeekInput.value) yahooWeekInput.value = last.week;
  } catch (e) {}
  syncYahooLoadedList();
  renderYahoo();
}

if (yahooParseBtn) {
  yahooParseBtn.addEventListener("click", () => {
    const paste = (yahooPasteInput && yahooPasteInput.value) || "";
    if (!paste.trim()) {
      yahooStatus("Paste your Yahoo matchup table first.", true);
      return;
    }
    try {
      lastYahooParse = parseYahooMatchupPaste(paste);
      lastYahooMeta = parseYahooMatchupMeta(paste);
    } catch (e) {
      yahooStatus(`Parse failed: ${e.message}`, true);
      return;
    }
    // Autofill blank fields from the detected header (typed values win).
    try {
      const sideNow = (yahooSideInput && yahooSideInput.value === "right") ? "right" : "left";
      if (lastYahooMeta) {
        if (yahooLeagueInput && !yahooLeagueInput.value.trim() && lastYahooMeta.leagueName) {
          yahooLeagueInput.value = lastYahooMeta.leagueName;
        }
        if (yahooWeekInput && !yahooWeekInput.value && lastYahooMeta.week) {
          yahooWeekInput.value = lastYahooMeta.week;
        }
        const myName = sideNow === "left" ? lastYahooMeta.leftTeam : lastYahooMeta.rightTeam;
        const oppName = sideNow === "left" ? lastYahooMeta.rightTeam : lastYahooMeta.leftTeam;
        if (yahooMyTeamInput && !yahooMyTeamInput.value.trim() && myName) yahooMyTeamInput.value = myName;
        if (yahooOppTeamInput && !yahooOppTeamInput.value.trim() && oppName) yahooOppTeamInput.value = oppName;
      }
    } catch (e) {}
    renderYahooPreview();
    const n = lastYahooParse.left.length + lastYahooParse.right.length;
    const warns = (lastYahooParse.warnings || []).join(" ");
    const detected = lastYahooMeta && (lastYahooMeta.leagueName || lastYahooMeta.leftTeam)
      ? ` Detected: ${lastYahooMeta.leagueName || "league"}${lastYahooMeta.leftTeam ? ` (${lastYahooMeta.leftTeam} vs ${lastYahooMeta.rightTeam || "?"})` : ""}${lastYahooMeta.week ? ` W${lastYahooMeta.week}` : ""}.`
      : "";
    yahooStatus(n > 0
      ? `Parsed ${lastYahooParse.left.length}+${lastYahooParse.right.length} starters.${detected} Check the preview, fix anything, then Save. ${warns}`
      : `No starters parsed. ${warns}`, n === 0);
  });
}

if (yahooSaveBtn) {
  yahooSaveBtn.addEventListener("click", saveYahooLeague);
}

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
async function backfillEspnMatchupItem(entry) {
  const target = entry || lastEspn;
  if (!target || !Array.isArray(target.teams) || target.teams.length === 0) return false;
  const myId = String(target.selectedTeamId || (target.teams[0] && target.teams[0].id));
  if (findEspnBoxItem(target.boxscore, myId, target.week)) return false;
  try {
    const full = await espnApi(target.season, target.leagueId, ["mMatchup"]);
    const sched = full && full.schedule;
    if (!Array.isArray(sched) || sched.length === 0) return false;
    const containsMe = (s) => {
      const [h, a] = espnSchedIds(s);
      return h === myId || a === myId;
    };
    const hit = sched.find((s) => Number(s.matchupPeriodId) === Number(target.week) && containsMe(s))
      || sched.find(containsMe);
    if (!hit) {
      const summarize = (list) => (list || []).slice(0, 8).map((s) => {
        const [h, a] = espnSchedIds(s);
        return { mp: s.matchupPeriodId, h, a };
      });
      console.warn("[FantasyCast] ESPN matchup debug: my team in no schedule entry", {
        leagueId: target.leagueId,
        myTeamId: myId,
        myTeamIdType: typeof myId,
        week: target.week,
        season: target.season,
        leagueTeamIds: (target.teams || []).map((t) => t.id),
        weekBoxscoreEntries: summarize(target.boxscore),
        weekBoxscoreCount: (target.boxscore || []).length,
        seasonEntriesSample: summarize(sched),
        seasonEntriesCount: sched.length,
        firstSeasonEntryKeys: sched[0] ? Object.keys(sched[0]) : [],
      });
      return false;
    }
    target.boxscore = [...(target.boxscore || []), hit];
    console.log("[FantasyCast] ESPN backfill: opponent identified from season schedule", target.leagueId);
    return true;
  } catch (e) {
    console.warn("[FantasyCast] ESPN full-season matchup backfill failed", e);
    return false;
  }
}

async function backfillAllEspn() {
  for (const d of getEspnList()) {
    await backfillEspnMatchupItem(d);
  }
}

function collectEspnEntriesFor(d) {
  const out = [];
  if (!d || !Array.isArray(d.teams) || d.teams.length === 0) return out;
  if (getHiddenLeagues().has(`espn:${d.leagueId}`)) return out;
  const chopped = isChoppedLeague(d.leagueName); // include my starters, just no opponents
  const myTeam = selectedEspnTeam(d);
  if (!myTeam) return out;
  const myId = String(myTeam.id);
  const leagueName = d.leagueName;
  const boxList = Array.isArray(d.boxscore) ? d.boxscore : [];
  const item = findEspnBoxItem(boxList, myTeam.id, d.week);
  const [itemHomeId, itemAwayId] = espnSchedIds(item);
  const isHome = item && itemHomeId === String(myTeam.id);
  const myBox = item ? (isHome ? item.home : item.away) : null;
  const oppBox = item ? (isHome ? item.away : item.home) : null;
  const oppTeamId = item ? (isHome ? itemAwayId : itemHomeId) : null;
  const oppTeam = (d.teams || []).find((t) => String(t.id) === String(oppTeamId));
  const isStarter = (e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21;
  if (myBox && myBox.rosterForCurrentScoringPeriod) {
    for (const e of (myBox.rosterForCurrentScoringPeriod.entries || []).filter(isStarter).sort(espnStarterSort)) {
      const info = espnEntryInfo(e);
      out.push({
        leagueName, platform: "espn", side: "mine",
        teamLabel: myTeam.name || `Team ${myTeam.id}`,
        slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
        playerName: info.name, pos: info.pos, nflTeam: info.nfl, fantasyPts: info.pts,
      });
    }
  } else {
    // Fallback to roster view (no live points yet).
    for (const e of ((myTeam.roster && myTeam.roster.entries) || []).filter(isStarter).sort(espnStarterSort)) {
      const info = espnEntryInfo(e);
      out.push({
        leagueName, platform: "espn", side: "mine",
        teamLabel: myTeam.name || `Team ${myTeam.id}`,
        slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
        playerName: info.name, pos: info.pos, nflTeam: info.nfl, fantasyPts: null,
      });
    }
  }
  if (!chopped) {
    const oppLabel = (oppTeam && oppTeam.name) || (oppTeamId ? `Team ${oppTeamId}` : "Opponent");
    if (oppBox && oppBox.rosterForCurrentScoringPeriod) {
      for (const e of (oppBox.rosterForCurrentScoringPeriod.entries || []).filter(isStarter).sort(espnStarterSort)) {
        const info = espnEntryInfo(e);
        out.push({
          leagueName, platform: "espn", side: "opp",
          teamLabel: oppLabel,
          slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
          playerName: info.name, pos: info.pos, nflTeam: info.nfl, fantasyPts: info.pts,
        });
      }
    } else if (oppTeam && oppTeam.roster && Array.isArray(oppTeam.roster.entries)) {
      // Boxscore missing (not yet live / fetch failed): fall back to the
      // opponent's roster starters so the matchup still shows both sides.
      for (const e of oppTeam.roster.entries.filter(isStarter).sort(espnStarterSort)) {
        const info = espnEntryInfo(e);
        out.push({
          leagueName, platform: "espn", side: "opp",
          teamLabel: oppLabel,
          slot: ESPN_SLOT_NAMES[e.lineupSlotId] || "—",
          playerName: info.name, pos: info.pos, nflTeam: info.nfl, fantasyPts: null,
        });
      }
    }
  }
  return out;
}

function collectEspnEntries() {
  const out = [];
  for (const d of getEspnList()) {
    out.push(...collectEspnEntriesFor(d));
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
    el.textContent = `${o.name} (${o.platform === "espn" ? "ESPN" : o.platform === "yahoo" ? "Yahoo" : "Sleeper"})`;
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
  const lid = String(leagueKey || "").replace(/^espn:/, "");
  const d = espnDataById.get(lid) || (lastEspn && String(lastEspn.leagueId) === lid ? lastEspn : null);
  if (!d) return null;
  if (!Array.isArray(d.teams) || d.teams.length === 0) return null;
  const leagueName = d.leagueName;
  const chopped = isChoppedLeague(d.leagueName);
  const myTeam = selectedEspnTeam(d);
  if (!myTeam) return null;
  const boxList = Array.isArray(d.boxscore) ? d.boxscore : [];
  const item = findEspnBoxItem(boxList, myTeam.id, d.week);
  const [itemHomeId, itemAwayId] = espnSchedIds(item);
  const isHome = item && itemHomeId === String(myTeam.id);
  const myBox = item ? (isHome ? item.home : item.away) : null;
  const oppBox = item ? (isHome ? item.away : item.home) : null;
  const oppTeamId = item ? (isHome ? itemAwayId : itemHomeId) : null;
  const oppTeam = (d.teams || []).find((t) => String(t.id) === String(oppTeamId));
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
  else if (!item) oppReason = (boxList.length === 0 ? (d.boxscoreError ? "boxscore-error" : "boxscore-empty") : "no-matchup");
  else oppReason = "no-opp-starters";
  return { leagueName, platform: "espn", myLabel: myTeam.name || `Team ${myTeam.id}`, oppLabel, chopped, my, opp, oppReason };
}

function buildMatchupData(leagueKey, sched) {
  if (!leagueKey) return null;
  if (leagueKey.startsWith("sleeper:")) return buildSleeperMatchup(leagueKey, sched);
  if (leagueKey.startsWith("espn:")) return buildEspnMatchup(leagueKey, sched);
  if (leagueKey.startsWith("yahoo:")) return buildYahooMatchup(leagueKey, sched);
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
        return "opponent unavailable (ESPN matchup data failed to load — hit Refresh scores)";
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
  status.textContent = `Week ${weekLabel} · ${m.leagueName} (${m.platform === "espn" ? "ESPN" : m.platform === "yahoo" ? "Yahoo (manual)" : "Sleeper"}) · ${m.myLabel} ${fmtPts(myPts)} vs ${oppNote}.${m.platform === "yahoo" ? " Manual paste — re-paste to update." : ""}${yahooStatusNote()}`;
  if (!hasOpp && !m.chopped) {
    // Dedupe: renders happen often (toggles, refreshes); log once per cause.
    const warnKey = `${gdMatchupLeagueKey}|${weekLabel}|${m.oppReason}`;
    if (warnKey !== lastOppWarnKey) {
      lastOppWarnKey = warnKey;
      const espnDbg = gdMatchupLeagueKey.startsWith("espn:")
        ? espnDataById.get(gdMatchupLeagueKey.replace(/^espn:/, ""))
        : null;
      console.warn("[FantasyCast] matchup opponent missing", {
        league: m.leagueName, platform: m.platform, reason: m.oppReason,
        week: weekLabel, boxscoreEntries: espnDbg && espnDbg.boxscore ? espnDbg.boxscore.length : null,
        boxscoreError: (espnDbg && espnDbg.boxscoreError) || null,
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

function firstEspnSchedule() {
  for (const d of getEspnList()) {
    if (d.schedule) return d.schedule;
  }
  return null;
}

function firstEspnWeek() {
  if (lastEspn && lastEspn.week) return lastEspn.week;
  for (const d of getEspnList()) {
    if (d.week) return d.week;
  }
  return null;
}

function renderGameday() {
  const wrap = document.getElementById("gameday");
  const status = document.getElementById("gameday-status");
  if (!wrap || !status) return;
  // Runs on every render so the League picker hides/shows with the mode
  // no matter which path (tab switch, toggle, refresh) got us here.
  syncGamedayLeaguePicker();
  const sched = gdSchedule || firstEspnSchedule() || null;
  if (sched && !gdSchedule) gdSchedule = sched;
  const weekLabel = gdWeek || firstEspnWeek() || "—";
  if (gdGroupMode === "matchup") {
    renderGamedayMatchup(wrap, status, gdSchedule, weekLabel);
    return;
  }
  const entries = [...collectSleeperEntries(), ...collectEspnEntries(), ...collectYahooEntries()];
  if (entries.length === 0) {
    status.textContent = gdSleeperData.length === 0 && espnDataById.size === 0 && yahooDataById.size === 0
      ? "Load your leagues first, then open this tab."
      : "No starters found for GameDay (matchups haven't loaded yet, all visible leagues are on bye, or saved Yahoo weeks don't match the current week).";
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
  status.textContent = `Week ${weekLabel} · ${entries.length} starters (you + opponents) across ${sorted.length} NFL games. Scores refresh with “Refresh scores”. Half-PPR comparable; per-league live scoring shown.${yahooStatusNote()}`;

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
          <td><span class="league-tag">${escHtml(e.leagueName)}</span><div class="player-sub">${e.platform === "espn" ? "ESPN" : e.platform === "yahoo" ? "Yahoo" : "Sleeper"} · ${escHtml(e.teamLabel)}</div></td>
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
    const week = gdWeek || firstEspnWeek() || 1;
    const season = gdSeason || (lastEspn && lastEspn.season) || new Date().getFullYear();
    // Bypass the getSchedule memory cache so scores actually update.
    scheduleCache = { key: null, data: null };
    const fresh = await getSchedule(season, week, "regular").catch((e) => {
      console.error("GameDay schedule refresh failed", e);
      return gdSchedule;
    });
    if (fresh) {
      gdSchedule = fresh;
      for (const d of getEspnList()) d.schedule = fresh;
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
    for (const d of getEspnList()) {
      try {
        const box = await espnApi(d.season, d.leagueId, ["mMatchup", "mBoxscore"], { scoringPeriodId: d.week });
        if (box && box.schedule) {
          d.boxscore = box.schedule;
          d.boxscoreError = "";
        }
      } catch (e) {
        console.warn(`GameDay ESPN boxscore refresh failed for ${d.leagueName}`, e);
        d.boxscoreError = (e && e.message) || String(e);
      }
      await backfillEspnMatchupItem(d);
    }
    // Re-render league cards too so game pills pick up fresh times.
    renderEspn();
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
// ESPN auto-loads too, but only when league ID(s) were saved from a previous
// visit — otherwise the ESPN panel keeps its "enter a League ID" prompt.
setTimeout(() => {
  autoLoadPersistedEspnLeagues().catch((e) => {
    console.warn("[FantasyCast] ESPN auto-load skipped", e);
  });
}, 300);
// Yahoo manual leagues restore synchronously (localStorage only, no fetch).
setTimeout(() => {
  try {
    loadYahooPersisted();
  } catch (e) {
    console.warn("[FantasyCast] Yahoo auto-load skipped", e);
  }
}, 300);
