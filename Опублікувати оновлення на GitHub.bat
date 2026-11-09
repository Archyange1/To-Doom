@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===================================================
echo   Публікація оновлення To Doom на GitHub
echo ===================================================
if not exist ".git" (
  git init
  git branch -M main
  git remote add origin https://github.com/Archyange1/To-Doom.git
)
git add .gitignore package.json package-lock.json server.js main.js preload.js mcp-server.js build-apk.js build-windows.js ToDoom.ico public/ android-build/ mini-server/ README.md "Запустити To Doom.bat" "Запустити без консолі.vbs" "Опублікувати оновлення на GitHub.bat"
set /p COMMIT_MSG="Опис оновлення (Enter для авто-опису): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=Update To Doom
git commit -m "%COMMIT_MSG%"
git push -u origin main
echo.
echo Готово! Тепер на всіх пристроях (ПК, планшет, iPhone, міні-сервер) можна натиснути "Оновити з GitHub".
pause
