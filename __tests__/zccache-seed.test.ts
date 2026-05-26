import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as exec from "@actions/exec";
import {
  detectHostZccacheTarget,
  findVendoredZccacheDir,
  managedReleaseUrl,
  seedZccache,
} from "../src/lib/zccache-seed.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeZccacheDir(dir: string, binaryExt: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const stem of ["zccache", "zccache-daemon", "zccache-fp"]) {
    fs.writeFileSync(path.join(dir, `${stem}${binaryExt}`), "fake");
  }
}

function makeExec(
  calls: Array<{ cmd: string; args: string[] }>,
  statusPayload: Record<string, unknown>,
  installCode = 0,
): typeof exec.exec {
  return (async (cmd: string, args: string[] = [], options?: exec.ExecOptions): Promise<number> => {
    calls.push({ cmd, args });
    if (args[0] === "install-zccache" && args.includes("--status")) {
      options?.listeners?.stdout?.(Buffer.from(JSON.stringify(statusPayload)));
      return 0;
    }
    if (args[0] === "install-zccache") {
      if (installCode !== 0) {
        options?.listeners?.stderr?.(Buffer.from("install failed"));
      }
      return installCode;
    }
    return 1;
  }) as typeof exec.exec;
}

test("managedReleaseUrl uses zccache release asset naming", () => {
  assert.equal(
    managedReleaseUrl("1.11.2", {
      target: "x86_64-unknown-linux-gnu",
      archiveTarget: "x86_64-unknown-linux-musl",
      binaryExt: "",
      archiveExt: "tar.gz",
    }),
    "https://github.com/zackees/zccache/releases/download/1.11.2/zccache-v1.11.2-x86_64-unknown-linux-musl.tar.gz",
  );
});

test("detectHostZccacheTarget maps supported runner triples", () => {
  assert.deepEqual(detectHostZccacheTarget("linux", "x64"), {
    target: "x86_64-unknown-linux-gnu",
    archiveTarget: "x86_64-unknown-linux-musl",
    binaryExt: "",
    archiveExt: "tar.gz",
  });
  assert.deepEqual(detectHostZccacheTarget("darwin", "arm64"), {
    target: "aarch64-apple-darwin",
    archiveTarget: "aarch64-apple-darwin",
    binaryExt: "",
    archiveExt: "tar.gz",
  });
  assert.deepEqual(detectHostZccacheTarget("win32", "x64"), {
    target: "x86_64-pc-windows-msvc",
    archiveTarget: "x86_64-pc-windows-msvc",
    binaryExt: ".exe",
    archiveExt: "zip",
  });
});

test("findVendoredZccacheDir accepts per-target vendor directory", () => {
  const root = mkTmp("zccache-vendor-");
  try {
    const target = detectHostZccacheTarget();
    const vendorDir = path.join(root, "vendor", "zccache", target.archiveTarget);
    writeFakeZccacheDir(vendorDir, target.binaryExt);

    assert.equal(findVendoredZccacheDir({ actionRoot: root, target }), vendorDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache installs vendored zccache when present", async () => {
  const root = mkTmp("zccache-seed-vendor-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const target = detectHostZccacheTarget();
  const vendorDir = path.join(root, "vendor", "zccache", target.archiveTarget, "bin");
  writeFakeZccacheDir(vendorDir, target.binaryExt);
  try {
    await seedZccache({
      soldrPath: "soldr",
      actionRoot: root,
      enabled: true,
      strict: false,
      log: () => undefined,
      warn: (msg) => assert.fail(msg),
      execFn: makeExec(calls, {
        command: "install-zccache --status",
        managed_version: "1.11.2",
        pinned: null,
      }),
      env: {},
    });

    assert.deepEqual(calls.map((call) => call.args), [
      ["install-zccache", "--status", "--json"],
      ["install-zccache", vendorDir, "--json"],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache falls back to managed release URL when no vendor exists", async () => {
  const root = mkTmp("zccache-seed-release-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const downloads: string[] = [];
  try {
    const target = detectHostZccacheTarget();
    const archivePath = path.join(root, `downloaded-zccache.${target.archiveExt}`);
    await seedZccache({
      soldrPath: "soldr",
      actionRoot: root,
      enabled: true,
      strict: false,
      log: () => undefined,
      warn: (msg) => assert.fail(msg),
      execFn: makeExec(calls, {
        command: "install-zccache --status",
        managed_version: "1.11.2",
        pinned: null,
      }),
      downloadFn: async (url) => {
        downloads.push(url);
        return archivePath;
      },
      env: {},
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.args, ["install-zccache", "--status", "--json"]);
    assert.equal(downloads.length, 1);
    assert.match(downloads[0] ?? "", /^https:\/\/github\.com\/zackees\/zccache\/releases\/download\/1\.11\.2\/zccache-v1\.11\.2-/);
    assert.equal(calls[1]?.args[0], "install-zccache");
    assert.equal(calls[1]?.args[1], archivePath);
    assert.equal(calls[1]?.args[2], "--json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache fails when managed zccache version cannot be resolved", async () => {
  const root = mkTmp("zccache-seed-missing-version-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  try {
    await assert.rejects(
      seedZccache({
        soldrPath: "soldr",
        actionRoot: root,
        enabled: true,
        strict: true,
        log: () => undefined,
        warn: (msg) => assert.fail(msg),
        execFn: makeExec(calls, {}),
        env: {},
      }),
      /zccache seed failed: could not determine managed zccache version/,
    );
    assert.deepEqual(calls.map((call) => call.args), [["install-zccache", "--status", "--json"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache fails instead of allowing a later cargo-install fallback", async () => {
  const root = mkTmp("zccache-seed-install-fail-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const target = detectHostZccacheTarget();
  const vendorDir = path.join(root, "vendor", "zccache", target.archiveTarget);
  writeFakeZccacheDir(vendorDir, target.binaryExt);
  try {
    await assert.rejects(
      seedZccache({
        soldrPath: "soldr",
        actionRoot: root,
        enabled: true,
        strict: true,
        log: () => undefined,
        warn: (msg) => assert.fail(msg),
        execFn: makeExec(
          calls,
          {
            command: "install-zccache --status",
            managed_version: "1.11.2",
            pinned: null,
          },
          1,
        ),
        env: {},
      }),
      /refusing to continue because later isolated SOLDR_CACHE_DIR roots would fall back to cargo-installing zccache: install failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache warns on install failure when strict mode is disabled", async () => {
  const root = mkTmp("zccache-seed-install-warn-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const warnings: string[] = [];
  const target = detectHostZccacheTarget();
  const vendorDir = path.join(root, "vendor", "zccache", target.archiveTarget);
  writeFakeZccacheDir(vendorDir, target.binaryExt);
  try {
    await seedZccache({
      soldrPath: "soldr",
      actionRoot: root,
      enabled: true,
      strict: false,
      log: () => undefined,
      warn: (msg) => warnings.push(msg),
      execFn: makeExec(
        calls,
        {
          command: "install-zccache --status",
          managed_version: "1.11.2",
          pinned: null,
        },
        1,
      ),
      env: {},
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /later isolated SOLDR_CACHE_DIR roots may fetch zccache again: install failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache fails when strict managed release download cannot complete", async () => {
  const root = mkTmp("zccache-seed-download-fail-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  try {
    await assert.rejects(
      seedZccache({
        soldrPath: "soldr",
        actionRoot: root,
        enabled: true,
        strict: true,
        log: () => undefined,
        warn: (msg) => assert.fail(msg),
        execFn: makeExec(calls, {
          command: "install-zccache --status",
          managed_version: "1.11.2",
          pinned: null,
        }),
        downloadFn: async () => {
          throw new Error("release missing");
        },
        env: {},
      }),
      /managed zccache release could not be downloaded.*release missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache warns when non-strict managed release download cannot complete", async () => {
  const root = mkTmp("zccache-seed-download-warn-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const warnings: string[] = [];
  try {
    await seedZccache({
      soldrPath: "soldr",
      actionRoot: root,
      enabled: true,
      strict: false,
      log: () => undefined,
      warn: (msg) => warnings.push(msg),
      execFn: makeExec(calls, {
        command: "install-zccache --status",
        managed_version: "1.11.2",
        pinned: null,
      }),
      downloadFn: async () => {
        throw new Error("release missing");
      },
      env: {},
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /managed zccache release could not be downloaded/);
    assert.match(warnings[0] ?? "", /may fetch zccache again: release missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache skips when an up-to-date pin already exists", async () => {
  const root = mkTmp("zccache-seed-existing-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  try {
    await seedZccache({
      soldrPath: "soldr",
      actionRoot: root,
      enabled: true,
      strict: false,
      log: () => undefined,
      warn: (msg) => assert.fail(msg),
      execFn: makeExec(calls, {
        command: "install-zccache --status",
        managed_version: "1.11.2",
        pinned: { version: "1.11.2" },
        drift_from_managed: false,
      }),
      env: {},
    });

    assert.deepEqual(calls.map((call) => call.args), [["install-zccache", "--status", "--json"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedZccache does not override SOLDR_ZCCACHE_LOCAL_DIR", async () => {
  const root = mkTmp("zccache-seed-local-");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  try {
    await seedZccache({
      soldrPath: "soldr",
      actionRoot: root,
      enabled: true,
      strict: false,
      log: () => undefined,
      warn: (msg) => assert.fail(msg),
      execFn: makeExec(calls, {}),
      env: { SOLDR_ZCCACHE_LOCAL_DIR: "/already/set" },
    });

    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
