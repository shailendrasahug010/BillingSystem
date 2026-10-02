@echo off
rem Digital Bahi: double-click (or "DigitalBahi start") to start it and open the app;
rem "DigitalBahi stop" stops it; "DigitalBahi status" shows whether it runs. From the source
rem checkout, "DigitalBahi install" builds it again after the checkout changed (git pull).
setlocal
title Digital Bahi
rem In an installed copy the script is in launcher\; in the source checkout (installer\windows) it is
rem next to this file, and builds Digital Bahi for this computer the first time.
set "script=%~dp0launcher\DigitalBahi.ps1"
if not exist "%script%" set "script=%~dp0DigitalBahi.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%script%" %*
set code=%errorlevel%
rem status: 0 running, 3 stopped.
if /i "%~1"=="status" exit /b %code%
if not "%code%"=="0" (
  echo.
  echo   Digital Bahi could not finish: the message above says why.
  if not defined DIGITALBAHI_NO_PAUSE pause
  exit /b %code%
)
if /i "%~1"=="stop" if not defined DIGITALBAHI_NO_PAUSE timeout /t 3 >nul
exit /b 0
