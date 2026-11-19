#!/usr/bin/env bash
# Builds dist/mcp.js and tests it. The live test runs only when
# GEMINI_API_KEY is set (it uses real quota).
set -euo pipefail

echo "[1/4] Installing dependencies..."
npm install --no-audit --no-fund

echo "[2/4] Building dist/mcp.js..."
npm run build

echo "[3/4] Running tests..."
npm test
if [ -n "${GEMINI_API_KEY:-}" ]; then
  node test/live.js dist
else
  echo "NOTE: GEMINI_API_KEY not set - live test against the real API skipped."
fi

echo "[4/4] Cleaning up node_modules..."
rm -rf node_modules package-lock.json

echo ""
echo "Done. dist/mcp.js is self-contained: node dist/mcp.js [config.json]"
