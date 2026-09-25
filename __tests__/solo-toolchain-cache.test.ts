// Tests for src/lib/solo-toolchain-cache.ts.
//
// Covers the pure pieces (key shape, hash determinism, libc detect,
// host triple) and the #525 sealed-toolchain filesystem paths (seal,
// apply, restore, listed-target std check) against real temp dirs,
// without exercising the actual @actions/cache network round trip —
// that's validated end-to-end by .github/workflows/solo-toolchain-probe.yml.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SOLO_KEY_NAMESPACE_ENV,
  applySealedToolchain,
  buildSoloCacheKeys,
  defaultSoloFs,
  detectLibc,
  hashStringArray,
  deleteCorruptSoloCacheEntries,
  restoreSoloCache,
  rustHostTriple,
  saveSoloCache,
  sealToolchainForSave,
  soloCacheEntryExistsForRef,
  soloKeyNamespaceFromEnv,
  soloPathExists,
  toolchainDirName,
  verifyListedTargetStd,
  verifyRestoredToolchain,
  type SoloCacheKeyParts,
  type SoloFs,
} from "../src/lib/solo-toolchain-cache.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

test("hashStringArray is stable across input order", () => {
  assert.equal(
    hashStringArray(["rustfmt", "clippy", "rust-src"]),
    hashStringArray(["clippy", "rust-src", "rustfmt"]),
  );
});

test("hashStringArray returns 'none' for empty inputs", () => {
  assert.equal(hashStringArray([]), "none");
  assert.equal(hashStringArray(["", "  "]), "none");
});

test("verifyRestoredToolchain rejects a restored toolchain with unusable target std", async () => {
  const logs: string[] = [];
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedTargets: ["aarch64-unknown-linux-gnu"],
    channel: "stable",
    rustupCommand: "rustup",
    log: (message) => logs.push(message),
    runRustup: async () => ({ code: 1, stdout: "", stderr: "can't find target library" }),
  });
  assert.equal(result.match, false);
  assert.ok(logs.some((line) => line.includes("target std probe failed")));
});

test("verifyRestoredToolchain accepts a valid target std probe", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedTargets: ["aarch64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
    channel: "stable",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(result.match, true);
});

test("#473 verification pins the requested channel and rejects missing components", async () => {
  const calls: string[][] = [];
  const result = await verifyRestoredToolchain({
    expectedRelease: "1.95.0",
    expectedComponents: ["rustfmt", "clippy"],
    channel: "1.95.0",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async (args) => {
      calls.push(args);
      if (args[0] === "run") return { code: 0, stdout: "rustc 1.95.0 (abc 2026-01-01)\n", stderr: "" };
      return { code: 0, stdout: "rustfmt-x86_64-pc-windows-msvc\n", stderr: "" };
    },
  });
  assert.equal(result.match, false);
  assert.deepEqual(calls[0], ["run", "1.95.0", "rustc", "--version"]);
  assert.deepEqual(calls[1], ["component", "list", "--toolchain", "1.95.0", "--installed"]);
});

test("#473 verification rejects registered components with corrupt executables", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedComponents: ["rustfmt", "clippy"],
    channel: "stable",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async (args) => {
      if (args[0] === "component") {
        return { code: 0, stdout: "rustfmt-host\nclippy-host\n", stderr: "" };
      }
      if (args.includes("clippy-driver")) return { code: 1, stdout: "", stderr: "corrupt" };
      return { code: 0, stdout: "rustfmt 1.95.0\n", stderr: "" };
    },
  });
  assert.equal(result.match, false);
});

test("#473 verification accepts rustup preview aliases in installed output", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedComponents: ["llvm-tools-preview"],
    channel: "stable",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async () => ({
      code: 0,
      stdout: "llvm-tools-x86_64-unknown-linux-gnu\n",
      stderr: "",
    }),
  });
  assert.equal(result.match, true);
});

test("#473 failed poison deletion cannot turn save id=-1 into false repair success", async () => {
  const root = mkTmp("solo-save-id-");
  try {
    const stagingDir = path.join(root, "staged");
    fs.mkdirSync(stagingDir, { recursive: true });
    writeFile(stagingDir, "payload", "ok");
    const archive = path.join(root, "made.tar.zst");
    fs.writeFileSync(archive, "archive");
    const result = await saveSoloCache({
      stagingDir,
      key: "solo-toolchain-v3-repair",
      level: "1",
      debug: false,
      log: () => {},
      cacheArchivePath: path.join(root, "canonical.tar.zst"),
      skipExistingProbe: true,
      compress: async () => ({ archivePath: archive, archiveBytes: 7, inflatedBytes: 2, fileCount: 1, payload: null }),
      saveCache: async () => -1,
    });
    assert.equal(result.status, "failed");
  } finally {
    rmDir(root);
  }
});

test("#473 concurrent repaired writer is accepted only after an exact-key lookup", async () => {
  const root = mkTmp("solo-save-race-");
  try {
    const stagingDir = path.join(root, "staged");
    fs.mkdirSync(stagingDir, { recursive: true });
    writeFile(stagingDir, "payload", "ok");
    const archive = path.join(root, "made.tar.zst");
    fs.writeFileSync(archive, "archive");
    const key = "solo-toolchain-v3-repair";
    const result = await saveSoloCache({
      stagingDir, key, level: "1", debug: false, log: () => {},
      cacheArchivePath: path.join(root, "canonical.tar.zst"),
      skipExistingProbe: true,
      compress: async () => ({ archivePath: archive, archiveBytes: 7, inflatedBytes: 2, fileCount: 1, payload: null }),
      saveCache: async () => -1,
      lookupExactKey: async () => key,
    });
    assert.equal(result.status, "race-precheck-skipped");
  } finally {
    rmDir(root);
  }
});

test("#473 repair-race proof rejects an exact key found only on another ref", async () => {
  const key = "solo-toolchain-v3-cross-ref";
  const exists = await soloCacheEntryExistsForRef({
    owner: "zackees",
    repo: "setup-soldr",
    token: "test-token",
    key,
    ref: "refs/pull/473/merge",
    log: () => {},
    listCaches: async () => [
      { id: 1, key, ref: "refs/heads/main" },
      { id: 2, key: "other", ref: "refs/pull/473/merge" },
    ],
  });
  assert.equal(exists, false);
});

test("hashStringArray is case-insensitive and trims", () => {
  assert.equal(hashStringArray(["RustFmt", "Clippy"]), hashStringArray(["rustfmt", "  clippy  "]));
});

const BASE_KEY_PARTS: SoloCacheKeyParts = {
  runnerOs: "linux",
  runnerArch: "x64",
  libc: "glibc",
  rustcRelease: "1.84.1",
  componentsHash: "deadbeef",
  targetsHash: "cafebabe",
};

test("buildSoloCacheKeys produces stable exact key with all parts", () => {
  const keys = buildSoloCacheKeys(BASE_KEY_PARTS);
  assert.equal(
    keys.exact,
    "solo-toolchain-v4-linux-x64-glibc-rustc1.84.1-cdeadbeef-tcafebabe",
  );
});

test("buildSoloCacheKeys restore-key ladder drops in the documented order", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    componentsHash: "ch",
    targetsHash: "th",
  });
  // 1) drop targets, 2) also drop components
  assert.deepEqual(keys.fallbacks, [
    "solo-toolchain-v4-linux-x64-glibc-rustc1.84.1-cch-t",
    "solo-toolchain-v4-linux-x64-glibc-rustc1.84.1-c",
  ]);
});

test("buildSoloCacheKeys never drops os/arch/libc/release", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "macos",
    runnerArch: "arm64",
    libc: "darwin",
    rustcRelease: "1.83.0",
    componentsHash: "a",
    targetsHash: "b",
  });
  for (const key of [keys.exact, ...keys.fallbacks]) {
    assert.ok(key.includes("-macos-"), `missing os in ${key}`);
    assert.ok(key.includes("-arm64-"), `missing arch in ${key}`);
    assert.ok(key.includes("-darwin-"), `missing libc in ${key}`);
    assert.ok(key.includes("-rustc1.83.0-"), `missing release in ${key}`);
  }
});

test("#525 T3 the key ignores the soldr version", () => {
  const a = buildSoloCacheKeys({ ...BASE_KEY_PARTS, soldrVersion: "0.9.21" } as unknown as SoloCacheKeyParts);
  const b = buildSoloCacheKeys({ ...BASE_KEY_PARTS, soldrVersion: "0.9.22" } as unknown as SoloCacheKeyParts);
  assert.equal(a.exact, b.exact);
  assert.deepEqual(a.fallbacks, b.fallbacks);
  for (const key of [a.exact, ...a.fallbacks, b.exact, ...b.fallbacks]) {
    assert.ok(!key.includes("soldr"), `soldr leaked into ${key}`);
  }
});

test("#525 T3 the key tracks release, components, targets, os, arch and libc", () => {
  const base = buildSoloCacheKeys(BASE_KEY_PARTS).exact;
  const variants: Partial<SoloCacheKeyParts>[] = [
    { rustcRelease: "1.84.2" },
    { componentsHash: "0badf00d" },
    { targetsHash: "feedface" },
    { runnerOs: "macos" },
    { runnerArch: "arm64" },
    { libc: "musl" },
  ];
  for (const change of variants) {
    const changed = buildSoloCacheKeys({ ...BASE_KEY_PARTS, ...change }).exact;
    assert.notEqual(changed, base, `key did not change for ${JSON.stringify(change)}`);
  }
});

test("#525 T3 the test-only namespace scopes the exact key and every fallback", () => {
  const keys = buildSoloCacheKeys({ ...BASE_KEY_PARTS, namespace: "run42" });
  for (const key of [keys.exact, ...keys.fallbacks]) {
    assert.ok(key.startsWith("solo-toolchain-v4-nsrun42-"), `namespace missing in ${key}`);
  }
  assert.equal(
    buildSoloCacheKeys({ ...BASE_KEY_PARTS, namespace: "" }).exact,
    buildSoloCacheKeys(BASE_KEY_PARTS).exact,
  );
  assert.equal(soloKeyNamespaceFromEnv({ [SOLO_KEY_NAMESPACE_ENV]: "a/b c" }), "a_b_c");
  assert.equal(soloKeyNamespaceFromEnv({ [SOLO_KEY_NAMESPACE_ENV]: "   " }), "");
  assert.equal(soloKeyNamespaceFromEnv({}), "");
});

test("rustHostTriple maps runner platform/arch/libc to the rustup host", () => {
  const table: [string, string, string, string | null][] = [
    ["linux", "x64", "glibc", "x86_64-unknown-linux-gnu"],
    ["Linux", "X64", "glibc", "x86_64-unknown-linux-gnu"],
    ["linux", "amd64", "musl", "x86_64-unknown-linux-musl"],
    ["linux", "arm64", "glibc", "aarch64-unknown-linux-gnu"],
    ["Linux", "ARM64", "musl", "aarch64-unknown-linux-musl"],
    ["linux", "aarch64", "glibc", "aarch64-unknown-linux-gnu"],
    ["darwin", "x64", "darwin", "x86_64-apple-darwin"],
    ["macOS", "ARM64", "darwin", "aarch64-apple-darwin"],
    ["win32", "x64", "msvc", "x86_64-pc-windows-msvc"],
    ["Windows", "ARM64", "msvc", "aarch64-pc-windows-msvc"],
    ["freebsd", "x64", "unknown", null],
    ["linux", "riscv64", "glibc", null],
  ];
  for (const [platform, arch, libc, expected] of table) {
    assert.equal(rustHostTriple(platform, arch, libc), expected, `${platform}/${arch}/${libc}`);
  }
  assert.equal(
    toolchainDirName(" 1.84.1 ", "x86_64-unknown-linux-gnu"),
    "1.84.1-x86_64-unknown-linux-gnu",
  );
  // A channel that already names the host is not suffixed twice.
  assert.equal(
    toolchainDirName("stable-x86_64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"),
    "stable-x86_64-unknown-linux-gnu",
  );
});

test("detectLibc returns one of the documented values for this host", () => {
  const v = detectLibc();
  assert.ok(["glibc", "musl", "darwin", "msvc", "unknown"].includes(v));
});

test("#473 corrupt-cache deletion is scoped to the matched key and current ref", async () => {
  const deleted: number[] = [];
  const result = await deleteCorruptSoloCacheEntries({
    owner: "zackees",
    repo: "example",
    token: "test-token",
    key: "solo-toolchain-v3-linux-x64-bad",
    ref: "refs/heads/main",
    log: () => {},
    listCaches: async () => [
      { id: 1, key: "solo-toolchain-v3-linux-x64-bad", ref: "refs/heads/main" },
      { id: 2, key: "solo-toolchain-v3-linux-x64-bad", ref: "refs/pull/1/merge" },
      { id: 3, key: "another-key", ref: "refs/heads/main" },
    ],
    deleteCacheById: async (id) => { deleted.push(id); },
  });
  assert.deepEqual(deleted, [1]);
  assert.deepEqual(result, { found: 1, deleted: 1, failed: 0 });
});

// ---------------------------------------------------------------------------
// #525 sealed toolchain: fixtures and helpers.
// ---------------------------------------------------------------------------

const HOST = "x86_64-unknown-linux-gnu";
const TOOLCHAIN_DIR = `1.84.1-${HOST}`;
const INSTALL_COMPONENTS = "cargo-x86_64-unknown-linux-gnu\nrust-std-x86_64-unknown-linux-gnu\nrustc-x86_64-unknown-linux-gnu\n";

interface FsCall {
  method: string;
  paths: string[];
}

/** Wrap defaultSoloFs so every call records its method and path args. */
function recordingFs(): { sfs: SoloFs; calls: FsCall[] } {
  const calls: FsCall[] = [];
  const d = defaultSoloFs;
  const rec = (method: string, ...paths: string[]): void => {
    calls.push({ method, paths });
  };
  const sfs: SoloFs = {
    stat: (p) => { rec("stat", p); return d.stat(p); },
    lstat: (p) => { rec("lstat", p); return d.lstat(p); },
    readdir: (p) => { rec("readdir", p); return d.readdir(p); },
    readFile: (p) => { rec("readFile", p); return d.readFile(p); },
    readlink: (p) => { rec("readlink", p); return d.readlink(p); },
    mkdir: (p) => { rec("mkdir", p); return d.mkdir(p); },
    copyFile: (src, dst) => { rec("copyFile", src, dst); return d.copyFile(src, dst); },
    symlink: (target, p) => { rec("symlink", target, p); return d.symlink(target, p); },
    link: (src, dst) => { rec("link", src, dst); return d.link(src, dst); },
    rename: (src, dst) => { rec("rename", src, dst); return d.rename(src, dst); },
    rm: (p) => { rec("rm", p); return d.rm(p); },
  };
  return { sfs, calls };
}

function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + path.sep);
}

/** Relative paths (with `/`) of every file and symlink under `root`. */
function listLeaves(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(childRel);
      else out.push(childRel);
    }
  }
  return out.sort();
}

/**
 * Populate `<rustupHome>/toolchains/<dir>` with a minimal toolchain shape.
 * Returns whether a symlink could be created (Windows without developer
 * mode cannot).
 */
function writeToolchain(rustupHome: string, dir: string, extraFiles = 0): boolean {
  const root = path.join(rustupHome, "toolchains", dir);
  writeFile(root, "bin/rustc", `rustc-bytes-${dir}`);
  writeFile(root, "bin/cargo", `cargo-bytes-${dir}`);
  writeFile(root, "lib/rustlib/components", INSTALL_COMPONENTS);
  writeFile(root, `lib/rustlib/${HOST}/lib/libcore-abc.rlib`, "libcore-host");
  writeFile(root, `lib/rustlib/${HOST}/lib/libstd-abc.rlib`, "libstd-host");
  for (let i = 0; i < extraFiles; i += 1) {
    writeFile(root, `share/doc/rust/html/page-${i}.html`, `<p>${i}</p>`);
  }
  try {
    fs.symlinkSync("librustc_driver-abc.so", path.join(root, "lib", "librustc_driver.so"), "file");
    return true;
  } catch {
    return false;
  }
}

function writeProxies(cargoHome: string, content: string): void {
  writeFile(cargoHome, "bin/rustc", `${content}-rustc`);
  writeFile(cargoHome, "bin/cargo", `${content}-cargo`);
}

test("#525 T6 a listed rust-std target without libcore is reported missing", async () => {
  const root = mkTmp("solo-t6-");
  try {
    writeFile(
      root,
      "lib/rustlib/components",
      "rustc-x86_64-unknown-linux-gnu\nrust-std-x86_64-unknown-linux-gnu\nrust-std-aarch64-unknown-linux-gnu\n",
    );
    writeFile(root, "lib/rustlib/x86_64-unknown-linux-gnu/lib/libcore-abc.rlib", "core");
    writeFile(root, "lib/rustlib/aarch64-unknown-linux-gnu/lib/libstd-abc.rlib", "std-only");
    const bad = await verifyListedTargetStd({ toolchainPath: root });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.listed, ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]);
    assert.deepEqual(bad.missing, ["aarch64-unknown-linux-gnu"]);

    writeFile(root, "lib/rustlib/aarch64-unknown-linux-gnu/lib/libcore-def.rlib", "core");
    const good = await verifyListedTargetStd({ toolchainPath: root });
    assert.equal(good.ok, true);
    assert.deepEqual(good.missing, []);
  } finally {
    rmDir(root);
  }
});

test("#525 T6 a toolchain without a components file fails the listed-target check", async () => {
  const root = mkTmp("solo-t6-nocomp-");
  try {
    const result = await verifyListedTargetStd({ toolchainPath: root });
    assert.deepEqual(result, { ok: false, listed: [], missing: ["lib/rustlib/components"] });
  } finally {
    rmDir(root);
  }
});

test("#525 T2 the sealed archive reflects install time, not later job steps (#507)", async () => {
  const root = mkTmp("solo-t2-");
  try {
    const rustupHome = path.join(root, "rustup");
    const cargoHome = path.join(root, "cargo");
    const stagingDir = path.join(root, "setup-soldr-solo-cache", "staged");
    writeToolchain(rustupHome, TOOLCHAIN_DIR);
    writeProxies(cargoHome, "proxy");
    const liveToolchain = path.join(rustupHome, "toolchains", TOOLCHAIN_DIR);
    const liveComponents = path.join(liveToolchain, "lib", "rustlib", "components");
    const installBytes = fs.readFileSync(liveComponents);

    await sealToolchainForSave({
      rustupHome,
      cargoHome,
      toolchainDir: TOOLCHAIN_DIR,
      proxies: ["rustc", "cargo"],
      includeUpdateHash: false,
      stagingDir,
    });

    // A later job step: `rustup target add aarch64-unknown-linux-gnu`
    // mutates the live toolchain in place.
    fs.appendFileSync(liveComponents, "rust-std-aarch64-unknown-linux-gnu\n");
    writeFile(liveToolchain, "lib/rustlib/aarch64-unknown-linux-gnu/lib/libcore-x.rlib", "late");

    const stagedComponents = path.join(stagingDir, "rustup-toolchains", TOOLCHAIN_DIR, "lib", "rustlib", "components");
    assert.deepEqual(fs.readFileSync(stagedComponents), installBytes);
    const aarch64 = listLeaves(stagingDir).filter((rel) => rel.includes("aarch64"));
    assert.deepEqual(aarch64, []);
  } finally {
    rmDir(root);
  }
});

test("#525 T1 sealing touches no unrelated toolchain directory", async () => {
  const root = mkTmp("solo-t1-");
  try {
    const rustupHome = path.join(root, "rustup");
    const cargoHome = path.join(root, "cargo");
    const stagingDir = path.join(root, "setup-soldr-solo-cache", "staged");
    const unrelated = [`stable-${HOST}`, `nightly-${HOST}`, `1.83.0-${HOST}`];
    for (const other of unrelated) writeToolchain(rustupHome, other, 50);
    const hasSymlink = writeToolchain(rustupHome, TOOLCHAIN_DIR);
    writeProxies(cargoHome, "proxy");
    writeFile(rustupHome, `update-hashes/${TOOLCHAIN_DIR}`, "hash");

    const { sfs, calls } = recordingFs();
    const result = await sealToolchainForSave({
      rustupHome,
      cargoHome,
      toolchainDir: TOOLCHAIN_DIR,
      proxies: ["rustc", "cargo", "rustfmt"],
      includeUpdateHash: true,
      stagingDir,
      fs: sfs,
    });

    const toolchainsRoot = path.join(rustupHome, "toolchains");
    for (const call of calls) {
      for (const p of call.paths) {
        for (const other of unrelated) {
          assert.ok(!isUnder(p, path.join(toolchainsRoot, other)), `${call.method} touched unrelated ${p}`);
        }
      }
      assert.ok(
        !(call.method === "readdir" && call.paths[0] === toolchainsRoot),
        "sealing must not list toolchains/",
      );
    }
    const requested = path.join(toolchainsRoot, TOOLCHAIN_DIR);
    assert.ok(calls.some((call) => call.paths.some((p) => isUnder(p, requested))), "requested dir was not sealed");
    assert.equal(result.files, 5);
    assert.equal(result.symlinks, hasSymlink ? 1 : 0);
    assert.equal(result.proxies, 2, "missing rustfmt proxy must be skipped");
    assert.equal(result.updateHash, true);
    assert.ok(result.bytes > 0);
    // Sealing copies; it never hardlinks live toolchain files.
    assert.ok(!calls.some((call) => call.method === "link"), "seal must not hardlink");
  } finally {
    rmDir(root);
  }
});

test("#525 sealToolchainForSave throws when the toolchain dir is missing", async () => {
  const root = mkTmp("solo-seal-missing-");
  try {
    await assert.rejects(
      sealToolchainForSave({
        rustupHome: path.join(root, "rustup"),
        cargoHome: path.join(root, "cargo"),
        toolchainDir: TOOLCHAIN_DIR,
        proxies: [],
        includeUpdateHash: false,
        stagingDir: path.join(root, "staged"),
      }),
      (err: unknown) => err instanceof Error && err.message.includes(TOOLCHAIN_DIR),
    );
  } finally {
    rmDir(root);
  }
});

test("#525 seal + applySealedToolchain round-trips byte-identical and keeps live proxies", async () => {
  const root = mkTmp("solo-roundtrip-");
  try {
    const srcRustup = path.join(root, "src-rustup");
    const srcCargo = path.join(root, "src-cargo");
    const dstRustup = path.join(root, "dst-rustup");
    const dstCargo = path.join(root, "dst-cargo");
    const stagingDir = path.join(root, "setup-soldr-solo-cache", "staged");
    const hasSymlink = writeToolchain(srcRustup, TOOLCHAIN_DIR);
    writeProxies(srcCargo, "sealed");
    writeFile(srcRustup, `update-hashes/${TOOLCHAIN_DIR}`, "hash-bytes");
    // The destination already has a live rustup `cargo` proxy.
    writeFile(dstCargo, "bin/cargo", "live-cargo");

    await sealToolchainForSave({
      rustupHome: srcRustup,
      cargoHome: srcCargo,
      toolchainDir: TOOLCHAIN_DIR,
      proxies: ["rustc", "cargo"],
      includeUpdateHash: true,
      stagingDir,
    });
    const applied = await applySealedToolchain({
      stagedRoot: stagingDir,
      rustupHome: dstRustup,
      cargoHome: dstCargo,
      toolchainDir: TOOLCHAIN_DIR,
    });
    assert.equal(applied.renamed, true);
    assert.equal(applied.proxiesApplied, 1);
    assert.equal(applied.updateHashApplied, true);

    const srcTc = path.join(srcRustup, "toolchains", TOOLCHAIN_DIR);
    const dstTc = path.join(dstRustup, "toolchains", TOOLCHAIN_DIR);
    const leaves = listLeaves(srcTc);
    assert.deepEqual(listLeaves(dstTc), leaves);
    for (const rel of leaves) {
      const s = path.join(srcTc, ...rel.split("/"));
      const d = path.join(dstTc, ...rel.split("/"));
      if (fs.lstatSync(s).isSymbolicLink()) {
        assert.equal(fs.readlinkSync(d), fs.readlinkSync(s), `symlink ${rel}`);
      } else {
        assert.deepEqual(fs.readFileSync(d), fs.readFileSync(s), `bytes of ${rel}`);
      }
    }
    if (hasSymlink) {
      assert.ok(fs.lstatSync(path.join(dstTc, "lib", "librustc_driver.so")).isSymbolicLink());
    }
    assert.equal(fs.readFileSync(path.join(dstCargo, "bin", "cargo"), "utf8"), "live-cargo");
    assert.equal(fs.readFileSync(path.join(dstCargo, "bin", "rustc"), "utf8"), "sealed-rustc");
    assert.equal(
      fs.readFileSync(path.join(dstRustup, "update-hashes", TOOLCHAIN_DIR), "utf8"),
      "hash-bytes",
    );
  } finally {
    rmDir(root);
  }
});

test("#525 applySealedToolchain replaces an existing toolchain dir of the same name", async () => {
  const root = mkTmp("solo-apply-replace-");
  try {
    const srcRustup = path.join(root, "src-rustup");
    const dstRustup = path.join(root, "dst-rustup");
    const stagingDir = path.join(root, "staged");
    writeToolchain(srcRustup, TOOLCHAIN_DIR);
    writeFile(dstRustup, `toolchains/${TOOLCHAIN_DIR}/stale-only`, "stale");
    await sealToolchainForSave({
      rustupHome: srcRustup,
      cargoHome: path.join(root, "cargo"),
      toolchainDir: TOOLCHAIN_DIR,
      proxies: [],
      includeUpdateHash: false,
      stagingDir,
    });
    await applySealedToolchain({
      stagedRoot: stagingDir,
      rustupHome: dstRustup,
      cargoHome: path.join(root, "dst-cargo"),
      toolchainDir: TOOLCHAIN_DIR,
    });
    assert.equal(fs.existsSync(path.join(dstRustup, "toolchains", TOOLCHAIN_DIR, "stale-only")), false);
    assert.ok(fs.existsSync(path.join(dstRustup, "toolchains", TOOLCHAIN_DIR, "bin", "rustc")));
  } finally {
    rmDir(root);
  }
});

test("#525 soloPathExists costs exactly one stat", async () => {
  const root = mkTmp("solo-exists-");
  try {
    const { sfs, calls } = recordingFs();
    assert.equal(await soloPathExists(root, sfs), true);
    assert.equal(await soloPathExists(path.join(root, "toolchains", TOOLCHAIN_DIR), sfs), false);
    assert.deepEqual(calls.map((call) => call.method), ["stat", "stat"]);
  } finally {
    rmDir(root);
  }
});

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]);

test("#525 restoreSoloCache moves the sealed toolchain into place on an exact hit", async () => {
  const root = mkTmp("solo-restore-");
  try {
    const srcRustup = path.join(root, "src-rustup");
    const fixtureStaged = path.join(root, "fixture-staged");
    writeToolchain(srcRustup, TOOLCHAIN_DIR);
    writeProxies(path.join(root, "src-cargo"), "sealed");
    await sealToolchainForSave({
      rustupHome: srcRustup,
      cargoHome: path.join(root, "src-cargo"),
      toolchainDir: TOOLCHAIN_DIR,
      proxies: ["rustc", "cargo"],
      includeUpdateHash: false,
      stagingDir: fixtureStaged,
    });
    const keys = buildSoloCacheKeys(BASE_KEY_PARTS);
    const stagingDir = path.join(root, "runner-temp", "setup-soldr-solo-cache");
    const rustupHome = path.join(root, "rustup");
    const cargoHome = path.join(root, "cargo");
    const logs: string[] = [];
    const result = await restoreSoloCache({
      keys,
      rustupHome,
      cargoHome,
      toolchainDir: TOOLCHAIN_DIR,
      stagingDir,
      log: (msg) => logs.push(msg),
      restoreCache: async (paths, key) => {
        fs.writeFileSync(paths[0] as string, ZSTD_MAGIC);
        return key;
      },
      decompress: async ({ targetDir }) => {
        fs.cpSync(fixtureStaged, targetDir, { recursive: true, verbatimSymlinks: true });
        return { archiveBytes: ZSTD_MAGIC.length, inflatedBytes: 0, fileCount: 0 };
      },
    });
    assert.equal(result.hit, true);
    assert.equal(result.verified, true);
    assert.equal(result.matchedKey, keys.exact);
    assert.equal(
      fs.readFileSync(path.join(rustupHome, "toolchains", TOOLCHAIN_DIR, "bin", "rustc"), "utf8"),
      `rustc-bytes-${TOOLCHAIN_DIR}`,
    );
    assert.equal(fs.readFileSync(path.join(cargoHome, "bin", "rustc"), "utf8"), "sealed-rustc");
    assert.ok(
      logs.some((line) => line.includes(`dir=${TOOLCHAIN_DIR}`) && line.includes("renamed=true")),
      logs.join("\n"),
    );
  } finally {
    rmDir(root);
  }
});

test("#525 restoreSoloCache rejects an archive that holds another toolchain", async () => {
  const root = mkTmp("solo-restore-poison-");
  try {
    const keys = buildSoloCacheKeys(BASE_KEY_PARTS);
    const rustupHome = path.join(root, "rustup");
    const logs: string[] = [];
    const result = await restoreSoloCache({
      keys,
      rustupHome,
      cargoHome: path.join(root, "cargo"),
      toolchainDir: TOOLCHAIN_DIR,
      stagingDir: path.join(root, "setup-soldr-solo-cache"),
      log: (msg) => logs.push(msg),
      restoreCache: async (paths, _key, restoreKeys) => {
        fs.writeFileSync(paths[0] as string, ZSTD_MAGIC);
        return restoreKeys[0];
      },
      decompress: async ({ targetDir }) => {
        writeFile(targetDir, `rustup-toolchains/${TOOLCHAIN_DIR}/bin/rustc`, "x");
        writeFile(targetDir, `rustup-toolchains/stable-${HOST}/bin/rustc`, "y");
        return { archiveBytes: 0, inflatedBytes: 0, fileCount: 0 };
      },
    });
    assert.equal(result.hit, false);
    assert.equal(result.verified, false);
    assert.equal(result.matchedKey, keys.fallbacks[0]);
    assert.ok(logs.some((line) => line.includes(`archive does not hold exactly ${TOOLCHAIN_DIR}`)));
    assert.equal(fs.existsSync(path.join(rustupHome, "toolchains", TOOLCHAIN_DIR)), false);
  } finally {
    rmDir(root);
  }
});
