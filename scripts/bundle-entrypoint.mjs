// Post-process an ncc bundle into dist/<name>.js with LF line endings.
//
// Why: ncc inlines tslib.js verbatim into the bundle. On Windows,
// `node_modules/tslib/tslib.js` is extracted with CRLF line endings by npm,
// so the bundled output has a CRLF block where tslib lives. On Linux/macOS
// the same file is LF. That produces non-deterministic dist/ across
// platforms and trips `Verify dist/ is up to date` in CI.
//
// This script copies dist-<name>/index.js to dist/<name>.js and rewrites
// any CRLF to LF so the result is byte-identical regardless of build host.
//
// Usage: node scripts/bundle-entrypoint.mjs main
//        node scripts/bundle-entrypoint.mjs post

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/bundle-entrypoint.mjs <main|post>");
  process.exit(1);
}

const sourcePath = `dist-${name}/index.js`;
const targetPath = `dist/${name}.js`;
mkdirSync("dist", { recursive: true });

const buf = readFileSync(sourcePath);
// Normalize CRLF -> LF. Standalone CR (without LF) is left alone — ncc bundles
// don't emit lone CRs in practice and we want to fail loudly if they appear
// rather than silently transform.
const normalized = Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
writeFileSync(targetPath, normalized);

console.log(
  `wrote ${targetPath} (${normalized.length} bytes; normalized from ${buf.length} bytes)`,
);
