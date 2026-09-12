# FantasyCast Football — agent notes

Static Sleeper/ESPN fantasy dashboard. `index.html` + `app.js` + `styles.css`
(plain static, GitHub Pages). `server.py` is a local-only ESPN proxy enhancement.

## Verify (fast, offline)

Run `python tests/smoke.py` after any code change — stdlib only, ~5s, no
network beyond localhost. It covers static checks, ID wiring, the static
boundary, both serve modes (error paths only), JS pure-function units
(`tests/pure.js`), and offline UX evals. Same suite runs in CI on every PR.

## Boundaries

- Pages serves only `index.html`, `app.js`, `styles.css`: no dependencies,
  no hardcoded localhost, no secrets, no `require()`/node imports in `app.js`.
- Never make live Sleeper/ESPN calls from tests — slow, flaky, rate-limited.
- Still manual per-PR: live loads in both modes, F12 console, phone viewport.

## Workflow

See `CONTRIBUTING.md`. Small topic branches (`feat/`, `fix:`, `chore:`),
squash-merge, conventional commit messages.
