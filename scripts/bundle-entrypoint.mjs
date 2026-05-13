// Post-process an ncc bundle into dist/<name>.js with deterministic content.
//
// Two normalizations are applied:
//
// 1) CRLF -> LF. ncc inlines tslib.js verbatim into the bundle. On Windows,
//    `node_modules/tslib/tslib.js` is extracted with CRLF line endings by npm,
//    so the bundled output has a CRLF block where tslib lives. On Linux/macOS
//    the same file is LF. Without this normalization dist/ differs across
//    build hosts.
//
// 2) Sort webpack modules by numeric ID. webpack emits modules in discovery
//    order, which depends on filesystem enumeration and module resolution
//    timing. On Windows the same set of modules can appear in a different
//    order than on Linux even when every module ID and body is identical.
//    Sorting the modules by numeric ID makes the output byte-identical
//    across platforms regardless of discovery order. Module IDs are looked
//    up via __nccwpck_require__(id), so reordering within the
//    __webpack_modules__ object is purely cosmetic — runtime behavior is
//    unchanged.
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
const lfText = buf.toString("utf8").replace(/\r\n/g, "\n");

const sortedText = sortWebpackModules(lfText);

const out = Buffer.from(sortedText, "utf8");
writeFileSync(targetPath, out);

console.log(
  `wrote ${targetPath} (${out.length} bytes; normalized from ${buf.length} bytes)`,
);

/**
 * Sort the `var __webpack_modules__ = ({ ... });` block by module ID.
 *
 * Bundle shape produced by ncc/webpack:
 *
 *   /******\/ (() => {
 *   /******\/ 	var __webpack_modules__ = ({
 *
 *   /***\/ 1234:
 *   /***\/ (... module body ...),
 *
 *   /***\/ 5678:
 *   /***\/ (... module body ...)
 *
 *   /******\/ 	});
 *   ...runtime + entry...
 *
 * Inside __webpack_modules__, every module except the last ends with
 * `/***\/ }),` and the last ends with `/***\/ })` (no trailing comma).
 * After sorting we re-apply that punctuation: all-but-last get the comma,
 * last drops it.
 */
function sortWebpackModules(text) {
  const headerEndMarker = "/******/ \tvar __webpack_modules__ = ({\n";
  const footerStartMarker = "\n/******/ \t});\n";

  const headerEnd = text.indexOf(headerEndMarker);
  if (headerEnd === -1) {
    throw new Error(
      `bundle-entrypoint: could not locate __webpack_modules__ header in ${sourcePath}`,
    );
  }
  const modulesStart = headerEnd + headerEndMarker.length;

  const footerStart = text.indexOf(footerStartMarker, modulesStart);
  if (footerStart === -1) {
    throw new Error(
      `bundle-entrypoint: could not locate __webpack_modules__ footer in ${sourcePath}`,
    );
  }

  const header = text.slice(0, modulesStart);
  const modulesBlock = text.slice(modulesStart, footerStart);
  const footer = text.slice(footerStart);

  // Split modules. Each module starts at a line of the form `/***/ <id>:`
  // and continues until just before the next such line (or end of block).
  const moduleHeaderRe = /^\/\*\*\*\/ (\d+):$/gm;
  const matches = [];
  let m;
  while ((m = moduleHeaderRe.exec(modulesBlock)) !== null) {
    matches.push({ id: Number(m[1]), start: m.index });
  }
  if (matches.length === 0) {
    // Nothing to sort; pass through.
    return text;
  }

  const modules = matches.map((match, i) => {
    const end =
      i + 1 < matches.length ? matches[i + 1].start : modulesBlock.length;
    return { id: match.id, body: modulesBlock.slice(match.start, end) };
  });

  // Sanity check: every module body should contain a closing `/***/ })` line.
  for (const mod of modules) {
    if (!/\/\*\*\*\/ \}\)/.test(mod.body)) {
      throw new Error(
        `bundle-entrypoint: module ${mod.id} missing close marker; bundle layout has changed`,
      );
    }
  }

  modules.sort((a, b) => a.id - b.id);

  // Strip trailing whitespace and any `,` after the closing `})` on every
  // module, then reapply: comma on all but the last.
  const normalizedBodies = modules.map((mod) => {
    let body = mod.body.replace(/\s+$/, "");
    body = body.replace(/\/\*\*\*\/ \}\),?\s*$/, "/***/ })");
    return { id: mod.id, body };
  });

  const lastIdx = normalizedBodies.length - 1;
  const reassembledModules = normalizedBodies
    .map((mod, i) => {
      if (i === lastIdx) {
        return `${mod.body}\n`;
      }
      // Anchor the rewrite to end-of-string so we only touch the closing
      // marker, never an incidental `/***/ })` that might appear earlier.
      const withComma = mod.body.replace(/\/\*\*\*\/ \}\)$/, "/***/ }),");
      return `${withComma}\n\n`;
    })
    .join("");

  return `${header}\n${reassembledModules}${footer}`;
}
