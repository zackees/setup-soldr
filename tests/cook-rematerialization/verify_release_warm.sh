#!/usr/bin/env bash
set -euo pipefail

fixture=/repo/_vender/soldr/tests/fixtures/cook-rematerialization
workspace=/workspace
rm -rf "$workspace" /root/.cargo/registry /root/.cargo/git
find /root/.soldr -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
mkdir -p "$workspace" /root/.cargo
cp -a "$fixture/." "$workspace/"
cd "$workspace"

soldr hydrate --archive /artifact/cargo-registry.tar.zst --cache-dir /root/.cargo/registry --json
soldr hydrate --archive /artifact/cook.tar.zst --cache-dir target --workspace "$workspace" --json
test -n "$(find target/release/build -type f -name 'build-script-build*' -print -quit)"

started_ns="$(date +%s%N)"
ZCCACHE_DISABLE=1 soldr cargo build --release --locked -vv \
  --message-format=json-render-diagnostics \
  > /artifact/warm-messages.jsonl \
  2> /artifact/warm-stderr.log
finished_ns="$(date +%s%N)"
warm_ms="$(( (finished_ns - started_ns) / 1000000 ))"
printf '%s\n' "$warm_ms" > /artifact/warm-ms.txt
printf '%s\n' "$warm_ms" >> /artifact/warm-samples.txt
test "$(target/release/cook-rematerialization-fixture)" = '{"value":42}'
python3 /repo/tests/cook-rematerialization/assert_warm.py \
  /artifact/warm-messages.jsonl \
  /artifact/warm-stderr.log \
  /artifact/seed-ms.txt \
  /artifact/warm-ms.txt \
  /artifact/warm-samples.txt \
  /artifact/warm-report.json
