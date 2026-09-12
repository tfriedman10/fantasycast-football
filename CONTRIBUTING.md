# Contributing

`main` is always deployable. All work lands via small PRs from topic branches.

## Branches

```
feat/<topic>   new capability
fix/<topic>    bug fix
chore/<topic>  tooling, cleanup
docs/<topic>   docs only
```

Branch from `main`, one topic per branch, delete after merge.

## Workflow

1. `git checkout main && git pull && git checkout -b feat/<topic>`
2. Code, then verify in both modes (below).
3. Push, open a PR against `main`, fill in the template.
4. Self-review the diff on GitHub, then squash-merge.

## Verification

Every PR passes two modes:

- **Mode A — full local:** launch via `run.bat` (proxy present). Sleeper + public ESPN load.
- **Mode B — static-only (Pages simulation):** serve with `python -m http.server` (no proxy). Public leagues load via direct fallback.

Also: hard-refresh (Ctrl+Shift+R), F12 console clean, phone-width viewport readable.

## Static boundary

GitHub Pages serves only `index.html`, `app.js`, `styles.css`. New code must work as plain static files — no new dependencies, no hardcoded localhost, no secrets. `server.py` stays a local-only enhancement.

## Commits

Conventional style: `feat: ...`, `fix: ...`, `chore: ...`, `docs: ...`. Direct commits to `main` only to fix a broken `main`.
