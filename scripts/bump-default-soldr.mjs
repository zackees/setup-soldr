// Bump the vendor-locked default soldr release in lockstep:
//   src/lib/default-soldr-version.ts  (DEFAULT_SOLDR_VERSION, compiled into dist/)
//   action.yml                        (inputs.version.default)
// Usage: node scripts/bump-default-soldr.mjs 0.9.26
// Prints "unchanged" or "bumped <old> -> <new>". Rebuild dist/ afterwards.
import { readFileSync, writeFileSync } from "node:fs";

const next = (process.argv[2] ?? "").trim().replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`expected X.Y.Z, got ${process.argv[2] ?? "(nothing)"}`);

const srcPath = "src/lib/default-soldr-version.ts";
const src = readFileSync(srcPath, "utf8");
const constRe = /export const DEFAULT_SOLDR_VERSION = "([^"]+)";/;
const current = src.match(constRe)?.[1];
if (!current) throw new Error(`DEFAULT_SOLDR_VERSION not found in ${srcPath}`);
if (current === next) {
  console.log("unchanged");
  process.exit(0);
}
const newer = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
};
if (!newer(next, current) && process.env.ALLOW_DOWNGRADE !== "1") {
  throw new Error(`refusing to move default ${current} -> ${next} (older); set ALLOW_DOWNGRADE=1`);
}
writeFileSync(srcPath, src.replace(constRe, `export const DEFAULT_SOLDR_VERSION = "${next}";`));

const actionPath = "action.yml";
const action = readFileSync(actionPath, "utf8");
const defaultRe = /(^  version:\r?\n[\s\S]*?^    default:\s*)["']?[^"'\r\n]+["']?([ \t]*)$/m;
if (!defaultRe.test(action)) throw new Error("inputs.version.default not found in action.yml");
writeFileSync(actionPath, action.replace(defaultRe, `$1"${next}"$2`));
console.log(`bumped ${current} -> ${next}`);
