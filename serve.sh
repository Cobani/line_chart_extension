#!/usr/bin/env bash
# Serves the Line Chart extension on http://localhost:8768 — the URL declared in
# "Line Chart localhost.trex" — and lists Tableau shape palettes for the Format dialog's icon picker.
# Dev preview (no Tableau needed): http://localhost:8768/dev/preview.html
set -euo pipefail
cd "$(dirname "$0")"
exec python3 serve.py
