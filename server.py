#!/usr/bin/env python3
"""FantasyCast local server (stdlib only, no dependencies).

- Serves the static app (index.html / app.js / styles.css) from this folder.
- Proxies ESPN fantasy API calls at /api/espn so that:
    * browser CORS issues are avoided (same-origin request), and
    * private leagues work by forwarding pasted espn_s2 / SWID cookies
      server-side (browsers forbid setting Cookie headers from JS).

Usage:
    python server.py [port]   (default 8123)
"""
import json
import urllib.parse
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ESPN_HOST = "https://lm-api-reads.fantasy.espn.com"
ALLOWED_VIEWS = {
    "mTeam", "mRoster", "mSettings", "mMatchupScore", "mMatchup",
    "mBoxscore", "mStatus", "mScoreboard", "mSchedule", "mStandings",
    "proTeamSchedules_wl",
}


class Handler(SimpleHTTPRequestHandler):
    server_version = "FantasyCast/1.0"

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-ESPN-S2, X-ESPN-SWID, Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json(200, {"ok": True, "service": "fantasycast"})
            return
        if parsed.path == "/api/espn":
            self._proxy_espn(parsed)
            return
        # Static files; serve index.html for directory roots.
        if parsed.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, fmt, *args):  # keep default logging (visible in run.bat window)
        super().log_message(fmt, *args)

    def _proxy_espn(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        season = (qs.get("season", [""])[0] or "").strip()
        league_id = (qs.get("leagueId", [""])[0] or "").strip()
        if not season.isdigit() or not league_id.isdigit():
            self._send_json(400, {"error": "Query needs numeric season and leagueId"})
            return
        views = [v for v in qs.get("view", []) if v in ALLOWED_VIEWS]
        if not views:
            self._send_json(400, {"error": "Query needs at least one allowed view", "allowed": sorted(ALLOWED_VIEWS)})
            return
        params = [("view", v) for v in views]
        for key in ("scoringPeriodId", "matchupPeriodId"):
            if qs.get(key, [""])[0].strip().isdigit():
                params.append((key, qs[key][0].strip()))
        url = (
            f"{ESPN_HOST}/apis/v3/games/ffl/seasons/{season}/segments/0/"
            f"leagues/{league_id}?{urllib.parse.urlencode(params)}"
        )
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FantasyCast-local",
            "Accept": "application/json",
            "Referer": "https://fantasy.espn.com/",
        }
        espn_s2 = self.headers.get("X-ESPN-S2", "").strip()
        swid = self.headers.get("X-ESPN-SWID", "").strip()
        if espn_s2 or swid:
            cookie = "; ".join(
                [f"espn_s2={espn_s2}" if espn_s2 else "", f"SWID={swid}" if swid else ""]
            ).strip("; ")
            headers["Cookie"] = cookie
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                body = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:2000]
            except Exception:
                detail = ""
            self._send_json(e.code, {
                "error": f"ESPN returned HTTP {e.code}. "
                         + ("League may be private — paste SWID + espn_s2. " if e.code in (401, 403) else "")
                         + ("Check league ID / season. " if e.code == 404 else ""),
                "detail": detail,
            })
        except Exception as e:  # network/timeout
            self._send_json(502, {"error": f"Could not reach ESPN: {e}"})


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8123
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"FantasyCast on http://localhost:{port}/  (serving {__file__})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
