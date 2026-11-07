#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

npm run ci
bash scripts/generate-substrate.sh --check
