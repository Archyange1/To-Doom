@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" .
) else (
  start /b "" node server.js
  timeout /t 1 /nobreak >nul
  start "" msedge --app=http://localhost:3456
)
