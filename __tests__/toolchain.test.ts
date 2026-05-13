import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadToolchainSpec,
  resolveToolchainCacheChannel,
  rollingToolchainAlias,
  systemRustupSatisfiesRequest,
} from "../src/lib/toolchain.js";
import type { ToolchainSpec } from "../src/lib/types.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("rollingToolchainAlias recognizes plain stable/beta/nightly", () => {
  assert.equal(rollingToolchainAlias("stable"), "stable");
  assert.equal(rollingToolchainAlias("beta"), "beta");
  assert.equal(rollingToolchainAlias("nightly"), "nightly");
});

test("rollingToolchainAlias recognizes host-suffixed forms", () => {
  assert.equal(rollingToolchainAlias("stable-x86_64-unknown-linux-gnu"), "stable");
  assert.equal(rollingToolchainAlias("nightly-x86_64-pc-windows-msvc"), "nightly");
});

test("rollingToolchainAlias rejects dated nightly forms", () => {
  assert.equal(rollingToolchainAlias("nightly-2024-04-01"), null);
  assert.equal(rollingToolchainAlias("beta-2024-04-01"), null);
});

test("rollingToolchainAlias rejects pinned versions", () => {
  assert.equal(rollingToolchainAlias("1.95.0"), null);
  assert.equal(rollingToolchainAlias("1.78.0-x86_64-unknown-linux-gnu"), null);
});

test("rollingToolchainAlias is case insensitive", () => {
  assert.equal(rollingToolchainAlias("STABLE"), "stable");
  assert.equal(rollingToolchainAlias("  Nightly  "), "nightly");
});

// Provide a global.fetch stub via mocking through a wrapper.
async function withFetch<T>(handler: (input: string) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    return handler(url);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("resolveToolchainCacheChannel pinned passes through without fetch", async () => {
  let called = false;
  await withFetch(
    () => {
      called = true;
      return new Response("");
    },
    async () => {
      assert.equal(await resolveToolchainCacheChannel("1.95.0"), "1.95.0");
    },
  );
  assert.equal(called, false);
});

test("resolveToolchainCacheChannel rolling stable resolves to version", async () => {
  await withFetch(
    () => new Response('[pkg.rust]\nversion = "1.95.0 (59807616e 2026-04-14)"\n', { status: 200 }),
    async () => {
      assert.equal(await resolveToolchainCacheChannel("stable"), "1.95.0");
    },
  );
});

test("resolveToolchainCacheChannel rolling beta keeps beta suffix", async () => {
  await withFetch(
    () => new Response('[pkg.rust]\nversion = "1.96.0-beta.3 (deadbeef 2026-04-20)"\n', { status: 200 }),
    async () => {
      assert.equal(await resolveToolchainCacheChannel("beta"), "1.96.0-beta.3");
    },
  );
});

test("resolveToolchainCacheChannel host-suffixed alias uses manifest", async () => {
  await withFetch(
    () => new Response('[pkg.rust]\nversion = "1.95.0 (x 2026-04-14)"\n', { status: 200 }),
    async () => {
      assert.equal(
        await resolveToolchainCacheChannel("stable-x86_64-unknown-linux-gnu"),
        "1.95.0",
      );
    },
  );
});

test("resolveToolchainCacheChannel falls back when fetch fails", async () => {
  await withFetch(
    () => {
      throw new Error("offline");
    },
    async () => {
      assert.equal(await resolveToolchainCacheChannel("stable"), "stable");
    },
  );
});

test("resolveToolchainCacheChannel falls back when http status not ok", async () => {
  await withFetch(
    () => new Response("nope", { status: 503 }),
    async () => {
      assert.equal(await resolveToolchainCacheChannel("nightly"), "nightly");
    },
  );
});

test("resolveToolchainCacheChannel falls back when manifest missing pkg.rust", async () => {
  await withFetch(
    () => new Response("[other]\nname = 'no rust'\n", { status: 200 }),
    async () => {
      assert.equal(await resolveToolchainCacheChannel("stable"), "stable");
    },
  );
});

test("loadToolchainSpec default when toolchain file missing", async () => {
  const ws = mkTmp("ws-");
  const spec = await loadToolchainSpec({
    workspace: ws,
    toolchainFile: "rust-toolchain.toml",
    toolchainOverride: "",
  });
  assert.equal(spec.channel, "stable");
  assert.equal(spec.profile, "minimal");
  assert.deepEqual(spec.components, []);
  assert.deepEqual(spec.targets, []);
  assert.equal(spec.source, "default");
  assert.equal(spec.fileHash, "none");
});

test("loadToolchainSpec reads channel from rust-toolchain.toml", async () => {
  const ws = mkTmp("ws-");
  fs.writeFileSync(
    path.join(ws, "rust-toolchain.toml"),
    '[toolchain]\nchannel = "1.78.0"\nprofile = "default"\ncomponents = ["clippy", "rustfmt"]\ntargets = ["wasm32-unknown-unknown"]\n',
    "utf8",
  );
  const spec = await loadToolchainSpec({
    workspace: ws,
    toolchainFile: "rust-toolchain.toml",
    toolchainOverride: "",
  });
  assert.equal(spec.channel, "1.78.0");
  assert.equal(spec.profile, "default");
  assert.deepEqual(spec.components, ["clippy", "rustfmt"]);
  assert.deepEqual(spec.targets, ["wasm32-unknown-unknown"]);
  assert.equal(spec.source, "rust-toolchain.toml");
  assert.match(spec.fileHash, /^[0-9a-f]{16}$/);
});

test("loadToolchainSpec override beats file", async () => {
  const ws = mkTmp("ws-");
  fs.writeFileSync(
    path.join(ws, "rust-toolchain.toml"),
    '[toolchain]\nchannel = "1.78.0"\n',
    "utf8",
  );
  const spec = await loadToolchainSpec({
    workspace: ws,
    toolchainFile: "rust-toolchain.toml",
    toolchainOverride: "1.95.0",
  });
  assert.equal(spec.channel, "1.95.0");
  assert.equal(spec.source, "input");
});

test("systemRustupSatisfiesRequest returns false when rustup missing", async () => {
  const ts: ToolchainSpec = {
    channel: "stable",
    cacheChannel: "1.95.0",
    profile: "minimal",
    components: [],
    targets: [],
    source: "default",
    fileHash: "none",
  };
  const ok = await systemRustupSatisfiesRequest({
    cargoHome: "/fake/cargo",
    rustupHome: "/fake/rustup",
    toolchain: ts,
    env: {},
    deps: { which: async () => null },
  });
  assert.equal(ok, false);
});

test("systemRustupSatisfiesRequest matches when all installed", async () => {
  const ts: ToolchainSpec = {
    channel: "stable",
    cacheChannel: "1.95.0",
    profile: "minimal",
    components: ["clippy"],
    targets: ["wasm32-unknown-unknown"],
    source: "default",
    fileHash: "none",
  };
  let call = 0;
  const ok = await systemRustupSatisfiesRequest({
    cargoHome: "/fake/cargo",
    rustupHome: "/fake/rustup",
    toolchain: ts,
    env: {},
    deps: {
      which: async () => "/fake/rustup",
      rustupInstalledNames: async () => {
        call += 1;
        if (call === 1) return new Set(["stable-x86_64-unknown-linux-gnu"]);
        if (call === 2) return new Set(["clippy-x86_64-unknown-linux-gnu"]);
        return new Set(["wasm32-unknown-unknown"]);
      },
      installedToolchainRelease: async () => "1.95.0",
    },
  });
  assert.equal(ok, true);
});

test("systemRustupSatisfiesRequest fails when release mismatch on rolling channel", async () => {
  const ts: ToolchainSpec = {
    channel: "stable",
    cacheChannel: "1.95.0",
    profile: "minimal",
    components: [],
    targets: [],
    source: "default",
    fileHash: "none",
  };
  const ok = await systemRustupSatisfiesRequest({
    cargoHome: "/fake/cargo",
    rustupHome: "/fake/rustup",
    toolchain: ts,
    env: {},
    deps: {
      which: async () => "/fake/rustup",
      rustupInstalledNames: async () => new Set(["stable"]),
      installedToolchainRelease: async () => "1.94.1",
    },
  });
  assert.equal(ok, false);
});

test("systemRustupSatisfiesRequest fails when component missing", async () => {
  const ts: ToolchainSpec = {
    channel: "stable",
    cacheChannel: "1.95.0",
    profile: "minimal",
    components: ["miri"],
    targets: [],
    source: "default",
    fileHash: "none",
  };
  let call = 0;
  const ok = await systemRustupSatisfiesRequest({
    cargoHome: "/fake/cargo",
    rustupHome: "/fake/rustup",
    toolchain: ts,
    env: {},
    deps: {
      which: async () => "/fake/rustup",
      rustupInstalledNames: async () => {
        call += 1;
        if (call === 1) return new Set(["stable-x86_64-unknown-linux-gnu"]);
        return new Set(["clippy"]);
      },
      installedToolchainRelease: async () => "1.95.0",
    },
  });
  assert.equal(ok, false);
});
