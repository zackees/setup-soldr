import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  cargoConfigHash,
  normalizeBuildCacheMode,
  normalizeLegacyTargetCacheMode,
  normalizeTargetCacheBool,
  normalizeTargetCacheCompress,
  normalizeTargetCacheCompressLevel,
  normalizeTargetCacheProfile,
  pathForOutput,
  resolveLockfilePath,
  sanitizeFragment,
  setupCacheLayout,
  setupCachePaths,
  shortFileHash,
  shortJsonHash,
  targetCacheSoftBudget,
  targetEnvHash,
  workspaceManifestHash,
} from "../src/lib/cache-keys.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("canonicalJsonStringify sorts keys recursively, compact separators", () => {
  const out = canonicalJsonStringify({ b: 1, a: { y: 2, x: [3, 1] }, c: null });
  assert.equal(out, '{"a":{"x":[3,1],"y":2},"b":1,"c":null}');
});

test("canonicalJsonStringify booleans", () => {
  assert.equal(canonicalJsonStringify({ b: false, a: true }), '{"a":true,"b":false}');
});

test("shortJsonHash matches Python sha256 first-16-hex over compact JSON", () => {
  const data = { name: "value", arr: [1, 2] };
  const compact = '{"arr":[1,2],"name":"value"}';
  const expected = createHash("sha256").update(compact, "utf8").digest("hex").slice(0, 16);
  assert.equal(shortJsonHash(data), expected);
});

test("shortJsonHash empty dict matches Python", () => {
  // Python: hashlib.sha256(b"{}").hexdigest()[:16] => "44136fa355b3678a"
  assert.equal(shortJsonHash({}), "44136fa355b3678a");
});

test("shortFileHash returns missing sentinel for absent file", async () => {
  const tmp = mkTmp("cache-keys-");
  const result = await shortFileHash(path.join(tmp, "nope"), "MISS");
  assert.equal(result, "MISS");
});

test("shortFileHash hashes file contents", async () => {
  const tmp = mkTmp("cache-keys-");
  const f = path.join(tmp, "data.txt");
  fs.writeFileSync(f, "hello", "utf8");
  const expected = createHash("sha256").update("hello").digest("hex").slice(0, 16);
  assert.equal(await shortFileHash(f, "no"), expected);
});

test("sanitizeFragment replaces invalid runs with single dash", () => {
  assert.equal(sanitizeFragment("foo/bar baz"), "foo-bar-baz");
});

test("sanitizeFragment strips leading/trailing dashes", () => {
  assert.equal(sanitizeFragment("//foo//"), "foo");
});

test("sanitizeFragment empty falls back to 'default'", () => {
  assert.equal(sanitizeFragment(""), "default");
  assert.equal(sanitizeFragment("/////"), "default");
});

test("sanitizeFragment preserves valid chars including .", () => {
  assert.equal(sanitizeFragment("1.2.3-alpha_4"), "1.2.3-alpha_4");
});

test("normalizeTargetCacheProfile defaults to thin-v1", () => {
  assert.equal(normalizeTargetCacheProfile(""), "thin-v1");
});

test("normalizeTargetCacheProfile accepts thin-v2", () => {
  assert.equal(normalizeTargetCacheProfile(" THIN-V2 "), "thin-v2");
});

test("normalizeTargetCacheProfile rejects unknown", () => {
  assert.throws(() => normalizeTargetCacheProfile("fat"));
});

test("normalizeTargetCacheBool truthy aliases", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE", " On "]) {
    assert.equal(normalizeTargetCacheBool("input", v), "true", `for ${v}`);
  }
});

test("normalizeTargetCacheBool falsy aliases", () => {
  for (const v of ["false", "0", "no", "off", "FALSE", " Off "]) {
    assert.equal(normalizeTargetCacheBool("input", v), "false", `for ${v}`);
  }
});

test("normalizeTargetCacheBool empty returns null", () => {
  assert.equal(normalizeTargetCacheBool("input", ""), null);
  assert.equal(normalizeTargetCacheBool("input", "   "), null);
});

test("normalizeTargetCacheBool rejects unknown with the input name in error", () => {
  assert.throws(() => normalizeTargetCacheBool("target-cache-x", "maybe"), /invalid target-cache-x/);
});

test("normalizeLegacyTargetCacheMode hot becomes thin with deprecation log", () => {
  const logs: string[] = [];
  assert.equal(normalizeLegacyTargetCacheMode("hot", (m) => logs.push(m)), "thin");
  assert.match(logs[0] ?? "", /'hot' is deprecated/);
});

test("normalizeLegacyTargetCacheMode pass-through for thin/full/off", () => {
  assert.equal(normalizeLegacyTargetCacheMode("thin"), "thin");
  assert.equal(normalizeLegacyTargetCacheMode("full"), "full");
  assert.equal(normalizeLegacyTargetCacheMode("off"), "off");
});

test("normalizeLegacyTargetCacheMode rejects unknown", () => {
  assert.throws(() => normalizeLegacyTargetCacheMode("warm"));
});

test("normalizeBuildCacheMode defaults to 'once' when empty + no legacy", () => {
  assert.equal(normalizeBuildCacheMode("", "", true), "once");
});

test("normalizeBuildCacheMode translates legacy hot -> thin", () => {
  const logs: string[] = [];
  assert.equal(normalizeBuildCacheMode("", "hot", true, (m) => logs.push(m)), "thin");
});

test("normalizeBuildCacheMode does not translate when explicit value present", () => {
  assert.equal(normalizeBuildCacheMode("once", "thin", true), "once");
});

test("normalizeBuildCacheMode rejects unknown value", () => {
  assert.throws(() => normalizeBuildCacheMode("wide", "", true));
});

test("normalizeTargetCacheCompress defaults to zstd", () => {
  assert.equal(normalizeTargetCacheCompress(""), "zstd");
});

test("normalizeTargetCacheCompress accepts auto/zstd/none case-insensitive", () => {
  assert.equal(normalizeTargetCacheCompress(" AUTO "), "auto");
  assert.equal(normalizeTargetCacheCompress("ZSTD"), "zstd");
  assert.equal(normalizeTargetCacheCompress("none"), "none");
});

test("normalizeTargetCacheCompress rejects unknown", () => {
  assert.throws(() => normalizeTargetCacheCompress("lz4"), /invalid target-cache-compress/);
});

test("normalizeTargetCacheCompressLevel defaults to 3", () => {
  assert.equal(normalizeTargetCacheCompressLevel(""), "3");
});

test("normalizeTargetCacheCompressLevel passes valid range, drops + sign", () => {
  assert.equal(normalizeTargetCacheCompressLevel("1"), "1");
  assert.equal(normalizeTargetCacheCompressLevel("9"), "9");
  assert.equal(normalizeTargetCacheCompressLevel("22"), "22");
});

test("normalizeTargetCacheCompressLevel rejects non-integer", () => {
  assert.throws(() => normalizeTargetCacheCompressLevel("fast"));
});

test("normalizeTargetCacheCompressLevel rejects out of range", () => {
  for (const v of ["0", "23", "-1", "100"]) {
    assert.throws(() => normalizeTargetCacheCompressLevel(v), `for ${v}`);
  }
});

test("targetCacheSoftBudget returns empties when disabled", () => {
  assert.deepEqual(targetCacheSoftBudget(false, "once"), ["", ""]);
});

test("targetCacheSoftBudget returns mode-specific budgets", () => {
  assert.deepEqual(targetCacheSoftBudget(true, "once"), ["1073741824", "8000"]);
  assert.deepEqual(targetCacheSoftBudget(true, "thin"), ["536870912", "4000"]);
  assert.deepEqual(targetCacheSoftBudget(true, "full"), ["2147483648", "12000"]);
});

test("workspaceManifestHash returns no-manifest for empty workspace", async () => {
  const tmp = mkTmp("ws-");
  assert.equal(await workspaceManifestHash(tmp), "no-manifest");
});

test("workspaceManifestHash hashes a single Cargo.toml", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "[package]\nname = 'x'\n", "utf8");
  const h1 = await workspaceManifestHash(tmp);
  assert.match(h1, /^[0-9a-f]{16}$/);
  // identical run = identical hash
  assert.equal(await workspaceManifestHash(tmp), h1);
});

test("workspaceManifestHash changes when manifest content changes", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "v1", "utf8");
  const a = await workspaceManifestHash(tmp);
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "v2", "utf8");
  const b = await workspaceManifestHash(tmp);
  assert.notEqual(a, b);
});

test("workspaceManifestHash ignores .git/target/.soldr/node_modules", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "root", "utf8");
  const before = await workspaceManifestHash(tmp);
  for (const ignored of [".git", "target", ".soldr", "node_modules"]) {
    fs.mkdirSync(path.join(tmp, ignored), { recursive: true });
    fs.writeFileSync(path.join(tmp, ignored, "Cargo.toml"), "ignored", "utf8");
  }
  assert.equal(await workspaceManifestHash(tmp), before);
});

test("workspaceManifestHash includes nested non-ignored manifests", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "root", "utf8");
  fs.mkdirSync(path.join(tmp, "crates", "sub"), { recursive: true });
  const before = await workspaceManifestHash(tmp);
  fs.writeFileSync(path.join(tmp, "crates", "sub", "Cargo.toml"), "sub", "utf8");
  const after = await workspaceManifestHash(tmp);
  assert.notEqual(before, after);
});

test("cargoConfigHash returns no-config when neither config file exists", async () => {
  const tmp = mkTmp("ws-");
  assert.equal(await cargoConfigHash(tmp), "no-config");
});

test("cargoConfigHash hashes .cargo/config.toml when present", async () => {
  const tmp = mkTmp("ws-");
  fs.mkdirSync(path.join(tmp, ".cargo"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".cargo", "config.toml"), "[net]\n", "utf8");
  const h = await cargoConfigHash(tmp);
  assert.match(h, /^[0-9a-f]{16}$/);
});

test("targetEnvHash deterministic across irrelevant env", () => {
  const a = targetEnvHash({ FOO: "bar", RUSTFLAGS: "-C debuginfo=0" });
  const b = targetEnvHash({ RUSTFLAGS: "-C debuginfo=0", OTHER: "x" });
  assert.equal(a, b);
});

test("targetEnvHash includes CARGO_TARGET_<triple>_RUSTFLAGS", () => {
  const a = targetEnvHash({});
  const b = targetEnvHash({ CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-O" });
  assert.notEqual(a, b);
});

test("resolveLockfilePath prefers explicit relative input", () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "custom.lock"), "x", "utf8");
  const resolved = resolveLockfilePath(tmp, path.join(tmp, "target"), "custom.lock");
  assert.equal(resolved, path.resolve(path.join(tmp, "custom.lock")));
});

test("resolveLockfilePath falls back to workspace Cargo.lock", () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.lock"), "x", "utf8");
  const resolved = resolveLockfilePath(tmp, path.join(tmp, "target"), "");
  assert.equal(resolved, path.resolve(path.join(tmp, "Cargo.lock")));
});

test("setupCachePaths includes rustup files when rustupHome inside setupCachePath", () => {
  const setupCachePath = "/tmp/setup-soldr";
  const out = setupCachePaths(
    setupCachePath,
    "/tmp/setup-soldr/bin",
    "/tmp/setup-soldr-soldr/bin",
    "/tmp/setup-soldr/rustup-home",
  );
  const lines = out.split("\n");
  assert.ok(lines.some((l) => l.endsWith("settings.toml")));
  assert.ok(lines.some((l) => l.endsWith("toolchains")));
  assert.ok(lines.some((l) => l.endsWith("update-hashes")));
});

test("setupCachePaths omits rustup files when rustupHome outside setupCachePath", () => {
  const out = setupCachePaths(
    "/tmp/setup-soldr",
    "/tmp/setup-soldr/bin",
    "/tmp/setup-soldr-soldr/bin",
    "/home/runner/.rustup",
  );
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
});

test("setupCacheLayout reports bin+soldr-bin when rustup outside", () => {
  assert.equal(setupCacheLayout("/tmp/sc", "/home/r/.rustup"), "bin+soldr-bin");
});

test("setupCacheLayout reports bin+soldr-bin+rustup when rustup inside", () => {
  assert.equal(setupCacheLayout("/tmp/sc", "/tmp/sc/rustup-home"), "bin+soldr-bin+rustup");
});

test("pathForOutput returns workspace-relative path when inside workspace", () => {
  const ws = path.resolve(os.tmpdir(), "ws");
  fs.mkdirSync(ws, { recursive: true });
  const inside = path.join(ws, "Cargo.lock");
  assert.equal(pathForOutput(ws, inside), "Cargo.lock");
});

test("pathForOutput returns absolute path when outside workspace", () => {
  const outside = path.resolve("/tmp/somewhere-else");
  assert.equal(pathForOutput(path.resolve("/tmp/ws"), outside), outside);
});

test("pathForOutput returns empty string when null", () => {
  assert.equal(pathForOutput("/ws", null), "");
});
