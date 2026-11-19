@echo off
rem Builds dist\mcp.js and tests it. The live test runs only when
rem GEMINI_API_KEY is set (it uses real quota).
setlocal

echo [1/4] Installing dependencies...
call npm install --no-audit --no-fund
if %errorlevel% neq 0 exit /b %errorlevel%

echo [2/4] Building dist/mcp.js...
call npm run build
if %errorlevel% neq 0 exit /b %errorlevel%

echo [3/4] Running tests...
call npm test
if %errorlevel% neq 0 exit /b %errorlevel%
if "%GEMINI_API_KEY%"=="" (
  echo NOTE: GEMINI_API_KEY not set - live test against the real API skipped.
) else (
  call node test/live.js dist
  if errorlevel 1 exit /b 1
)

echo [4/4] Cleaning up node_modules...
if exist node_modules rd /s /q node_modules
if exist package-lock.json del /f /q package-lock.json

echo.
echo Done. dist\mcp.js is self-contained: node dist\mcp.js [config.json]
endlocal
