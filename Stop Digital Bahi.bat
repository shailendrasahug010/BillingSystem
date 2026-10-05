@echo off
rem Double-click to stop Digital Bahi (the server and its database) on this computer.
setlocal
set DIGITALBAHI_NO_PAUSE=1
call "%~dp0installer\windows\DigitalBahi.cmd" stop
timeout /t 3 >nul
