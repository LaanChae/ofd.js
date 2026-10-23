#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then npm ci --ignore-scripts; fi
npm run build
exec node scripts/serve.mjs "${1:-8080}"
