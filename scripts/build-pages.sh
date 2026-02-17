#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/site-src"
OUT_DIR="$ROOT_DIR/docs"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "error: missing site source at $SRC_DIR" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/claude-flow"

cp "$SRC_DIR/index.html" "$OUT_DIR/index.html"
cp "$SRC_DIR/404.html" "$OUT_DIR/404.html"
cp "$SRC_DIR/CNAME" "$OUT_DIR/CNAME"
cp "$SRC_DIR/claude-flow/index.html" "$OUT_DIR/claude-flow/index.html"
cp "$SRC_DIR/claude-flow/guidance" "$OUT_DIR/claude-flow/guidance"
cp "$SRC_DIR/claude-flow/patch" "$OUT_DIR/claude-flow/patch"

# Ensure GitHub Pages serves static files as-is.
: > "$OUT_DIR/.nojekyll"

echo "Built GitHub Pages output at $OUT_DIR"
find "$OUT_DIR" -maxdepth 3 -type f | sort
