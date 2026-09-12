#!/usr/bin/env python3
"""FantasyCast smoke suite (stdlib only, no network beyond localhost).

Run:  python tests/smoke.py

Covers, fast and offline:
  A. static: node --check app.js, py_compile server.py, HTML parse index.html
  B. wiring: every getElementById() target in app.js exists in index.html
  C. static boundary: Pages-served files stay dependency-free, no localhost
  D. proxy unit: server.ALLOWED_VIEWS covers the views app.js requests
  E. serve: Mode B (http.server) 200s; Mode A (server.py) health + 400-paths
  F. js units+evals: node tests/pure.js (pure functions + rendered-HTML UX)

Deliberately NOT covered here (manual per-PR checklist instead):
  live Sleeper/ESPN loads, F12 console, phone-viewport visual check.
  No live ESPN calls are made: they are slow, flaky, and rate-limited.
"""
import html.parser
import json
import py_compile
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_JS = ROOT / "app.js"
INDEX_HTML = ROOT / "index.html"
STYLES_CSS = ROOT / "styles.css"
SERVER_PY = ROOT / "server.py"
PURE_JS = Path(__file__).resolve().parent / "pure.js"

PASS, FAIL = [], []
T0 = time.perf_counter()


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'ok' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)


def fetch(url, timeout=5):
    """GET url -> (status, body). HTTP errors return their code, not raise."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return e.code, body
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for(url, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, _ = fetch(url)
        if status is not None:
            return True
        time.sleep(0.3)
    return False


# ---------------- A. static ----------------
print("A. static checks")
node = shutil.which("node")
if node:
    r = run([node, "--check", str(APP_JS)])
    check("node --check app.js", r.returncode == 0, (r.stderr or r.stdout).strip()[:300])
else:
    check("node --check app.js", False, "node not on PATH")

try:
    py_compile.compile(str(SERVER_PY), doraise=True)
    check("py_compile server.py", True)
except Exception as e:
    check("py_compile server.py", False, str(e)[:200])


class ParseOK(html.parser.HTMLParser):
    def error(self, message):
        raise ValueError(message)


try:
    ParseOK().feed(INDEX_HTML.read_text(encoding="utf-8"))
    check("index.html parses", True)
except Exception as e:
    check("index.html parses", False, str(e)[:200])

html_text = INDEX_HTML.read_text(encoding="utf-8")
check("viewport meta present", 'name="viewport"' in html_text)
css_text = STYLES_CSS.read_text(encoding="utf-8")
check("responsive CSS present", ("auto-fill" in css_text or "@media" in css_text))

# ---------------- B. wiring ----------------
print("B. ID wiring (app.js -> index.html)")
js_text = APP_JS.read_text(encoding="utf-8")
wanted = sorted(set(re.findall(r"getElementById\(\s*[\"']([\w-]+)[\"']", js_text)))
have = set(re.findall(r'id\s*=\s*["\']([\w-]+)["\']', html_text))
missing = [i for i in wanted if i not in have]
check(f"all {len(wanted)} getElementById targets exist", not missing, f"missing: {missing}")
check("index.html loads app.js", re.search(r'<script\s+src="app\.js', html_text) is not None)
check("index.html links styles.css", re.search(r'href="styles\.css"', html_text) is not None)

# ---------------- C. static boundary ----------------
print("C. static boundary (Pages serves only html/js/css)")
check("app.js has no hardcoded localhost", "localhost" not in js_text and "127.0.0.1" not in js_text)
check("app.js has no require()/node imports", "require(" not in js_text and re.search(r"^\s*import\s", js_text, re.M) is None)
check("app.js has no process.env secrets", "process.env" not in js_text)
check("index.html has no hardcoded localhost", "localhost" not in html_text and "127.0.0.1" not in html_text)
allowed_imports = {"json", "urllib.parse", "urllib.request", "urllib.error",
                   "http.server", "sys"}
server_imports = set(re.findall(r"^\s*(?:import|from)\s+([\w.]+)", SERVER_PY.read_text(encoding="utf-8"), re.M))
check("server.py stays stdlib-only", server_imports <= allowed_imports, f"extra: {sorted(server_imports - allowed_imports)}")

# ---------------- D. proxy unit (no network) ----------------
print("D. proxy validation unit")
sys.path.insert(0, str(ROOT))
try:
    import server as _srv  # noqa: E402  (guarded main; import is side-effect free)

    need = {"mTeam", "mRoster", "mSettings", "mMatchup", "mBoxscore", "mStatus"}
    # views app.js actually requests (espnApi calls across loadEspn/backfill/refresh)
    check("ALLOWED_VIEWS covers views app.js uses", need <= set(_srv.ALLOWED_VIEWS),
          f"missing: {sorted(need - set(_srv.ALLOWED_VIEWS))}")
    check("ESPN reads host is the public one", _srv.ESPN_HOST.startswith("https://lm-api-reads.fantasy.espn.com"))
except Exception as e:
    check("server.py imports cleanly", False, f"{type(e).__name__}: {e}"[:200])

# ---------------- E. serve checks (localhost only) ----------------
print("E. serve checks")

# Mode B: static-only (Pages simulation)
port_b = free_port()
proc_b = subprocess.Popen([sys.executable, "-m", "http.server", str(port_b)],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    if wait_for(f"http://127.0.0.1:{port_b}/"):
        for path in ("/", "/app.js", "/styles.css"):
            status, body = fetch(f"http://127.0.0.1:{port_b}{path}")
            check(f"Mode B GET {path} -> 200", status == 200,
                  f"got {status} {(body or '')[:120]}")
    else:
        check("Mode B server started", False, "http.server never responded")
finally:
    proc_b.terminate()

# Mode A: full local (server.py proxy present) — error paths only, no live ESPN
port_a = free_port()
proc_a = subprocess.Popen([sys.executable, str(SERVER_PY), str(port_a)],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    if wait_for(f"http://127.0.0.1:{port_a}/api/health"):
        status, body = fetch(f"http://127.0.0.1:{port_a}/api/health")
        try:
            ok = status == 200 and json.loads(body).get("ok") is True
        except Exception:
            ok = False
        check("/api/health -> {ok:true}", ok, f"got {status} {(body or '')[:120]}")

        status, body = fetch(f"http://127.0.0.1:{port_a}/")
        check("Mode A GET / serves index", status == 200 and "FantasyCast" in body,
              f"got {status}")

        for name, qs in [
            ("no query", ""),
            ("non-numeric season/league", "?season=abc&leagueId=xyz&view=mTeam"),
            ("disallowed view", "?season=2025&leagueId=123&view=Nope"),
            ("missing view", "?season=2025&leagueId=123"),
        ]:
            status, _ = fetch(f"http://127.0.0.1:{port_a}/api/espn{qs}")
            check(f"/api/espn {name} -> 400", status == 400, f"got {status}")
    else:
        check("Mode A server started", False, "server.py never responded")
finally:
    proc_a.terminate()

# ---------------- F. js units + evals ----------------
print("F. js units + UX evals")
if node:
    r = run([node, str(PURE_JS)], cwd=str(ROOT))
    print("    " + (r.stdout or "").strip().replace("\n", "\n    "))
    check("node tests/pure.js", r.returncode == 0, (r.stderr or "").strip()[:300])
else:
    check("node tests/pure.js", False, "node not on PATH")

# ---------------- summary ----------------
dt = time.perf_counter() - T0
print(f"\n{len(PASS)} passed, {len(FAIL)} failed in {dt:.1f}s")
if FAIL:
    print("failures:", FAIL)
    print("NOTE (still manual per-PR): live Sleeper/ESPN loads, F12 console, phone viewport.")
    sys.exit(1)
print("NOTE (still manual per-PR): live Sleeper/ESPN loads, F12 console, phone viewport.")
