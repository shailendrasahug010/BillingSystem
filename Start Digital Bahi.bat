@echo off
rem Double-click to start Digital Bahi on this computer and on phones on the same Wi-Fi.
rem The first time it downloads what is missing (Node.js, PostgreSQL) and builds the app: a few minutes.
rem After "git pull" it builds again by itself. "Stop Digital Bahi.bat" stops it.
setlocal
set DIGITALBAHI_NO_PAUSE=1
call "%~dp0installer\windows\DigitalBahi.cmd" start --phone
set code=%errorlevel%
echo.
if not "%code%"=="0" (
  echo   Digital Bahi could not start: the message above says why.
) else (
  echo   Digital Bahi keeps running when you close this window.
)
pause
exit /b %code%
