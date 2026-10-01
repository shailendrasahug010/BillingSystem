@echo off
rem Digital Bahi: double-click (or "DigitalBahi start") to start it and open the app;
rem "DigitalBahi stop" stops it; "DigitalBahi status" shows whether it runs.
setlocal
title Digital Bahi
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\DigitalBahi.ps1" %*
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
