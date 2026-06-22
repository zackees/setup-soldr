// Auto-install cross-compile prerequisites for declared `cross-targets`.
//
// MVP scope (issue #104):
//   - Host `linux` -> `*-pc-windows-gnu` (any arch): install cargo-zigbuild
//     (via `soldr cargo install`) + ziglang (via `pip install`) +
//     `rustup target add`.
//   - Host `linux` -> `*-unknown-linux-musl` (any arch, host != target):
//     same install set.
//   - Any other (host, target) combo with `cross-tool: auto`: emit a
//     `core.warning` describing what we'd do for that lane and continue
//     without failing. `xwin`/`mingw` strategy values are accepted for
//     forward-compat but currently route through the same `auto` logic for
//     the supported lanes.
//   - `cross-tool: none`: short-circuit to empty plan, no warnings.
//
// Caching of installed plugin binaries is deferred to a follow-up PR.
//
// This module exports:
//   - `planCrossBootstrap` — pure planner that returns the install actions.
//   - `executeCrossBootstrap` — performs the installs via @actions/exec,
//     skipping any binary already on PATH.

import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import { streamExec } from "./log-utils.js";

/** Allowed values for the `cross-tool:` input. */
export type CrossTool = "auto" | "none" | "zigbuild" | "xwin" | "mingw";

/** A single install action returned by the planner. */
export interface CrossInstallAction {
  /** Kind of install command to run. */
  kind: "cargo-install" | "pip-install" | "rustup-target-add";
  /** The single argument: the crate/package/target identifier. */
  payload: string;
  /**
   * The binary that — when found on PATH — means this action can be
   * skipped. `null` when no such short-circuit applies (e.g. rustup target
   * add, which is cheap and idempotent on its own).
   */
  skipIfPresent: string | null;
}

/** Plan output: actions to run + warnings to surface. */
export interface CrossBootstrapPlan {
  actions: CrossInstallAction[];
  warnings: string[];
}

export interface PlanInput {
  /** Lower-cased host OS family: `linux` | `darwin` | `windows` (or `win32`). */
  host: string;
  /** Target triples to provision. */
  targets: string[];
  /** Strategy selector. `none` short-circuits. */
  tool: CrossTool;
}

/** Normalize an os-ish string (RUNNER_OS, process.platform, ...) to one of
 *  `linux` | `darwin` | `windows`.
 *
 *  Also accepts combined `os-arch` shapes like `linux-x64` /
 *  `macos-arm64` that the per-(host, target) cache layer uses. The arch
 *  suffix is stripped for the OS-family decision; pass the full
 *  fragment in to the cache-key path. */
export function normalizeHost(raw: string): string {
  const n = raw.trim().toLowerCase();
  // Strip `-x64` / `-arm64` / `-aarch64` / `-x86` arch suffixes so the
  // combined `os-arch` shape collapses to the OS family.
  const noArch = n.replace(/-(x64|arm64|aarch64|x86|i686|amd64)$/, "");
  if (noArch === "win32" || noArch === "windows") return "windows";
  if (noArch === "darwin" || noArch === "macos") return "darwin";
  if (noArch === "linux") return "linux";
  return noArch;
}

/** Parse a `cross-targets` input value (newline- or comma-separated). */
export function parseCrossTargets(raw: string): string[] {
  if (!raw) return [];
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  // De-dupe while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Parse and normalize the `cross-tool` input. Empty or unrecognized -> `auto`. */
export function parseCrossTool(raw: string): CrossTool {
  const n = raw.trim().toLowerCase();
  if (n === "none") return "none";
  if (n === "zigbuild") return "zigbuild";
  if (n === "xwin") return "xwin";
  if (n === "mingw") return "mingw";
  return "auto";
}

function isLinuxToWindowsGnu(host: string, target: string): boolean {
  return host === "linux" && /-pc-windows-gnu$/.test(target);
}

function isLinuxToLinuxMusl(host: string, target: string): boolean {
  if (host !== "linux") return false;
  if (!/-unknown-linux-musl$/.test(target)) return false;
  // Cheap "host != target" guard. We don't try to fully resolve the
  // host triple here — just skip the install when the user explicitly
  // asked for the obvious host triple on a glibc-or-musl x64 linux box.
  return true;
}

/**
 * Linux host → any apple-darwin target. Covers
 * `x86_64-apple-darwin`, `aarch64-apple-darwin`, and the
 * `universal2-apple-darwin` synthetic target. The toolset is the same
 * cargo-zigbuild + ziglang stack the windows-gnu and linux-musl lanes
 * use — zig handles the macOS-flavored linking with no extra
 * per-target toolchain prep required for trivial / sqlite-native
 * style crates. Driven by zackees/soldr#815; prototype evidence is
 * the `mac-cross.yml` workflow added in #384 (which proves x86_64 +
 * aarch64 + universal2 all link on ubuntu-24.04 in ~3 min cold).
 *
 * Crates that link against macOS system frameworks (Security,
 * CoreFoundation, AppKit, …) still need additional per-target
 * toolchain prep on the linux host — `soldr prepare --target
 * <triple>` is the recommended path. That helper is deliberately
 * out of scope of this planner.
 */
function isLinuxToMacOSTarget(host: string, target: string): boolean {
  return host === "linux" && /-apple-darwin$/.test(target);
}

/**
 * Pure planner. Returns the install actions for the supported lanes and a
 * list of warning messages for unsupported (host, target) combos.
 */
export function planCrossBootstrap(input: PlanInput): CrossBootstrapPlan {
  const host = normalizeHost(input.host);
  const tool = input.tool;
  const out: CrossBootstrapPlan = { actions: [], warnings: [] };

  if (tool === "none") return out;
  if (input.targets.length === 0) return out;

  // Track which shared installs we've already added so multi-target plans
  // don't duplicate cargo-zigbuild / ziglang.
  let sharedInstallsAdded = false;
  const seenTargets = new Set<string>();

  for (const target of input.targets) {
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);

    const supported =
      isLinuxToWindowsGnu(host, target) ||
      isLinuxToLinuxMusl(host, target) ||
      isLinuxToMacOSTarget(host, target);
    if (!supported) {
      out.warnings.push(
        `setup-soldr cross-bootstrap: host=${host} target=${target} is not implemented yet ` +
          `(supports linux -> *-pc-windows-gnu, linux -> *-unknown-linux-musl, ` +
          `and linux -> *-apple-darwin); install the cross toolchain manually for this lane. ` +
          `See zackees/setup-soldr#104 and zackees/soldr#815.`,
      );
      continue;
    }

    if (!sharedInstallsAdded) {
      out.actions.push({
        kind: "cargo-install",
        payload: "cargo-zigbuild",
        skipIfPresent: "cargo-zigbuild",
      });
      out.actions.push({
        kind: "pip-install",
        payload: "ziglang",
        // `ziglang` is a Python package providing `python -m ziglang`;
        // there's no top-level `ziglang` executable that's reliable to
        // probe. We let pip skip the re-install itself.
        skipIfPresent: null,
      });
      sharedInstallsAdded = true;
    }

    out.actions.push({
      kind: "rustup-target-add",
      payload: target,
      skipIfPresent: null,
    });
  }

  return out;
}

/** Internal helper — returns true when `cmd` is found on PATH. */
async function isOnPath(cmd: string): Promise<boolean> {
  try {
    const found = await io.which(cmd, false);
    return Boolean(found);
  } catch {
    return false;
  }
}

export interface ExecuteCrossBootstrapOpts {
  log?: (msg: string) => void;
  /** Override soldr binary used to run `soldr cargo install`. Defaults to `soldr`. */
  soldrBinary?: string;
  /** Override pip command. Defaults to `pip`. */
  pipCommand?: string;
  /** Override rustup command. Defaults to `rustup`. */
  rustupCommand?: string;
}

// --------------------- per-lane toolset spec (setup-soldr#106) ---------------------
//
// Wave 2.1 of zackees/soldr#514: the per-(host × target) cache layer needs a
// table mapping a lane to the toolset it installs. This is the same lookup
// `planCrossBootstrap` uses internally, but lifted into its own helper so
// the cache layer can compute the cache key (toolset-versions) without
// running the install.

export interface ToolsetSpec {
  /**
   * Sorted list of tool short-names this lane installs. Empty for
   * unsupported lanes (MVP). The names are used as the keys of the
   * `toolVersions` map fed into `crossToolCacheKeyFor()`.
   */
  tools: string[];
}

/** Lookup the toolset for one (host, target) lane. */
export function toolsetFor(opts: { host: string; target: string }): ToolsetSpec {
  const host = normalizeHost(opts.host);
  const target = opts.target;
  if (
    isLinuxToWindowsGnu(host, target) ||
    isLinuxToLinuxMusl(host, target) ||
    isLinuxToMacOSTarget(host, target)
  ) {
    return { tools: ["cargo-zigbuild", "ziglang"] };
  }
  return { tools: [] };
}

/**
 * Pinned default versions per tool, used by the per-lane cache key.
 *
 * Today `executeCrossBootstrap` runs `soldr cargo install <name> --locked`
 * and `pip install <name>` without a pinned version — pip/cargo resolve to
 * the current latest. Mixing "current latest" into a cache key is wrong:
 * the key would be wrong as soon as the upstream cuts a new release while
 * a warm cache exists.
 *
 * The pragmatic v1 default is to bake a known-good version into the cache
 * key. Bumping these literals invalidates only the per-(host × target)
 * tool slots and nothing else. Treat this as the action's published
 * default; users can override in a follow-up `cross-tool-overrides` input.
 */
const DEFAULT_TOOL_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  // Both values track the upstream pins used in DESIGN docs around the time
  // of #104. Bump together with cross-bootstrap MVP rollouts.
  "cargo-zigbuild": "0.20.0",
  ziglang: "0.13.0",
});

/** Resolved default version literal, or `unpinned` if we have no default. */
export function defaultToolVersion(name: string): string {
  return DEFAULT_TOOL_VERSIONS[name] ?? "unpinned";
}

/** Build the {tool: version} map for one lane using the pinned defaults. */
export function toolVersionsFor(opts: { host: string; target: string }): Record<string, string> {
  const ts = toolsetFor(opts);
  const out: Record<string, string> = {};
  for (const tool of ts.tools) {
    out[tool] = defaultToolVersion(tool);
  }
  return out;
}

// --------------------- per-lane cache paths (setup-soldr#106) ---------------------
//
// The on-disk locations the per-lane cache archives on save and unpacks on
// restore. We deliberately include a per-lane staging dir under the
// setup-soldr cache root so:
//   - the cache layer has a stable, predictable path to keep keyed across
//     runs (the ziglang pip artifacts otherwise live in a Python site-
//     packages path that's host-specific and not safe to round-trip).
//   - we don't accidentally clobber unrelated $CARGO_HOME contents.
//
// MVP scope: cache cargo-zigbuild's binary directly under `$CARGO_HOME/bin/`
// (executeCrossBootstrap already installs it there), plus a sentinel staging
// dir under `<cacheRoot>/cross-tools/<target>/` so the cache layer has at
// least one writable target for forthcoming ziglang-pip cache work.

export interface CrossToolCachePathsInput {
  host: string;
  target: string;
  /** `$CARGO_HOME` from the resolved setup state. */
  cargoHome: string;
  /** setup-soldr's cache root (the `setupCachePath` in resolve-setup.ts). */
  cacheRoot: string;
}

export function crossToolCachePathsFor(input: CrossToolCachePathsInput): string[] {
  const ts = toolsetFor({ host: input.host, target: input.target });
  if (ts.tools.length === 0) return [];
  const paths: string[] = [];
  // cargo-zigbuild binary (host-native, lives under $CARGO_HOME/bin).
  // On Windows the binary name has a `.exe` suffix; the host triple here
  // refers to the runner OS, not the cross target, so we look at platform.
  // Use the host fragment as a coarse hint instead of process.platform so
  // the helper is testable from any host.
  const isWindowsHost = /win/i.test(input.host);
  if (ts.tools.includes("cargo-zigbuild")) {
    paths.push(
      path.join(
        input.cargoHome,
        "bin",
        isWindowsHost ? "cargo-zigbuild.exe" : "cargo-zigbuild",
      ),
    );
  }
  // Per-lane staging slot. Lives under setup-soldr's cache root so the slot
  // is per-job-isolated and the cache layer can write a stable archive
  // path. Currently a placeholder for future ziglang-pip-dir caching.
  paths.push(path.join(input.cacheRoot, "cross-tools", input.target));
  return paths;
}

/**
 * Execute a plan returned by `planCrossBootstrap`. Skips installs whose
 * `skipIfPresent` binary is already on PATH. Warnings from the planner
 * have already been surfaced — this function only runs the actions.
 */
export async function executeCrossBootstrap(
  plan: CrossBootstrapPlan,
  opts: ExecuteCrossBootstrapOpts = {},
): Promise<void> {
  const log = opts.log ?? ((msg: string) => core.info(msg));
  const soldr = opts.soldrBinary ?? "soldr";
  const pip = opts.pipCommand ?? "pip";
  const rustup = opts.rustupCommand ?? "rustup";

  for (const action of plan.actions) {
    if (action.skipIfPresent && (await isOnPath(action.skipIfPresent))) {
      log(`cross-bootstrap: ${action.skipIfPresent} already on PATH, skipping ${action.kind}`);
      continue;
    }
    // #389: streamExec wraps each install with timestamp-prefixing line
    // listeners + color-preserving env. Cargo install of cross tooling
    // (cargo-zigbuild, etc.) emits hundreds of `Compiling foo v1.2.3`
    // lines on cold install; without prefixes the operator can't tell
    // which crate caused a slow stretch from the log alone.
    if (action.kind === "cargo-install") {
      log(`cross-bootstrap: installing ${action.payload} via soldr cargo install --locked`);
      await streamExec(soldr, ["cargo", "install", action.payload, "--locked"]);
    } else if (action.kind === "pip-install") {
      log(`cross-bootstrap: installing ${action.payload} via pip install`);
      await streamExec(pip, ["install", action.payload]);
    } else if (action.kind === "rustup-target-add") {
      log(`cross-bootstrap: rustup target add ${action.payload}`);
      await streamExec(rustup, ["target", "add", action.payload]);
    }
  }
}
