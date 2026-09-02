#!/usr/bin/env bash
# Retry 65 error chapters with minimax/minimax-m3:free
set -e
cd /c/Users/User/Desktop/benggong
export OPENROUTER_EFFORT=ultra
exec /c/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/run_extraction.py \
  --chapters "1,2,3,17,76,80,81,87,109,115,120,132,133,140,144,146,148,149,150,152,153,154,155,156,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198" \
  2>&1 | tee data/private/review/run-65-retry-$(date -u +%Y%m%dT%H%M%SZ).log
