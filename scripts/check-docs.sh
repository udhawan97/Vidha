#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

python3 scripts/check_docs.py
git diff --check

echo "Repository documentation checks passed."
