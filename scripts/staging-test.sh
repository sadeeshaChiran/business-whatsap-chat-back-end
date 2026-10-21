#!/usr/bin/env bash
# Function-by-function test of the WHOLE project – API (168 tests) + UI in a real browser (56 tests) – on a
# separate TEST copy. Real data, real WhatsApp numbers, SMS and AI are never touched:
#   * a new empty database "agentmetra_e2e" (same tables as production, no data) with test packages / settings
#   * a second API on port 3901 with its own settings (dev sign-up codes, fake Meta, fake AI bot), from /tmp
#   * the fake sales bot (the real bot code with a fake Gemini – no AI cost) on port 8901
#   * the web app built for that API, on port 5901, tested with Playwright (Chromium)
#
#   cd /var/www/business-whatsap-chat-back-end && npm run build
#   bash scripts/staging-test.sh            # everything, then removes the test database
#   bash scripts/staging-test.sh --api      # API tests only        --ui   UI tests only        --keep  keep the test DB
#   TESTS=test/order-summary.test.mjs bash scripts/staging-test.sh --api      # only some API test files
#
# Results: staging-api.log, staging-ui.log and the browser report in <web>/playwright-report (screenshots of failures).
set -u
BACKEND=$(cd "$(dirname "$0")/.." && pwd)
BOT_DIR=${BOT_DIR:-/var/www/business-whatsap-chat-bot}
WEB_DIR=${WEB_DIR:-/var/www/business-whatsap-chat-front-end}
API_PORT=${API_PORT:-3901}; BOT_PORT=${BOT_PORT:-8901}; WEB_PORT=${WEB_PORT:-5901}
RUN_API=1; RUN_UI=1; KEEP=0
for a in "$@"; do case $a in --api) RUN_UI=0 ;; --ui) RUN_API=0 ;; --keep) KEEP=1 ;; esac; done

PROD_DB=$(grep -E '^PRODUCT_DATABASE_URL=' "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d "'\"")
[ -z "$PROD_DB" ] && { echo "PRODUCT_DATABASE_URL not found in $BACKEND/.env"; exit 1; }
TEST_DB=${TEST_DATABASE_URL:-$(echo "$PROD_DB" | sed -E 's#/([^/?]+)(\?|$)#/agentmetra_e2e\2#')}
ADMIN_DB=$(echo "$PROD_DB" | sed -E 's#/([^/?]+)(\?|$)#/postgres\2#')
WORK=/tmp/agentmetra-e2e
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  if [ "$KEEP" = 0 ]; then psql "$ADMIN_DB" -qc "DROP DATABASE IF EXISTS agentmetra_e2e WITH (FORCE)" 2>/dev/null; fi
}
trap cleanup EXIT
# up = answers anything over HTTP (a 401 / 404 also means the server is running)
wait_for() { for _ in $(seq 1 120); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" != 000 ] && return 0; sleep 1; done; echo "not reachable: $1"; return 1; }

for port in $API_PORT $BOT_PORT $WEB_PORT; do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")" != 000 ]; then
    echo "Port $port is already in use (an old test run?). Stop it first:  fuser -k $port/tcp"; exit 1
  fi
done

echo "== 1) test database agentmetra_e2e (tables copied from production, NO data)"
psql "$ADMIN_DB" -qc "DROP DATABASE IF EXISTS agentmetra_e2e WITH (FORCE)" 2>/dev/null
if ! psql "$ADMIN_DB" -qc "CREATE DATABASE agentmetra_e2e"; then
  echo "Cannot create the test database with the app's database user. Run once as admin:"
  echo "  sudo -u postgres psql -p <port> -c \"ALTER USER <db user> CREATEDB\""
  exit 1
fi
SUPER_ADMIN_EMAIL=e2e-admin@agentmetra.test SUPER_ADMIN_PASSWORD=Test1234pass \
  bash "$BACKEND/scripts/make-full-install.sh" "$PROD_DB" > "$WORK.sql" 2>/dev/null || { echo "make-full-install.sh failed"; exit 1; }
psql "$TEST_DB" -q -v ON_ERROR_STOP=1 -f "$WORK.sql" > /dev/null || { echo "loading the test database failed"; exit 1; }

echo "== 2) fake sales bot on :$BOT_PORT (real bot code, fake Gemini)"
PY=python3
for p in "$BOT_DIR/.venv/bin/python" "$BOT_DIR/venv/bin/python" "$BOT_DIR/env/bin/python"; do [ -x "$p" ] && PY=$p && break; done
rm -rf "$WORK-captured" && mkdir -p "$WORK-captured"
(cd "$BOT_DIR" && CONTRACT_PORT=$BOT_PORT CAPTURE_DIR="$WORK-captured" BOT_DIR=. GEMINI_API_KEY=fake BOT_API_KEY=test-key BOT_MODEL=gemini-3-flash-preview \
  exec "$PY" tests/contract_server.py > "$WORK-bot.log" 2>&1) &
PIDS+=($!)

echo "== 3) test API on :$API_PORT (own settings in $WORK – never the production .env)"
rm -rf "$WORK" && mkdir -p "$WORK/media"
cp -r "$BACKEND/dist" "$BACKEND/package.json" "$WORK/" && ln -s "$BACKEND/node_modules" "$WORK/node_modules"
for d in assets docs; do [ -d "$BACKEND/$d" ] && ln -s "$BACKEND/$d" "$WORK/$d"; done
cat > "$WORK/.env" <<EOF
NODE_ENV=test
PORT=$API_PORT
PRODUCT_DATABASE_URL=$TEST_DB
JWT_SECRET=e2e-$(date +%s)-secret
OTP_DEV_MODE=true
CORS_ORIGINS=http://127.0.0.1:$WEB_PORT
FLOW_TICK_MS=1000
APP_PUBLIC_URL=http://127.0.0.1:$WEB_PORT
PUBLIC_API_BASE_URL=http://127.0.0.1:$API_PORT
CHAT_MEDIA_DIR=$WORK/media
CHAT_MEDIA_SECRET=e2e-media
META_GRAPH_BASE_URL=http://127.0.0.1:4599
META_APP_ID=new-app
META_APP_SECRET=new-secret
META_APP_SECRETS_EXTRA=old-secret
META_OAUTH_REDIRECT_URI=http://localhost/cb
META_WEBHOOK_VERIFY_TOKEN=platform-verify
META_MESSAGING_VERIFY_TOKEN=msg-verify
META_WHATSAPP_CONFIG_ID=wa-config
META_OAUTH_SUCCESS_REDIRECT=http://dash.test/channels/messenger
SALES_BOT_URL=http://127.0.0.1:$BOT_PORT
SALES_BOT_API_KEY=test-key
SALES_BOT_TEST_MODE=true
SALES_BOT_DEBOUNCE_MS=300
SALES_BOT_DEBOUNCE_FAST_MS=200
SALES_BOT_PART_DELAY_MS=0
SALES_BOT_FOLLOWUP_TICK_MS=1500
SALES_BOT_FOLLOWUP_ANY_TIME=true
SALES_BOT_FOLLOWUP_TICK_MS=1500
SALES_BOT_FOLLOWUP_ANY_TIME=true
SALES_BOT_FOLLOWUP_TICK_MS=1500
SALES_BOT_FOLLOWUP_ANY_TIME=true
EOF
# also as real environment variables: some settings (FLOW_TICK_MS, SALES_BOT_*, META_*) are read only from process.env
(cd "$WORK" && set -a && . ./.env && set +a && exec node dist/main.js > "$WORK-api.log" 2>&1) &
PIDS+=($!)
wait_for "http://127.0.0.1:$API_PORT/v1/api/auth/me" || { tail -30 "$WORK-api.log"; exit 1; }
wait_for "http://127.0.0.1:$BOT_PORT/health" || { tail -30 "$WORK-bot.log"; exit 1; }

API_RESULT=skipped; UI_RESULT=skipped
if [ "$RUN_API" = 1 ]; then
  echo "== 4) API tests (every module, function by function) – details in staging-api.log"
  run_tests() { (cd "$BACKEND" && API_URL=http://127.0.0.1:$API_PORT/v1/api TEST_DATABASE_URL=$TEST_DB META_APP_SECRET=new-secret BOT_CAPTURE_DIR="$WORK-captured" \
     node --test --test-concurrency=1 --test-reporter=spec "$@"); }
  if [ -n "${TESTS:-}" ]; then
    run_tests $TESTS > "$BACKEND/staging-api.log" 2>&1; API_OK=$?
  else
    # meta-health on its own first: it checks the webhook state of a freshly started API
    run_tests test/meta-health.test.mjs > "$BACKEND/staging-api.log" 2>&1; A=$?
    run_tests $(cd "$BACKEND" && ls test/*.test.mjs | grep -v meta-health.test.mjs) >> "$BACKEND/staging-api.log" 2>&1; B=$?
    API_OK=$(( A + B ))
  fi
  API_RESULT=$([ "$API_OK" = 0 ] && echo PASS || echo FAIL)
  awk '/^ℹ (tests|pass|fail|skipped) /{t[$2]+=$3} END{printf "tests %d · pass %d · fail %d · skipped %d\n", t["tests"], t["pass"], t["fail"], t["skipped"]}' "$BACKEND/staging-api.log"
  grep -E '^✖' "$BACKEND/staging-api.log" | grep -v 'failing tests' | sort -u | sed 's/^/  FAIL /'
fi

if [ "$RUN_UI" = 1 ] && [ -d "$WEB_DIR" ]; then
  echo "== 5) UI tests in a real browser (desktop + mobile) – details in staging-ui.log"
  (cd "$WEB_DIR" && npx playwright install chromium > /dev/null 2>&1 || npx playwright install --with-deps chromium > /dev/null 2>&1
   VITE_API_BASE_URL=http://127.0.0.1:$API_PORT/v1/api npx vite build --outDir "$WORK/web" > /dev/null 2>&1) || echo "web build failed"
  (cd "$WEB_DIR" && exec ./node_modules/.bin/vite preview --outDir "$WORK/web" --port "$WEB_PORT" --strictPort > "$WORK-web.log" 2>&1) &
  PIDS+=($!)
  wait_for "http://127.0.0.1:$WEB_PORT" || { tail -20 "$WORK-web.log"; exit 1; }
  (cd "$WEB_DIR" && API_URL=http://127.0.0.1:$API_PORT/v1/api WEB_URL=http://127.0.0.1:$WEB_PORT TEST_DATABASE_URL=$TEST_DB \
     npx playwright test > "$BACKEND/staging-ui.log" 2>&1)
  UI_RESULT=$([ $? = 0 ] && echo PASS || echo FAIL)
  tail -6 "$BACKEND/staging-ui.log"
fi

echo -e "\n==================== STAGING SUMMARY ===================="
echo "API tests: $API_RESULT   (staging-api.log)"
echo "UI tests:  $UI_RESULT   (staging-ui.log, report: $WEB_DIR/playwright-report/index.html)"
[ "$KEEP" = 1 ] && echo "Test database kept: $TEST_DB"
[ "$API_RESULT" != FAIL ] && [ "$UI_RESULT" != FAIL ]
