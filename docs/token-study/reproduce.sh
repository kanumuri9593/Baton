#!/usr/bin/env bash
# Reproduce the Baton token study on Linux or macOS.
#
#   CHROME=/path/to/chrome ./reproduce.sh                        # baton-run 0.2.10, 3 runs
#   RUNS=5 CHROME=/path/to/chrome ./reproduce.sh
#   BATON_VERSION=0.2.9 CHROME=/path/to/chrome ./reproduce.sh    # the 0.2.9 baseline (adds scenario 4)
#
# Needs: Node.js 24+, npm, curl, fuser, and a Chrome/Chromium binary.
# Writes: ./rerun/raw (captured outputs), ./rerun/results.json, ./rerun/results-tables.md,
# so the committed results are left alone. Set OUT to write somewhere else.
# Note: it installs baton-run globally (npm install -g) at the chosen version.
# Uses its own Baton state dir (BATON_HOME), so it does not touch ~/.baton.
# It binds ports 5174-5175, 43121-43122, 43141-43142 and 43150-43151 on 127.0.0.1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HOME/baton-token-study}"
BATON_VERSION="${BATON_VERSION:-0.2.10}"
if [ "$BATON_VERSION" = "0.2.9" ]; then MEASURE="$HERE/harness/measure-0.2.9.mjs"; else MEASURE="$HERE/harness/measure.mjs"; fi
export TOOLS="$WORK/tools" PROJ="$WORK/projects" LAB="$HERE/lab" OUT="${OUT:-$HERE/rerun/raw}"
export RUNS="${RUNS:-3}"
export BATON_HOME="$WORK/baton-home"
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"

node -e 'if (+process.versions.node.split(".")[0] < 24) { console.error("Node 24+ required"); process.exit(1) }'
if [ -z "${CHROME:-}" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null; then CHROME="$(command -v "$c")"; break; fi
  done
fi
: "${CHROME:?set CHROME to a Chrome or Chromium binary}"
export CHROME BATON_CHROME="$CHROME"
# Baton's daemon looks for chromium/google-chrome on PATH; make sure it finds this one.
mkdir -p "$WORK/bin" && ln -sf "$CHROME" "$WORK/bin/chromium" && export PATH="$WORK/bin:$PATH"

echo "== installing pinned tools into $TOOLS"
npm install -g "baton-run@$BATON_VERSION" --no-audit --no-fund
mkdir -p "$TOOLS/pwmcp" "$TOOLS/pw" "$TOOLS/tok"
( cd "$TOOLS/pwmcp" && [ -f package.json ] || npm init -y >/dev/null; cd "$TOOLS/pwmcp" && npm install @playwright/mcp@0.0.82 @modelcontextprotocol/sdk@1.30.0 --no-audit --no-fund )
( cd "$TOOLS/pw" && [ -f package.json ] || npm init -y >/dev/null; cd "$TOOLS/pw" && npm install playwright@1.56.1 --no-audit --no-fund )
cp "$HERE/harness/check.mjs" "$TOOLS/pw/check.mjs"
( cd "$TOOLS/tok" && [ -f package.json ] || npm init -y >/dev/null; cd "$TOOLS/tok" && npm install gpt-tokenizer@3.0.1 @anthropic-ai/tokenizer@0.0.4 --no-audit --no-fund )
if [ ! -d "$TOOLS/web-node_modules" ]; then
  rm -rf "$WORK/web-install" && cp -r "$LAB/web-lab" "$WORK/web-install"
  ( cd "$WORK/web-install" && npm install --no-audit --no-fund )
  mv "$WORK/web-install/node_modules" "$TOOLS/web-node_modules" && rm -rf "$WORK/web-install"
fi

echo "== measuring baton-run $BATON_VERSION ($RUNS runs)"
rm -rf "$OUT" && mkdir -p "$(dirname "$OUT")"
( cd "$WORK" && node "$MEASURE" )

echo "== counting"
TOK="$TOOLS/tok" node "$HERE/harness/count.mjs" "$OUT" > /dev/null
echo "done: $(dirname "$OUT")/results-tables.md"
