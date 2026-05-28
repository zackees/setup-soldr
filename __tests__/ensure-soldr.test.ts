import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSoldr, _internal } from "../src/lib/ensure-soldr.js";

// Most of ensure-soldr's logic depends on external HTTP + subprocess, both of
// which we don't want to actually exercise in unit tests. We focus on the
// "module imports & exports the entry point" contract here and on the rest
// indirectly via main.test.ts which mocks ensureSoldr entirely.

test("ensureSoldr is an async function with one argument", () => {
  assert.equal(typeof ensureSoldr, "function");
  assert.equal(ensureSoldr.length, 1);
});

test("copyBundledReleasePayload keeps bundled tools from combined soldr archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-bundle-"));
  try {
    const extract = path.join(root, "extract", "soldr-v0.7.42-x86_64-unknown-linux-gnu");
    const install = path.join(root, "install");
    fs.mkdirSync(extract, { recursive: true });
    fs.mkdirSync(install, { recursive: true });
    for (const name of ["zccache", "zccache-daemon", "zccache-fp", "crgx", "cargo-chef", "manifest.json"]) {
      fs.writeFileSync(path.join(extract, name), name);
    }

    const copied = _internal.copyBundledReleasePayload(extract, install, "soldr");

    assert.deepEqual(copied.sort(), ["cargo-chef", "crgx", "manifest.json", "zccache", "zccache-daemon", "zccache-fp"].sort());
    for (const name of copied) {
      assert.equal(fs.readFileSync(path.join(install, name), "utf8"), name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clearBundledReleasePayload removes stale sibling bundled tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-clear-"));
  try {
    for (const name of ["zccache.exe", "zccache-daemon.exe", "zccache-fp.exe", "crgx.exe", "cargo-chef.exe", "manifest.json"]) {
      fs.writeFileSync(path.join(root, name), "stale");
    }

    _internal.clearBundledReleasePayload(root, "soldr.exe");

    for (const name of ["zccache.exe", "zccache-daemon.exe", "zccache-fp.exe", "crgx.exe", "cargo-chef.exe", "manifest.json"]) {
      assert.equal(fs.existsSync(path.join(root, name)), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasBundledZccachePayload requires the full zccache trio", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-bundle-"));
  try {
    fs.writeFileSync(path.join(root, "zccache.exe"), "zccache");
    fs.writeFileSync(path.join(root, "zccache-daemon.exe"), "zccache-daemon");
    assert.equal(_internal.hasBundledZccachePayload(root, "soldr.exe"), false);

    fs.writeFileSync(path.join(root, "zccache-fp.exe"), "zccache-fp");
    assert.equal(_internal.hasBundledZccachePayload(root, "soldr.exe"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasBundledCargoChefPayload checks the platform cargo-chef binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-chef-"));
  try {
    assert.equal(_internal.hasBundledCargoChefPayload(root, "soldr.exe"), false);
    fs.writeFileSync(path.join(root, "cargo-chef.exe"), "cargo-chef");
    assert.equal(_internal.hasBundledCargoChefPayload(root, "soldr.exe"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("versionAtLeast gates cargo-chef requirement at soldr 0.7.43", () => {
  assert.equal(_internal.versionAtLeast("0.7.42", "0.7.43"), false);
  assert.equal(_internal.versionAtLeast("v0.7.43", "0.7.43"), true);
  assert.equal(_internal.versionAtLeast("0.7.44", "0.7.43"), true);
});

test("ensureSoldr rejects with a clear message for unknown arch (mocked)", async () => {
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    Object.defineProperty(process, "arch", { value: "mips" as NodeJS.Architecture, configurable: true });
    // We expect the underlying detectTarget to throw.
    const resolveResult = {
      soldrPath: "/tmp/soldr-bin/soldr",
      soldrRepo: "zackees/soldr",
      soldrRef: "",
      soldrVersionRequested: "",
      soldrVersionResolved: "v0.7.18",
    } as Parameters<typeof ensureSoldr>[0]["resolveResult"];
    await assert.rejects(
      ensureSoldr({ resolveResult, githubToken: "" }),
      /unsupported architecture/,
    );
  } finally {
    if (originalArch) Object.defineProperty(process, "arch", originalArch);
  }
});
