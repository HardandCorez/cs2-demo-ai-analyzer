@echo off
setlocal
cd /d %~dp0
if not exist .env (
  echo [ERROR] File .env not found.
  echo Copy .env.example to .env and add OPENAI_API_KEY.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
echo Starting CS2 Demo AI Analyzer...
start "" http://localhost:3000
npm start
