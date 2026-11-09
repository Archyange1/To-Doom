@echo off
chcp 65001 >nul
cd /d "%~dp0"
set TODOOM_SERVER=
call npm install --omit=dev
node server.js
