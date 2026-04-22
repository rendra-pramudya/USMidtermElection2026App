@echo off
title US Midterm 2026 — Election Dashboard
cd /d "%~dp0"

echo.
echo  ============================================================
echo   US Midterm 2026  ^|  Election Dashboard + Vizrt Push
echo  ============================================================
echo.
echo  Starting combined server (web dashboard + Vizrt push)...
echo.
echo  Dashboard: http://localhost:3000
echo  Press Ctrl+C in this window to stop everything.
echo.

REM Open the browser after a short delay (runs in background, doesn't block)
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

REM Run the server in the foreground so the user can see live output.
REM Ctrl+C here stops both the web server and the Vizrt push service.
node src\server\server.js

echo.
echo  Server stopped. Press any key to close.
pause >nul
