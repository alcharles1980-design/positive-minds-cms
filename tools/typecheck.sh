#!/usr/bin/env bash
# Real type-check for the edge functions.
#
# WHY THIS EXISTS: `esbuild --outfile` was the pre-deploy check, and esbuild does not resolve
# identifiers or types — it only parses. A handler referencing `who`, which did not exist in that
# scope, compiled cleanly, deployed, and threw "ReferenceError: who is not defined" at the first
# real call. A check that cannot fail on that is not a check.
#
# Deno/jsr specifiers and the Deno global cannot resolve under tsc and are expected; everything else
# is a genuine finding.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=$(npx tsc -p tsconfig.check.json 2>&1 \
  | grep -vE "Cannot find module 'jsr:|Cannot find module 'npm:|Cannot find name 'Deno'|Cannot find module 'https://")
if [ -n "$OUT" ]; then
  echo "$OUT"
  echo
  echo "TYPE CHECK FAILED"
  exit 1
fi
echo "type check clean (edge functions)"
