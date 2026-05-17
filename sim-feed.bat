@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  sim-feed.bat  -  US Midterm Election 2026 / Test Data Feed
::
::  Usage:
::    sim-feed.bat                  start at 2x (default)
::    sim-feed.bat [speed]          start at custom speed
::                                    0.5 | 1 | 2 | 5 | 10
::    sim-feed.bat stop             stop a running feed
::    sim-feed.bat status           show current race progress
::    sim-feed.bat [speed] [url]    use a different server URL
::
::  Examples:
::    sim-feed.bat 5
::    sim-feed.bat 1 http://192.168.1.10:3000
:: ============================================================

:: ---- Config (edit if needed) --------------------------------
set "BASE=http://localhost:3000"
set "USER=admin"
set "PASS=admin123"
set "DEFAULT_SPEED=2"
:: -------------------------------------------------------------

set "CMD=%~1"
set "SPEED=%~1"
set "OVERRIDE_URL=%~2"

if not "%OVERRIDE_URL%"=="" set "BASE=%OVERRIDE_URL%"
if "%SPEED%"==""            set "SPEED=%DEFAULT_SPEED%"

:: Dispatch sub-commands
if /i "%CMD%"=="stop"   goto CMD_STOP
if /i "%CMD%"=="status" goto CMD_STATUS

:: ============================================================
::  Default: reset + start the simulation feed
:: ============================================================

echo.
echo  =====================================================
echo   US Midterm 2026  ^^|  Simulation Feed
echo  =====================================================
echo   Server  :  %BASE%
echo   Speed   :  %SPEED%x
echo   User    :  %USER%
echo  =====================================================
echo.

:: ---- Check curl + powershell are available ------------------
where curl     >nul 2>&1 || (echo  ERROR: curl not found. Install from https://curl.se/ & exit /b 1)
where powershell >nul 2>&1 || (echo  ERROR: powershell not found & exit /b 1)

:: ---- Write JSON request bodies to temp files ----------------
set "TMP_LOGIN=%TEMP%\sim_login_%RANDOM%.json"
set "TMP_SPEED=%TEMP%\sim_speed_%RANDOM%.json"
echo {"username":"%USER%","password":"%PASS%"}   > "%TMP_LOGIN%"
echo {"speed":%SPEED%}                            > "%TMP_SPEED%"

:: ---- Step 1: Login ------------------------------------------
echo  [1/4] Authenticating as editor ...

for /f "usebackq delims=" %%T in (
  `curl -s -X POST "%BASE%/api/login" -H "Content-Type: application/json" -d @"%TMP_LOGIN%" 2^>nul ^| powershell -NoProfile -Command "$j=$input|ConvertFrom-Json; if($j.ok){$j.token}"`
) do set "TOKEN=%%T"

del "%TMP_LOGIN%" >nul 2>&1

if "!TOKEN!"=="" (
  echo.
  echo  ERROR: Login failed.
  echo  - Is the server running?  ^(npm run web^)
  echo  - Is %BASE% correct?
  echo.
  exit /b 1
)
echo         OK  ^(token: !TOKEN:~0,16!...^)
echo.

:: ---- Step 2: Reset ------------------------------------------
echo  [2/4] Resetting simulation ^(new random scenario^) ...
for /f "usebackq delims=" %%R in (
  `curl -s -X POST "%BASE%/api/sim/reset" -H "Authorization: Bearer !TOKEN!" 2^>nul ^| powershell -NoProfile -Command "$j=$input|ConvertFrom-Json; if($j.ok){'OK'}else{'FAIL: '+$j.error}"`
) do set "RESULT=%%R"
echo         !RESULT!
echo.

:: ---- Step 3: Set speed --------------------------------------
echo  [3/4] Setting speed to %SPEED%x ...
for /f "usebackq delims=" %%R in (
  `curl -s -X POST "%BASE%/api/sim/speed" -H "Authorization: Bearer !TOKEN!" -H "Content-Type: application/json" -d @"%TMP_SPEED%" 2^>nul ^| powershell -NoProfile -Command "$j=$input|ConvertFrom-Json; if($j.ok){'OK'}else{'FAIL: '+$j.error}"`
) do set "RESULT=%%R"
del "%TMP_SPEED%" >nul 2>&1
echo         !RESULT!
echo.

:: ---- Step 4: Start ------------------------------------------
echo  [4/4] Starting live feed ...
for /f "usebackq delims=" %%R in (
  `curl -s -X POST "%BASE%/api/sim/start" -H "Authorization: Bearer !TOKEN!" 2^>nul ^| powershell -NoProfile -Command "$j=$input|ConvertFrom-Json; if($j.ok){'OK'}else{'FAIL: '+$j.error}"`
) do set "RESULT=%%R"
echo         !RESULT!
echo.
echo  Dashboard : %BASE%
echo.
echo  =====================================================
echo   LIVE FEED  ^^|  Press Ctrl+C to abort
echo  =====================================================
echo.
echo   Time       Governor       Senate         House
echo   --------   -----------    ------------   -------------
echo.

:: ---- Poll loop ----------------------------------------------
:POLL
  for /f "usebackq delims=" %%L in (
    `curl -s "%BASE%/api/sim/status" -H "Authorization: Bearer !TOKEN!" 2^>nul ^| powershell -NoProfile -Command "$s=$input|ConvertFrom-Json; $gPct=if($s.governor.total-gt 0){[int]($s.governor.called/$s.governor.total*100)}else{0}; $sPct=if($s.senate.total-gt 0){[int]($s.senate.called/$s.senate.total*100)}else{0}; $hPct=if($s.house.total-gt 0){[int]($s.house.called/$s.house.total*100)}else{0}; $state=if($s.running){'RUNNING'}else{'STOPPED'}; $done=(-not $s.running -and $s.initialized -and $s.governor.called -ge $s.governor.total -and $s.senate.called -ge $s.senate.total -and $s.house.called -ge $s.house.total); $tag=if($done){'#DONE'}else{'#WAIT'}; '{0}   {1}/{2} ({3}%%)   {4}/{5} ({6}%%)   {7}/{8} ({9}%%)  [{10}]{11}' -f (Get-Date -f 'HH:mm:ss'),$s.governor.called,$s.governor.total,$gPct,$s.senate.called,$s.senate.total,$sPct,$s.house.called,$s.house.total,$hPct,$state,$tag"`
  ) do set "RAW=%%L"

  :: Split tag from display line (tag is after #)
  for /f "tokens=1 delims=#" %%D in ("!RAW!") do set "DISPLAY=%%D"
  for /f "tokens=2 delims=#" %%T in ("!RAW!") do set "STATE=%%T"

  echo   !DISPLAY!

  if /i "!STATE!"=="DONE" goto FEED_DONE

  timeout /t 2 /nobreak >nul
  goto POLL

:FEED_DONE
echo.
echo  =====================================================
echo   COMPLETE  -  All races have been called.
echo  =====================================================
echo.
echo  View final results: %BASE%
echo.
endlocal
exit /b 0


:: ============================================================
::  STOP sub-command
:: ============================================================
:CMD_STOP
echo.
echo  Stopping simulation feed...
echo.

where curl     >nul 2>&1 || (echo  ERROR: curl not found & exit /b 1)
where powershell >nul 2>&1 || (echo  ERROR: powershell not found & exit /b 1)

set "TMP_LOGIN=%TEMP%\sim_login_%RANDOM%.json"
echo {"username":"%USER%","password":"%PASS%"} > "%TMP_LOGIN%"

for /f "usebackq delims=" %%T in (
  `curl -s -X POST "%BASE%/api/login" -H "Content-Type: application/json" -d @"%TMP_LOGIN%" 2^>nul ^| powershell -NoProfile -Command "$j=$input|ConvertFrom-Json; if($j.ok){$j.token}"`
) do set "TOKEN=%%T"
del "%TMP_LOGIN%" >nul 2>&1

if "!TOKEN!"=="" (echo  ERROR: Login failed. Is the server running? & exit /b 1)

for /f "usebackq delims=" %%R in (
  `curl -s -X POST "%BASE%/api/sim/stop" -H "Authorization: Bearer !TOKEN!" 2^>nul ^| powershell -NoProfile -Command "$j=$input|ConvertFrom-Json; if($j.ok){'Simulation stopped.'}else{'FAIL: '+$j.error}"`
) do echo  %%R

echo.
endlocal
exit /b 0


:: ============================================================
::  STATUS sub-command
:: ============================================================
:CMD_STATUS
echo.
echo  Checking simulation status at %BASE% ...
echo.

where curl     >nul 2>&1 || (echo  ERROR: curl not found & exit /b 1)
where powershell >nul 2>&1 || (echo  ERROR: powershell not found & exit /b 1)

set "TMP_LOGIN=%TEMP%\sim_login_%RANDOM%.json"
echo {"username":"%USER%","password":"%PASS%"} > "%TMP_LOGIN%"

for /f "usebackq delims=" %%T in (
  `curl -s -X POST "%BASE%/api/login" -H "Content-Type: application/json" -d @"%TMP_LOGIN%" 2^>nul ^| powershell -NoProfile -Command "$j=$input|ConvertFrom-Json; if($j.ok){$j.token}"`
) do set "TOKEN=%%T"
del "%TMP_LOGIN%" >nul 2>&1

if "!TOKEN!"=="" (echo  ERROR: Login failed. Is the server running? & exit /b 1)

for /f "usebackq delims=" %%L in (
  `curl -s "%BASE%/api/sim/status" -H "Authorization: Bearer !TOKEN!" 2^>nul ^| powershell -NoProfile -Command "$s=$input|ConvertFrom-Json; 'State    : '+(if($s.running){'RUNNING'}elseif($s.initialized){'STOPPED'}else{'Not initialized'}); 'Speed    : '+$s.speed+'x'; 'Governor : '+$s.governor.called+'/'+$s.governor.total+' races called'; 'Senate   : '+$s.senate.called+'/'+$s.senate.total+' seats called'; 'House    : '+$s.house.called+'/'+$s.house.total+' seats called'"`
) do echo   %%L

echo.
endlocal
exit /b 0
