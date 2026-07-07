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

function tarEntry(name: string, bodyText: string, typeflag = "0"): Buffer {
  const body = Buffer.from(bodyText, "utf8");
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function tarArchive(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

test("extractTarBuffer extracts release files without external tar or zstd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-tar-"));
  try {
    const archive = tarArchive([
      tarEntry("bin/", "", "5"),
      tarEntry("bin/soldr.exe", "soldr"),
      tarEntry("manifest.json", "{}"),
    ]);

    _internal.extractTarBuffer(archive, root);

    assert.equal(fs.readFileSync(path.join(root, "bin", "soldr.exe"), "utf8"), "soldr");
    assert.equal(fs.readFileSync(path.join(root, "manifest.json"), "utf8"), "{}");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractTarBuffer rejects path traversal entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-tar-safe-"));
  try {
    const archive = tarArchive([tarEntry("../escape.txt", "nope")]);

    assert.throws(
      () => _internal.extractTarBuffer(archive, root),
      /unsafe tar entry path/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("copyBundledReleasePayload keeps bundled tools from combined soldr archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-bundle-"));
  try {
    const extract = path.join(root, "extract", "soldr-v0.7.42-x86_64-unknown-linux-gnu");
    const install = path.join(root, "install");
    fs.mkdirSync(extract, { recursive: true });
    fs.mkdirSync(install, { recursive: true });
    for (const name of ["zccache", "zccache-soldr", "zccache-daemon", "zccache-fp", "soldr-daemon", "soldr-shim", "crgx", "cargo-chef", "soldr-clang-shim", "manifest.json"]) {
      fs.writeFileSync(path.join(extract, name), name);
    }

    const copied = _internal.copyBundledReleasePayload(extract, install, "soldr");

    assert.deepEqual(copied.sort(), ["cargo-chef", "crgx", "manifest.json", "soldr-clang-shim", "soldr-daemon", "soldr-shim", "zccache", "zccache-daemon", "zccache-fp", "zccache-soldr"].sort());
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
    for (const name of ["zccache.exe", "zccache-soldr.exe", "zccache-daemon.exe", "zccache-fp.exe", "soldr-daemon.exe", "soldr-shim.exe", "crgx.exe", "cargo-chef.exe", "soldr-clang-shim.exe", "manifest.json"]) {
      fs.writeFileSync(path.join(root, name), "stale");
    }

    _internal.clearBundledReleasePayload(root, "soldr.exe");

    for (const name of ["zccache.exe", "zccache-soldr.exe", "zccache-daemon.exe", "zccache-fp.exe", "soldr-daemon.exe", "soldr-shim.exe", "crgx.exe", "cargo-chef.exe", "soldr-clang-shim.exe", "manifest.json"]) {
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

test("hasEmbeddedZccachePayload requires soldr embedded runtime payload only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-embedded-"));
  try {
    assert.equal(_internal.hasEmbeddedZccachePayload(root, "soldr.exe"), false);

    fs.writeFileSync(path.join(root, "soldr-daemon.exe"), "soldr-daemon");
    assert.equal(_internal.hasEmbeddedZccachePayload(root, "soldr.exe"), false);

    fs.writeFileSync(path.join(root, "soldr-shim.exe"), "soldr-shim");
    assert.equal(_internal.hasEmbeddedZccachePayload(root, "soldr.exe"), true);
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

test("hasBundledClangShimPayload checks the platform soldr-clang-shim binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-shim-"));
  try {
    assert.equal(_internal.hasBundledClangShimPayload(root, "soldr.exe"), false);
    fs.writeFileSync(path.join(root, "soldr-clang-shim.exe"), "soldr-clang-shim");
    assert.equal(_internal.hasBundledClangShimPayload(root, "soldr.exe"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("versionAtLeast gates clang-shim requirement at soldr 0.7.66", () => {
  assert.equal(_internal.versionAtLeast("0.7.65", "0.7.66"), false);
  assert.equal(_internal.versionAtLeast("v0.7.66", "0.7.66"), true);
  assert.equal(_internal.versionAtLeast("0.7.98", "0.7.66"), true);
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
