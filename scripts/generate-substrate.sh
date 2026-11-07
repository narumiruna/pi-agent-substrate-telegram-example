#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --check ) ]]; then
  printf 'Usage: %s [--check]\n' "$0" >&2
  exit 2
fi

# All input sources are vendored at full commit pins. See vendor/substrate/NOTICE.
(cd vendor/substrate && sha256sum --check SHA256SUMS)
node --input-type=module -e '
  import { readFileSync } from "node:fs"
  for (const [name, expected] of [["ts-proto", "2.18.4"], ["grpc-tools", "1.13.1"]]) {
    const { version } = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8"))
    if (version !== expected) throw new Error(`${name}: expected ${expected}, got ${version}; run npm ci`)
  }
'

temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
output="$root/src/substrate/generated"

# Override grpc-tools' old Google protos so debug_redact remains unmodified.
# Keep timestamps as seconds/nanos and every int64 as bigint, without rounding.
node_modules/.bin/grpc_tools_node_protoc \
  --proto_path=vendor/substrate/api \
  --proto_path=vendor/substrate \
  --plugin="protoc-gen-ts_proto=$root/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$temporary" \
  --ts_proto_opt=outputServices=grpc-js,forceLong=bigint,env=node,importSuffix=.js,useDate=false,emitImportedFiles=false,outputJsonMethods=false \
  ateapi/v1/ateapi.proto google/protobuf/timestamp.proto

if [[ ${1:-} == --check ]]; then
  diff --recursive --unified -- "$output" "$temporary"
else
  rm -rf -- "$output"
  mkdir -p -- "$output"
  cp -R -- "$temporary/." "$output/"
fi
