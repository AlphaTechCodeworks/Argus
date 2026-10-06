#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
for file in public/css/polish.css public/health-layout.js public/health-layout-model.js public/health-layout.css public/map-layout.css public/map-browser.js public/sites-layout.css public/sites-model.js; do
  test -s "$root/cctv/$file" || { echo "GUI preflight failed: missing $file. Reconcile this publisher checkout before shipping." >&2; exit 1; }
done
grep -q 'enhanceHealth' "$root/cctv/public/health.js"
grep -q 'health-layout.css' "$root/cctv/public/health.html"
grep -q 'map-layout.css' "$root/cctv/public/map.html"
grep -q 'sites-layout.css' "$root/cctv/public/sites.html"
grep -q 'handleTile' "$root/cctv/server.mjs"
echo "GUI release preflight passed" >&2
