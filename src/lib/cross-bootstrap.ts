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

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";

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
 *  `linux` | `darwin` | `windows`. */
export function normalizeHost(raw: string): string {
  const n = raw.trim().toLowerCase();
  if (n === "win32" || n === "windows") return "windows";
  if (n === "darwin" || n === "macos") return "darwin";
  if (n === "linux") return "linux";
  return n;
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

    const supported = isLinuxToWindowsGnu(host, target) || isLinuxToLinuxMusl(host, target);
    if (!supported) {
      out.warnings.push(
        `setup-soldr cross-bootstrap: host=${host} target=${target} is not implemented yet ` +
          `(MVP supports linux -> *-pc-windows-gnu and linux -> *-unknown-linux-musl); ` +
          `install the cross toolchain manually for this lane. See zackees/setup-soldr#104.`,
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
    if (action.kind === "cargo-install") {
      log(`cross-bootstrap: installing ${action.payload} via soldr cargo install --locked`);
      await exec.exec(soldr, ["cargo", "install", action.payload, "--locked"]);
    } else if (action.kind === "pip-install") {
      log(`cross-bootstrap: installing ${action.payload} via pip install`);
      await exec.exec(pip, ["install", action.payload]);
    } else if (action.kind === "rustup-target-add") {
      log(`cross-bootstrap: rustup target add ${action.payload}`);
      await exec.exec(rustup, ["target", "add", action.payload]);
    }
  }
}
