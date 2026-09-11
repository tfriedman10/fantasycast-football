@echo off
REM FantasyCast Football - local launcher
REM Double-click this file to host the app locally and open it in your browser.
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found on PATH.
  echo Please install Python 3 from https://www.python.org/downloads/ and tick "Add python to PATH".
  pause
  exit /b 1
)

set PORT=8123
echo Starting FantasyCast locally on http://localhost:%PORT% ...
echo Serving folder: %CD%
echo Port 8123 is used to avoid clashing with other local projects on 8000.
echo If your browser shows an old version, hard-refresh with Ctrl+Shift+R.
echo If the page says Starting... forever, leave this window open and refresh.
echo Close this window to stop the server.
echo.

REM Open browser after ~2s in background so the server has time to start.
start "" /min cmd /c "ping 127.0.0.1 -n 3 >nul & start http://localhost:%PORT%/ & exit"
REM server.py serves the app AND proxies ESPN (needed for private leagues).
python "%~dp0server.py" %PORT%
pause
