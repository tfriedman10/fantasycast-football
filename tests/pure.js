// FantasyCast offline unit + UX-eval tests (node stdlib only, no network).
//
// Loads app.js in a vm with minimal browser stubs (document/localStorage/
// window/setTimeout/fetch) so top-level DOM wiring runs harmlessly, then
// asserts pure functions + rendered-HTML behaviour against fixtures.
//
// Run: node tests/pure.js   (also invoked by tests/smoke.py)
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");

// ---------- minimal browser stubs (top-level app.js wiring must no-op) ----------
function makeEl() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    className: "",
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    appendChild() {},
    querySelector() { return null; },
    setAttribute() {},
  };
}

const memStore = {};
const sandbox = {
  console,
  // browser globals app.js touches at load time
  document: {
    getElementById() { return makeEl(); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    createElement() { return makeEl(); },
  },
  window: { addEventListener() {} },
  localStorage: {
    getItem(k) { return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null; },
    setItem(k, v) { memStore[k] = String(v); },
    removeItem(k) { delete memStore[k]; },
  },
  // never fire timers / network in tests
  setTimeout() { return 0; },
  clearTimeout() {},
  fetch() { throw new Error("network disabled in tests"); },
  // pass through host globals the vm context does not provide itself
  AbortController,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
};
sandbox.globalThis = sandbox;
sandbox.window.localStorage = sandbox.localStorage;
vm.createContext(sandbox);

const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
vm.runInContext(src, sandbox, { filename: "app.js" });

// Evaluate an expression in the app context and return the value to the host.
function app(expr) {
  return vm.runInContext(expr, sandbox);
}

// Arrays/objects from the vm realm have a different Array prototype, so host
// deepStrictEqual rejects them. JSON-round-trip for structural comparisons.
function appJson(expr) {
  return JSON.parse(JSON.stringify(vm.runInContext(expr, sandbox)));
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// ================= 1. pure-function units =================

check("normTeam maps WAS/WSH, JAX/JAC, LAR/LA", () => {
  assert.strictEqual(app(`normTeam("WSH")`), "WAS");
  assert.strictEqual(app(`normTeam("WAS")`), "WAS");
  assert.strictEqual(app(`normTeam("JAC")`), "JAX");
  assert.strictEqual(app(`normTeam("LA")`), "LAR");
  assert.strictEqual(app(`normTeam("FA")`), null);
  assert.strictEqual(app(`normTeam("—")`), null);
  assert.strictEqual(app(`normTeam("dal")`), "DAL");
});

check("describePlayer: empty, defense, unknown, mapped", () => {
  assert.strictEqual(app(`describePlayer("0", {}).name`), "Empty");
  assert.strictEqual(app(`describePlayer("DEN", {}).pos`), "DEF");
  assert.ok(app(`describePlayer("99999", {}).name`).startsWith("Unknown"));
  const players = { 1: { full_name: "Test Player", team: "KC", position: "QB", injury_status: "" } };
  sandbox.__p = players;
  assert.strictEqual(vm.runInContext(`describePlayer(1, __p).name`, sandbox), "Test Player");
  delete sandbox.__p;
});

check("starterSlots skips BN, benchIds excludes starters", () => {
  const league = { roster_positions: ["QB", "RB", "WR", "BN", "BN"] };
  const roster = { starters: ["a", "b", "c"], players: ["a", "b", "c", "d"] };
  sandbox.__l = league; sandbox.__r = roster;
  const slots = appJson(`starterSlots(__l, __r)`);
  assert.deepStrictEqual(slots.map((s) => s.slot), ["QB", "RB", "WR"]);
  const bench = appJson(`benchIds(__r)`);
  assert.deepStrictEqual(bench, ["d"]);
  delete sandbox.__l; delete sandbox.__r;
});

check("escHtml / fmtPts", () => {
  assert.strictEqual(app(`escHtml('<b>&"\\'')`), "&lt;b&gt;&amp;&quot;&#39;");
  assert.strictEqual(app(`fmtPts(10)`), "10.0");
  assert.strictEqual(app(`fmtPts(null)`), "—");
  assert.strictEqual(app(`fmtPts("x")`), "—");
});

check("resolveEspnWeek: typed > Sleeper week > auto > 1", () => {
  vm.runInContext(`gdWeek = null`, sandbox);
  assert.strictEqual(app(`resolveEspnWeek("7", 3)`), 7);
  vm.runInContext(`gdWeek = 5`, sandbox);
  assert.strictEqual(app(`resolveEspnWeek("", 3)`), 5);
  vm.runInContext(`gdWeek = null`, sandbox);
  assert.strictEqual(app(`resolveEspnWeek("", 3)`), 3);
  assert.strictEqual(app(`resolveEspnWeek("", null)`), 1);
});

check("espn slot rank + starter sort (QB before RB before FLEX, ties by name)", () => {
  assert.ok(app(`espnSlotRank(0)`) < app(`espnSlotRank(2)`));
  assert.ok(app(`espnSlotRank(2)`) < app(`espnSlotRank(23)`));
  sandbox.__mk = (slot, name) => ({ lineupSlotId: slot, playerPoolEntry: { player: { fullName: name } } });
  const sorted = appJson(
    `[__mk(23,"Zed"),__mk(2,"B"),__mk(0,"A"),__mk(2,"A2")].sort(espnStarterSort).map(e=>e.playerPoolEntry.player.fullName)`
  );
  assert.deepStrictEqual(sorted, ["A", "A2", "B", "Zed"]);
  delete sandbox.__mk;
});

check("espnSchedIds accepts both schedule shapes", () => {
  sandbox.__s1 = { home: { teamId: 1 }, away: { teamId: 2 } };
  sandbox.__s2 = { homeTeamId: 3, awayTeamId: 4 };
  assert.deepStrictEqual(appJson(`espnSchedIds(__s1)`), ["1", "2"]);
  assert.deepStrictEqual(appJson(`espnSchedIds(__s2)`), ["3", "4"]);
  assert.deepStrictEqual(appJson(`espnSchedIds(null)`), [null, null]);
  delete sandbox.__s1; delete sandbox.__s2;
});

check("findEspnBoxItem prefers exact week, falls back to any entry with my team", () => {
  sandbox.__box = [
    { matchupPeriodId: 2, home: { teamId: 9 }, away: { teamId: 10 } },
    { matchupPeriodId: 1, home: { teamId: 5 }, away: { teamId: 6 } },
  ];
  assert.strictEqual(vm.runInContext(`findEspnBoxItem(__box, 5, 9).matchupPeriodId`, sandbox), 1);
  assert.strictEqual(vm.runInContext(`findEspnBoxItem(__box, 5, 1).matchupPeriodId`, sandbox), 1);
  assert.strictEqual(vm.runInContext(`findEspnBoxItem(__box, 99, 1)`, sandbox), null);
  assert.strictEqual(app(`findEspnBoxItem([], 5, 1)`), null);
  delete sandbox.__box;
});

check("clock/minutes/game-line math", () => {
  assert.strictEqual(app(`parseClockToMins("7:30")`), 7.5);
  assert.strictEqual(app(`parseClockToMins("bad")`), null);
  assert.strictEqual(app(`minutesRemainingForGame({state:"pre"})`), 60);
  assert.strictEqual(app(`minutesRemainingForGame({state:"post"})`), 0);
  assert.strictEqual(app(`minutesRemainingForGame({state:"in", detail:"Halftime", clock:"", period:2})`), 30);
  // Q3 7:30 left -> (4-3)*15 + 7.5 = 22.5
  assert.strictEqual(app(`minutesRemainingForGame({state:"in", detail:"3rd", clock:"7:30", period:3})`), 22.5);
  assert.ok(app(`gameLineFor(null)`).includes("Bye"));
  assert.ok(app(`gameLineFor({state:"pre", away:"DAL", home:"PHI", label:"Sun 1pm"})`).includes("DAL @ PHI"));
  assert.ok(
    app(`gameLineFor({state:"post", away:"DAL", home:"PHI", awayScore:20, homeScore:17})`).includes("Final")
  );
});

check("matchup countable/display points: pre-kickoff shows — and counts 0", () => {
  sandbox.__pre = { game: { state: "pre" }, fantasyPts: 10 };
  sandbox.__live = { game: { state: "in" }, fantasyPts: 10 };
  assert.strictEqual(vm.runInContext(`matchupCountablePts(__pre)`, sandbox), 0);
  assert.strictEqual(vm.runInContext(`matchupCountablePts(__live)`, sandbox), 10);
  assert.strictEqual(vm.runInContext(`matchupDisplayPts(__pre)`, sandbox), "—");
  assert.strictEqual(vm.runInContext(`matchupDisplayPts(__live)`, sandbox), "10.0");
  delete sandbox.__pre; delete sandbox.__live;
});

check("chopped/guillotine detection", () => {
  assert.strictEqual(app(`isChoppedLeague("Shotgun League")`), true);
  assert.strictEqual(app(`isChoppedLeague("Guillotine Masters")`), true);
  assert.strictEqual(app(`isChoppedLeague("Family Dynasty")`), false);
  assert.strictEqual(app(`choppedKind("Shotgun League")`), "guillotine");
});

check("parseYahooPlayerBlock: fused name+team, DEF, junk", () => {
  sandbox.__yp1 = "J. BurrowCin - QB";
  sandbox.__yp2 = "BroncosDen - DEF";
  sandbox.__yp3 = "S. DiggsWas - WR";
  sandbox.__yp4 = "Final (W) 33-27 vs TB";
  assert.deepStrictEqual(appJson(`parseYahooPlayerBlock(__yp1)`),
    { playerName: "J. Burrow", nfl: "CIN", rawAbbr: "CIN", pos: "QB" });
  assert.deepStrictEqual(appJson(`parseYahooPlayerBlock(__yp2)`),
    { playerName: "DEN Defense", nfl: "DEN", rawAbbr: "DEN", pos: "DEF" });
  assert.deepStrictEqual(appJson(`parseYahooPlayerBlock(__yp3)`),
    { playerName: "S. Diggs", nfl: "WAS", rawAbbr: "WAS", pos: "WR" });
  assert.strictEqual(vm.runInContext(`parseYahooPlayerBlock(__yp4)`, sandbox), null);
  delete sandbox.__yp1; delete sandbox.__yp2; delete sandbox.__yp3; delete sandbox.__yp4;
});

check("parseYahooMatchupPaste: mirrored cols, dash nulls, DEF, BN skip", () => {
  sandbox.__yp = [
    "Tyler's Tip-Top Team",
    "0 - 0 - 0",
    "77.86",
    "vs.",
    "118.86",
    "Don't call it a comeback",
    "Stats\tPlayer\tProj\tFan Pts\tPos\tFan Pts\tProj\tPlayer\tStats",
    "254 Pass Yds, 1 Pass TD, 1 Int, 20 Rush Yds",
    "J. BurrowCin - QB",
    "Final (W) 33-27 vs TB",
    "20.30",
    "14.16",
    "QB",
    "35.66",
    "19.27",
    "J. AllenBuf - QB",
    "Final (W) 36-31 @ HOU",
    "334 Pass Yds, 2 Pass TD, 23 Rush Yds, 2 Rush TD",
    "15 Rush Yds, 2 Rec, 6 Rec Yds",
    "R. DowdlePit - RB",
    "Final (W) 20-13 vs ATL",
    "11.04",
    "3.10",
    "RB",
    "-",
    "13.21",
    "K. WalkerKC - RB",
    "Mon 8:15 PM vs DEN",
    "43 Rush Yds, 1 Rush TD, 1 Fum Lost",
    "O. HamptonLAC - RB",
    "Final (L) 14-26 vs ARI",
    "14.30",
    "8.30",
    "W/R/T",
    "27.40",
    "12.07",
    "D. MontgomeryHou - RB",
    "Final (L) 31-36 vs BUF",
    "60 Rush Yds, 2 Rush TD, 3 Rec, 19 Rec Yds, 1 Rec TD",
    "1 Sack, 1 Blk Kick, PA 21-27",
    "BroncosDen - DEF",
    "Mon 8:15 PM @ KC",
    "6.63",
    "-",
    "DEF",
    "3.00",
    "7.33",
    "EaglesPhi - DEF",
    "Final (W) 24-22 vs WAS",
    "1 Sack, 1 Blk Kick, PA 21-27",
    "54 Rush Yds",
    "B. CorumLAR - RB",
    "Final (L) 7-27 vs SF",
    "8.35",
    "5.40",
    "BN",
    "0.00",
    "9.30",
    "J. AddisonMin - WR",
    "Final (W) 39-22 vs GB",
    "15 Rush Yds, 1 Rec, 3 Rec Yds",
  ].join("\n");
  const res = appJson(`parseYahooMatchupPaste(__yp)`);
  assert.strictEqual(res.left.length, 4, `left was ${JSON.stringify(res.left)}`);
  assert.strictEqual(res.right.length, 4, `right was ${JSON.stringify(res.right)}`);
  assert.deepStrictEqual(res.left[0], { slot: "QB", playerName: "J. Burrow", pos: "QB", nflTeam: "CIN", fantasyPts: 14.16 });
  assert.deepStrictEqual(res.right[0], { slot: "QB", playerName: "J. Allen", pos: "QB", nflTeam: "BUF", fantasyPts: 35.66 });
  // Pre-game dash → null actuals (proj dropped).
  assert.strictEqual(res.right[1].playerName, "K. Walker");
  assert.strictEqual(res.right[1].fantasyPts, null);
  // DEF naming matches describePlayer convention; W/R/T slot kept.
  assert.deepStrictEqual(res.left[3], { slot: "DEF", playerName: "DEN Defense", pos: "DEF", nflTeam: "DEN", fantasyPts: null });
  assert.strictEqual(res.left[2].slot, "W/R/T");
  // BN rows skipped entirely.
  assert.ok(!res.left.some((r) => r.playerName === "B. Corum"), "bench leaked into left");
  assert.ok(!res.right.some((r) => r.playerName === "J. Addison"), "bench leaked into right");
  delete sandbox.__yp;
});

check("parseYahooMatchupMeta: league, teams, week; footer ignored", () => {
  sandbox.__ym = [
    "Fantasy Football",
    "One league to rule them all (ID# 482639)",
    "Yahoo Sports Fantasy Football",
    "Week 1: Sep 9 - Sep 14",
    "Tyler's Tip-Top Team",
    "Tyler",
    "0 - 0 - 0",
    "77.86",
    "vs.",
    "118.86",
    "115.68",
    "Orig Proj",
    "112.13",
    "104.09",
    "Proj Pts",
    "143.52",
    "Don't call it a comeback",
    "Anthony",
    "0 - 0 - 0",
    "3 Players remaining",
    "Stats\tPlayer\tProj\tFan Pts\tPos\tFan Pts\tProj\tPlayer\tStats",
    "J. BurrowCin - QB",
    "Final (W) 33-27 vs TB",
    "20.30",
    "14.16",
    "QB",
    "35.66",
    "19.27",
    "J. AllenBuf - QB",
    "Final (W) 36-31 @ HOU",
    "Matchups",
    "Week 1 Matchups",
    "Penny Wise",
    "Brittany",
    "0 - 0 - 0",
    "139.04",
  ].join("\n");
  const meta = appJson(`parseYahooMatchupMeta(__ym)`);
  assert.deepStrictEqual(meta, {
    leagueName: "One league to rule them all",
    leftTeam: "Tyler's Tip-Top Team",
    rightTeam: "Don't call it a comeback",
    week: 1,
  });
  delete sandbox.__ym;
});

check("parseYahooMatchupMeta: table-only paste yields nulls", () => {
  sandbox.__ym2 = ["J. BurrowCin - QB", "20.30", "14.16", "QB", "35.66", "19.27", "J. AllenBuf - QB"].join("\n");
  assert.deepStrictEqual(appJson(`parseYahooMatchupMeta(__ym2)`), {
    leagueName: null, leftTeam: null, rightTeam: null, week: null,
  });
  delete sandbox.__ym2;
});

check("yahoo week gate: matching week shows, stale hidden", () => {
  vm.runInContext(`yahooDataById.clear()`, sandbox);
  vm.runInContext(`gdWeek = 1`, sandbox);
  const mk = (id, week) => `yahooDataById.set(${JSON.stringify(id)}, { id: ${JSON.stringify(id)}, key: "yahoo:${id}", leagueName: "Y League", week: ${week}, mySide: "left", myTeamLabel: "Me", oppTeamLabel: "Opp", my: [{ slot: "QB", playerName: "J. Burrow", pos: "QB", nflTeam: "CIN", fantasyPts: 14.16 }], opp: [] })`;
  vm.runInContext(mk("a-w1", 1), sandbox);
  vm.runInContext(mk("a-w2", 2), sandbox);
  const inc = appJson(`collectYahooEntries()`);
  assert.strictEqual(inc.length, 1, `expected 1 included entry, got ${inc.length}`);
  assert.strictEqual(inc[0].platform, "yahoo");
  const gate = appJson(`yahooIncludedEntries()`);
  assert.strictEqual(gate.included.length, 1);
  assert.strictEqual(gate.skipped.length, 1);
  // Matchup builder maps the stored side without live data.
  const mu = appJson(`buildYahooMatchup("yahoo:a-w1", null)`);
  assert.strictEqual(mu.platform, "yahoo");
  assert.strictEqual(mu.my.length, 1);
  assert.strictEqual(mu.my[0].playerName, "J. Burrow");
  // No auto week (Yahoo-only) → everything shows.
  vm.runInContext(`gdWeek = null`, sandbox);
  assert.strictEqual(appJson(`yahooIncludedEntries()`).included.length, 2);
  vm.runInContext(`yahooDataById.clear()`, sandbox);
  vm.runInContext(`gdWeek = null`, sandbox);
});

// ================= 2. UX evals (offline fixtures, rendered HTML) =================

function fixtureSchedule(state, special) {
  return {
    map: {
      DAL: { opp: "PHI", homeAway: "away", date: new Date(), label: "Sun 1:00 PM ET", weekday: "Sun", special: !!special, gameId: "g1" },
    },
    games: {
      g1: {
        id: "g1", away: "DAL", home: "PHI", awayScore: 14, homeScore: 10,
        state, detail: state === "in" ? "3rd 7:30" : state === "post" ? "Final" : "",
        clock: state === "in" ? "7:30" : "", period: state === "in" ? 3 : 0,
        date: new Date(), label: "Sun 1:00 PM ET", weekday: "Sun", special: !!special,
      },
    },
    teamToGame: { DAL: "g1", PHI: "g1" },
    week: 1,
  };
}

check("eval: pre-game pill shows matchup+time, no lock, no moon for Sun 1pm", () => {
  sandbox.__s = fixtureSchedule("pre", false);
  const pill = vm.runInContext(`gamePillHtml("DAL", __s)`, sandbox);
  assert.ok(pill.includes("@ PHI"), `pill was: ${pill}`);
  assert.ok(!pill.includes("🔒") && !pill.includes("🌙"), `pill was: ${pill}`);
  const cell = vm.runInContext(`slotCell("QB", "DAL", __s)`, sandbox);
  assert.ok(!cell.includes("🔒"), `cell was: ${cell}`);
  delete sandbox.__s;
});

check("eval: standalone window pill carries the moon highlight", () => {
  sandbox.__s = fixtureSchedule("pre", true);
  const pill = vm.runInContext(`gamePillHtml("DAL", __s)`, sandbox);
  assert.ok(pill.includes("🌙"), `pill was: ${pill}`);
  delete sandbox.__s;
});

check("eval: live game locks the slot and shows live detail, not the moon", () => {
  sandbox.__s = fixtureSchedule("in", true);
  const pill = vm.runInContext(`gamePillHtml("DAL", __s)`, sandbox);
  assert.ok(pill.includes("3rd 7:30") && !pill.includes("🌙"), `pill was: ${pill}`);
  const cell = vm.runInContext(`slotCell("QB", "DAL", __s)`, sandbox);
  assert.ok(cell.includes("🔒"), `cell was: ${cell}`);
  delete sandbox.__s;
});

check("eval: team with no game shows Bye", () => {
  sandbox.__s = fixtureSchedule("pre", false);
  assert.ok(vm.runInContext(`gamePillHtml("XYZ", __s)`, sandbox).includes("Bye"));
  delete sandbox.__s;
});

check("eval: league card renders team, starters and bench sections", () => {
  sandbox.__league = { name: "Test League", roster_positions: ["QB", "BN"], total_rosters: 10, season: "2025" };
  sandbox.__roster = { roster_id: 1, settings: { wins: 5, losses: 2, fpts: 100, fpts_decimal: 50 }, starters: ["p1"], players: ["p1", "p2"] };
  sandbox.__user = { display_name: "Coach", metadata: {} };
  sandbox.__players = {
    p1: { full_name: "Star QB", team: "KC", position: "QB", injury_status: "" },
    p2: { full_name: "Bench RB", team: "DAL", position: "RB", injury_status: "" },
  };
  const html = vm.runInContext(`renderLeague(__league, __roster, __user, __players, null).innerHTML`, sandbox);
  assert.ok(html.includes("Test League"), "missing league name");
  assert.ok(html.includes("Star QB"), "missing starter");
  assert.ok(html.includes("Bench (1)"), "missing bench section");
  assert.ok(html.includes("Starting lineup"), "missing starters section");
  delete sandbox.__league; delete sandbox.__roster; delete sandbox.__user; delete sandbox.__players;
});

if (process.exitCode) {
  console.error(`pure.js: failures above (${passed} passed)`);
} else {
  console.log(`pure.js: all ${passed} checks passed`);
}
