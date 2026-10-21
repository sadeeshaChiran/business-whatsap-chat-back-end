#!/usr/bin/env bash
# Full project test – run on the server from the backend folder:
#   bash scripts/full-test.sh            # 1) code tests (no AI cost, no data changed)
#   bash scripts/full-test.sh --live     # 1) + 2) live bot tests (AI cost ~Rs 150-300, needs SALES_BOT_TEST_MODE=true)
#
# Folders (change with env): BOT_DIR=/var/www/business-whatsap-chat-bot  WEB_DIR=/var/www/business-whatsap-chat-front-end
# Client logins for the live client tests: scripts/bot-training/clients/.credentials (not in git), one line per client:
#   chu-lk.json  tharindusuresh88@gmail.com  'the password'
set -u
BOT_DIR=${BOT_DIR:-/var/www/business-whatsap-chat-bot}
WEB_DIR=${WEB_DIR:-/var/www/business-whatsap-chat-front-end}
API_URL=${API_URL:-http://localhost:6001/v1/api}
results=()
run() {   # run "label" command...
  local label=$1; shift
  echo -e "\n==================== $label ===================="
  if "$@"; then results+=("PASS  $label"); else results+=("FAIL  $label"); fi
}

# ---------- 1) code tests ----------
run "API unit tests (jest)" npx jest --silent
run "API type check" npx tsc --noEmit -p tsconfig.build.json
# the bot's own Python (its virtualenv has numpy, google-genai …); pytest is installed there once if missing
PY=python3
for p in "$BOT_DIR/.venv/bin/python" "$BOT_DIR/venv/bin/python" "$BOT_DIR/env/bin/python"; do [ -x "$p" ] && PY=$p && break; done
if [ -d "$BOT_DIR" ]; then
  "$PY" -c "import pytest" 2>/dev/null || "$PY" -m pip install -q pytest 2>/dev/null || "$PY" -m pip install -q --break-system-packages pytest
  run "Bot unit tests (pytest)" bash -c "cd '$BOT_DIR' && '$PY' -m pytest -q"
  run "Bot guard checks" bash -c "cd '$BOT_DIR' && GEMINI_API_KEY=test '$PY' tests/test_quality_guards.py"
fi
if [ -d "$WEB_DIR" ]; then
  run "Web app type check" bash -c "cd '$WEB_DIR' && npx tsc -b"
fi
for f in scripts/bot-training/clients/*.json; do
  run "Training file valid: $(basename "$f")" bash -c "node scripts/bot-training/make-training.mjs '$f' > /dev/null"
done

# ---------- 2) live bot tests ----------
if [ "${1:-}" = "--live" ]; then
  run "Bot health" bash -c "curl -sf \"\${SALES_BOT_URL:-http://127.0.0.1:6002}/health\" > /dev/null"
  run "Scale test (6 test shops)" bash -c "set -o pipefail; API_URL=$API_URL node scripts/scale-test.mjs | tee scale-test.log | tail -3"
  creds=scripts/bot-training/clients/.credentials
  if [ -f "$creds" ]; then
    while read -r file email password; do
      [ -z "${file:-}" ] && continue
      password=${password//\'/}
      run "Client test: $file" bash -c "set -o pipefail; API_URL=$API_URL CLIENT_EMAIL='$email' CLIENT_PASSWORD='$password' node scripts/client-test.mjs scripts/bot-training/clients/$file | tee client-test-${file%.json}.log | tail -3"
    done < "$creds"
  else
    echo "(no $creds – client tests skipped)"
  fi
fi

echo -e "\n==================== SUMMARY ===================="
printf '%s\n' "${results[@]}"
! printf '%s\n' "${results[@]}" | grep -q '^FAIL'
