#!/usr/bin/env bash
# Builds ONE file with the full data update (2026-10-24) and checks every training file first.
#
#   bash scripts/make-final-data.sh > final-data-update.sql
#   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f final-data-update.sql
#
# What it does, in order (safe to run again):
#   00  sync id sequences (only moves them forward)
#   01  delete every company except VORA, Chu.lk and Agent Metra; delete 999 test customers in VORA and Chu.lk
#   02  Agent Metra account (agentmetra@gmail.com) + 7 industry demo companies with products
#   03  bot training: Chu.lk, VORA, Agent Metra and the 7 demos (settings, zones, services, policies, styles, FAQs)
# Password for agentmetra@gmail.com and every @demo.test login: DEMO_PASSWORD (default 12345678).
set -euo pipefail
cd "$(dirname "$0")/.."

CLIENTS=(chu-lk vora agentmetra novagadgets brightpath glowandgo spiceroute islandtrails goldenvows apexsolar)

echo "-- Agent Metra full data update – generated $(date -u +%Y-%m-%dT%H:%MZ) by scripts/make-final-data.sh"
echo "-- Run: psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f final-data-update.sql"
echo
echo "-- ═════════ 00 sync sequences ═════════"
cat scripts/data/00-sync-sequences.sql
echo
echo "-- ═════════ 01 cleanup ═════════"
cat scripts/data/01-cleanup-keep-vora-chulk.sql
echo
echo "-- ═════════ 02 Agent Metra + industry demo companies ═════════"
python3 scripts/make-industry-demos.py
for c in "${CLIENTS[@]}"; do
  echo
  echo "-- ═════════ 03 training: $c ═════════"
  node scripts/bot-training/make-training.mjs "scripts/bot-training/clients/$c.json"
done
