# Yahoo manual league via web copy/paste — spec (draft)

Branch: `docs/yahoo-paste-spec` · No code yet · Docs-only.

## 1. Goal

Let a user with a private Yahoo league appear in **GameDay views only**
(NFL-game group + fantasy-matchup group), without Yahoo OAuth / dev API keys,
by pasting the Yahoo web matchup table into a Setup panel.

- Source: Yahoo fantasy football **web matchup screen** copy/paste
  (the `Stats Player Proj Fan Pts Pos Fan Pts Proj Player Stats` table).
- Scope: GameDay only. **No Lineups/roster cards** (user asked to ignore roster views).
- Scoring: assume **half-PPR comparable**, same as the existing GameDay note.
  We display Yahoo `Fan Pts` as-is, no conversion.

## 2. Non-goals (this spec)

- No Yahoo OAuth / API integration, no secrets, no `server.py` changes.
- No screenshot OCR (app screenshots `IMG_2507/2508.PNG` were useful to
  confirm layout, but OCR is explicitly out — paste is more reliable).
- No live refresh for Yahoo. Pasted data is a **static snapshot**;
  user re-pastes to update. `Refresh scores` does not touch Yahoo entries.
- No bench/IR parsing for GameDay (paste includes `BN` rows; we skip them).

## 3. What the paste looks like (from the supplied sample)

Header junk to ignore:

```
Tyler's Tip-Top Team ... 77.86 vs. 118.86 ... Orig Proj ... Proj Pts ...
image-*.png filenames, "Players remaining", "Underdog/Favorite" lines
Stats Player Proj Fan Pts Pos Fan Pts Proj Player Stats
```

Starter rows (11 per side in the sample). Columns are **mirrored**:

```
[left Stats] [left Player block] [left Proj] [left Fan] [Pos] [right Fan] [right Proj] [right Player block] [right Stats]
```

Example row (from the sample):

```
J. Burrow Cin - QB / Final (W) 33-27 vs TB | 20.30 | 14.16 | QB | 35.66 | 19.27 | J. Allen Buf - QB / Final ...
```

- Left: `Proj=20.30`, `Fan=14.16`. Right: `Fan=35.66`, `Proj=19.27`.
- Bold number in the app = `Fan Pts` (actual); small number = `Proj`.
- `Pos` center column is the **lineup slot**: `QB,RB,WR,TE,W/R/T,K,DEF`
  (sample has `QB,RB,RB,WR,WR,WR,TE,W/R/T,W/R/T,K,DEF`).
- `BN` / `IR` center values exist below the starters — skip for GameDay.
- Player block format: `J. Burrow` + `Cin - QB` (+ optional status line
  `Final ...` / `Mon 8:15 PM ...`). Injuries append flags: `Q`, `PUP-R`
  (e.g. `K. Murray Min - QB Q`). DEF rows look like `Broncos Den - DEF`.
- Missing actuals (pre-game Monday players) show `-` / `—`:
  e.g. `K. Walker ... - / 13.21`, `C. Sutton ... 8.89 / -`.
- Team abbrs are mixed-case city codes (`Cin,Buf,Phi,Jax,Den,LAC...`);
  normalize with existing `normTeam()` (`app.js:132`) + uppercase.
  Trust the paste for team mapping even when it looks stale
  (sample has `J. Waddle Den`, `K. Walker KC` — parse as `DEN`, `KC`).

## 4. UX (Setup panel addition, static-safe)

Add a `Yahoo (manual)` panel group next to Sleeper/ESPN in `index.html`.
All client-side, no fetch, no dependency. Rough fields:

- `League name` (text, required, e.g. `One league to rule them all`)
- `Week` (number, default = current `gdWeek` if known, else 1)
- `My side`: `Left team` / `Right team` radio (which side of the paste is mine)
- `Team names` (optional overrides; else parsed `Tyler's Tip-Top Team` /
  `Don't call it a comeback`, or `Left`/`Right` fallback)
- `Paste` (textarea, pastes the web table as-is)
- `Parse & preview` button → editable preview table (see §6)
- `Save Yahoo league` → persists + appears in GameDay

Post-save:

- Entry appears in `Setup → Leagues` toggles + GameDay league picker,
  tagged `Yahoo` (`platform-yahoo` pill, same pattern as
  `tagCard(card,"espn","ESPN")`, `app.js:280`).
- `Loaded Yahoo leagues` list with `Remove` per league
  (mirror `syncEspnLoadedList`, `app.js:774`).
- Persist to `localStorage["yahoo_leagues"]` as
  `[{ id, leagueName, week, mySide, myTeamLabel, oppTeamLabel, my, opp }]`.
  Auto-load on open like `autoLoadPersistedEspnLeagues` (`app.js:989`).
- GameDay status must mark Yahoo as static, e.g.
  `Week 1 · 22 starters ... · Yahoo "One league..." is a manual paste (re-paste to update)`.

No Lineups-view card is rendered for Yahoo in this spec.

## 5. Data model (reuse GameDay entry shape)

```js
// stored per Yahoo league
{
  id: "yahoo:<slug>",        // slug of leagueName + week
  leagueName, week,
  mySide: "left" | "right",
  myTeamLabel, oppTeamLabel,
  my:  [{ slot, playerName, pos, nflTeam, fantasyPts }],  // starters only
  opp: [{ slot, playerName, pos, nflTeam, fantasyPts }],
}
```

- `slot`: center `Pos` verbatim (`QB,RB,WR,TE,W/R/T,K,DEF`).
- `playerName`: short name as pasted (`J. Burrow`, `Broncos` for DEF).
  For DEF rows set `playerName = "<ABBR> Defense"` to match
  `describePlayer` DEF convention (`app.js:100`).
- `pos`: Yahoo player pos from the block (`QB/RB/WR/TE/K/DEF`), `—` if missing.
- `nflTeam`: `normTeam(abbr)` or `null` (→ lands in Bye group, same as now).
- `fantasyPts`: `number|null` (`-`/`—`/empty → `null`; pre-kickoff shows `—`
  via existing `fptsFor`/`matchupDisplayPts`, `app.js:1726,1437`).
- Optionally keep `proj` alongside for preview display, but **do not**
  feed it into GameDay points (GameDay shows actuals only).

This maps 1:1 onto what `collectEspnEntriesFor` pushes
(`app.js:1257`: `leagueName,platform,side,teamLabel,slot,playerName,pos,nflTeam,fantasyPts`).

## 6. Parser spec — `parseYahooMatchupPaste(text)` (pure, testable)

New pure function in `app.js` (no DOM), unit-tested in `tests/pure.js`.

1. Normalize text: `\r\n`→`\n`, collapse runs of blank lines to one,
   trim. Keep line order.
2. Drop header/footer junk lines containing any of:
   `image-`, `.png`, `Players remaining`, `Underdog`, `Favorite`,
   `Orig Proj`, `Proj Pts`, `vs.`, `TOTAL`, `Note: Week`.
   Extract optional team labels from lines matching
   `(.+) vs. (...)` only as fallback; form fields win.
3. Anchor on center-slot tokens. Scan for lines that are exactly
   (case-sensitive) one of:
   `QB RB WR TE W/R/T WRT K DEF BN IR`
   (accept `WRT` as `W/R/T`; Yahoo web uses `W/R/T`, app uses `WRT`).
4. For each slot line at index `i`, look at the numeric window around it:
   the two nearest parseable numbers to the left (`Proj,Fan`) and two to
   the right (`Fan,Proj`). Number regex: `-?\d+\.\d{1,2}` or `-`/`—`.
   Left order = `[Proj, Fan]`, right order = `[Fan, Proj]`.
5. Player blocks: nearest non-numeric, non-slot lines outward from the
   numbers. Parse with:
   ```
   /^(.*?)\s*([A-Za-z]{2,3})\s*-\s*(QB|RB|WR|TE|K|DEF)\s*(Q|PUP-R|IR|O|D|SUSP)?$/i
   ```
   group1=name, group2=nfl abbr, group3=pos. Strip trailing `Q` etc.
   into an (ignored-for-GameDay) flag. `Broncos Den - DEF` → name=`Broncos`.
6. Skip rows where slot is `BN` or `IR` (bench section of the paste).
   Keep only the first contiguous starter block; warn if >14 starters/side
   (likely bench leaked in) or <7 (likely bad paste).
7. Assign sides: rows left of center → `left`, right → `right`.
   Caller maps `left/right` to `mine/opp` via the `My side` radio.
8. Validate + return `{ left: [...], right: [...], warnings: [...] }`
   where warnings cover: unmatched numbers, `nflTeam` unparseable,
   asymmetric starter counts, all-`null` actuals (pre-game paste is fine,
   just warn).

Preview step (DOM, not pure): render the parsed starters in an editable
table (columns: Side, Slot, Player, Pos, NFL, FanPts) so the user can fix
`DEN`-vs-`MIA`-style staleness or OCR-free typos before saving.
Save writes the edited table, not the raw parse.

## 7. GameDay integration (follow the ESPN pattern)

- `yahooDataById: Map(id → entry)` + `getYahooList()`,
  `persistYahooLeagues()`, `removeYahooLeague(id)` (mirror `app.js:760-806`).
- `collectYahooEntries()`:
  for each visible (`getHiddenLeagues`, `app.js:265`) Yahoo league,
  push `{...e, leagueName, platform:"yahoo", side:"mine"|"opp"}`
  for `my` + `opp`. No chopped-league special case unless the league
  name matches `isChoppedLeague` (`app.js:336`) — reuse as-is.
- `buildYahooMatchup(leagueKey)` returning
  `{ leagueName, platform:"yahoo", myLabel, oppLabel, chopped:false,
     my:[{slot,playerName,pos,nflTeam,fantasyPts,game}], opp:[...] }`
  with `game = matchupGameFor(nflTeam, sched)` (`app.js:1424`).
- Wire into `renderGameday` (`app.js:1670`):
  `entries = [...collectSleeperEntries(), ...collectEspnEntries(), ...collectYahooEntries()]`,
  matchup mode via `buildMatchupData` (`app.js:1546`) gaining a
  `yahoo:` branch. Yahoo cards join the existing
  `leagueStore`/`syncLeagues`/`getGamedayLeagueOptions` with
  `key = "yahoo:<slug>"`.
- Points/display reuse `fptsFor`, `matchupCountablePts`,
  `matchupDisplayPts` unchanged — `null` already renders `—`.
- Refresh: `refreshGameday` (`app.js:1785`) leaves Yahoo entries untouched.

## 8. Static boundary + persistence

- No new files served, no dependency, no `fetch`, no secrets —
  same constraint as `CONTRIBUTING.md` static boundary and
  `tests/smoke.py` §C. `localStorage`-only persistence.
- Keys: `yahoo_leagues` (data), reuse `fc_hidden` (visibility),
  `fc_gameday_group` / `fc_gameday_matchup_league` (picker) unchanged.

## 9. Tests

- `tests/pure.js`: add `parseYahooMatchupPaste` fixtures from the supplied
  paste — mirrored columns, `-` pre-game nulls, `W/R/T` + `WRT`,
  `Broncos Den - DEF`, `Q` stripping, `BN` skipping, junk-line drops.
  Assert 11+11 starters, `J. Burrow → {nflTeam:"CIN", fantasyPts:14.16}`,
  `J. Allen → {nflTeam:"BUF", fantasyPts:35.66}`,
  `K. Walker → {fantasyPts:null}` (pre-game dash).
- `tests/smoke.py`: unchanged (docs-only + pure-function addition;
  ID-wiring check must pass for any new `getElementById` targets).

## 10. Open questions

1. Confirm `Fan Pts` (actuals) is the only points column for GameDay,
   with `Proj` preview-only — or do you want proj shown somewhere?
	A: No need to show proj points. (We don't show that for other platforms, so that should be simple.)

2. Week/season source: form-typed week (defaulting to Sleeper `gdWeek`)
   is specced; ok?
 	A: Yes. In fact, as part of the saved leagues, we should know whether the last Yahoo week is the same as the Sleeper week. If it is, then we should continue to show the Yahoo league. If not, then we should not show the Yahoo week. 
 	→ Implemented as week-gating: saved Yahoo week shows only when it equals the auto week (`gdWeek`, else ESPN week). Yahoo-only (no auto week) shows all. Stale leagues are named in the GameDay status.

3. Multiple Yahoo leagues: same Add-again pattern as ESPN — ok?
	A: Yes

4. K/DEF scoring comparability: keep raw Yahoo points with the existing
   "half-PPR comparable" disclaimer — ok?
	A: Yes. We should use the same defensive scoring rules from them too. 

## 11. Suggested build order (for the later PR)

1. `parseYahooMatchupPaste` + `tests/pure.js` fixtures (no UI).
2. Setup-panel form + preview/edit + `localStorage`.
3. `collectYahooEntries` + NFL-group GameDay.
4. Matchup-mode `buildYahooMatchup` + league picker + toggles.
