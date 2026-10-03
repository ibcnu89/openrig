#!/usr/bin/env bash
# Smoke test for the mobile-room gateway against a running OpenRig daemon.
# Usage: tests/smoke.sh [ROOM_BASE_URL]   (default http://127.0.0.1:8800)
set -u
BASE="${1:-http://127.0.0.1:8800}"
fails=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected $2, got $3)"; fails=$((fails+1)); fi
}

# 1. health
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")
check "GET /api/health" 200 "$code"

# 2. hello (human identity present)
h=$(curl -s "$BASE/api/hello")
echo "$h" | grep -q '"human"' && echo "PASS: GET /api/hello has human" || { echo "FAIL: /api/hello missing human"; fails=$((fails+1)); }

# 3. UI serves
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
check "GET / (UI)" 200 "$code"

# 4. manifest + icon
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/manifest.webmanifest")
check "GET /manifest.webmanifest" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/icon-192.png")
check "GET /icon-192.png" 200 "$code"

# 5. agents payload
curl -s "$BASE/api/agents" | grep -q '"agents"' && echo "PASS: GET /api/agents" || { echo "FAIL: /api/agents"; fails=$((fails+1)); }

# 6. messages payload
curl -s "$BASE/api/messages?limit=5" | grep -q '"messages"' && echo "PASS: GET /api/messages" || { echo "FAIL: /api/messages"; fails=$((fails+1)); }

# 7. malformed send rejected
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/send" -H 'Content-Type: application/json' -d '{}')
check "POST /api/send empty rejected" 400 "$code"

# 8. SSE stream opens
s=$(curl -s -N --max-time 3 "$BASE/api/stream" | head -c 40)
echo "$s" | grep -q "retry" && echo "PASS: GET /api/stream SSE" || { echo "FAIL: /api/stream"; fails=$((fails+1)); }

echo "----"
[ "$fails" -eq 0 ] && echo "ALL SMOKE TESTS PASSED" || echo "$fails TEST(S) FAILED"
exit "$fails"
