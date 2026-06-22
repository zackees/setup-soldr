#!/usr/bin/env node
// Vendor-prose lint for markdown.
//
// Fails when any line in a .md file contains a vendor word
// (apple / mac, case-insensitive) AND the substring "sdk"
// (case-insensitive) on the same line. Vendor-toolchain prose like
// "Apple SDK" / "macOS SDK" / "Mac SDK" / "SDKROOT" must be
// reframed as "per-target toolchain prep" or
// `soldr prepare --target <triple>`.
//
// The Rust target triple identifier `*-apple-darwin` is allowed
// because it never co-occurs with "sdk" on the same line.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXCLUDED_DIR_BASENAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "vendor",
  "zccache",
]);

const VENDOR_RX = /apple|mac/i;
const SDK_RX = /sdk/i;

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_BASENAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      yield full;
    }
  }
}

const offenders = [];
for (const file of walkMarkdown(ROOT)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (VENDOR_RX.test(line) && SDK_RX.test(line)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "vendor-prose lint failed: the following markdown lines pair a vendor word (apple/mac) with 'sdk':",
  );
  console.error("");
  for (const entry of offenders) console.error("  " + entry);
  console.error("");
  console.error(
    "Reframe as per-target toolchain prep or `soldr prepare --target <triple>`.",
  );
  process.exit(1);
}

console.log("vendor-prose lint OK (no apple/mac x sdk pairings in markdown).");
