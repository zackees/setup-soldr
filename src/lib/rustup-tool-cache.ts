// setup-soldr#557: keep the managed Rust toolchain in RUNNER_TOOL_CACHE.
//
// With the managed rustup strategy, RUSTUP_HOME lives under RUNNER_TEMP, so
// on act (`bosn ci`) and self-hosted runners every job of every warm run
// reinstalled the toolchain: `rustup_install` 14-17 s (zccache, whose
// workflows run with `solo-toolchain-cache: false`, zccache#1677).
//
// The store keeps one entry per toolchain request, keyed by the pinned
// channel, profile, components and targets:
//   $RUNNER_TOOL_CACHE/soldr-rustup/<platform>-<arch>/<channel>-<hash>/
//     toolchains/  update-hashes/  .complete
// A warm job links RUSTUP_HOME's `toolchains` and `update-hashes` to the
// entry; rustup then finds the toolchain, components and targets installed
// and only reads them. `settings.toml` and rustup's `tmp`/`downloads` stay in
// the per-job RUSTUP_HOME, so concurrent jobs never write the shared entry.
// A cold job installs into its own RUSTUP_HOME as before and then publishes
// a copy (staged beside the entry, renamed into place; first one wins).
//
// Off when solo-toolchain-cache is on (that layer owns the toolchain and
// diffs real directories), for a system or explicit RUSTUP_HOME (not ours to
// redirect), in Dylint mode (its nightly lives in the same `toolchains`
// dir), and for a rolling channel (`stable`, `nightly`, ...), which rustup
// refreshes in place and so would write into the shared entry.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  copyTree,
  decideToolCacheStore,
  linkDir,
  publishEntry,
  toolCacheStorePath,
  type PublishStatus,
  type StoreLogger,
} from "./tool-cache-store.js";
import { rollingToolchainAlias } from "./toolchain.js";

const SHARED_DIRS = ["toolchains", "update-hashes"] as const;

export interface RustupRequest {
  /** The exact (non-rolling) channel, e.g. `1.95.0` or `nightly-2026-04-01`. */
  channel: string;
  profile: string;
  components: string[];
  targets: string[];
}

export function rustupStoreEntry(store: string, request: RustupRequest): string {
  const identity = JSON.stringify({
    profile: request.profile,
    components: [...request.components].sort(),
    targets: [...request.targets].sort(),
  });
  const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(store, `${request.channel}-${hash}`);
}

export function rustupStoreOffReason(input: {
  strategy: "managed" | "system" | "explicit";
  soloToolchainCache: boolean;
  dylint: boolean;
  channel: string;
}): string {
  if (input.soloToolchainCache) return "solo-toolchain-cache owns the toolchain";
  if (input.strategy !== "managed") return `rustup strategy=${input.strategy} (RUSTUP_HOME is not setup-soldr's)`;
  if (input.dylint) return "Dylint mode installs its nightly into the same toolchains dir";
  if (rollingToolchainAlias(input.channel) !== null) {
    return `rolling channel ${input.channel} is refreshed in place by rustup`;
  }
  return "";
}

export type RustupAdoptStatus = "adopted" | "miss" | "kept-existing-dir";

/** Link RUSTUP_HOME's shared dirs to a complete store entry, if there is one. */
export function adoptRustupStore(input: { rustupHome: string; entry: string }): RustupAdoptStatus {
  if (!fs.existsSync(path.join(input.entry, ".complete"))) return "miss";
  let kept = false;
  for (const name of SHARED_DIRS) {
    const status = linkDir({ linkPath: path.join(input.rustupHome, name), target: path.join(input.entry, name) });
    kept ||= status === "kept-existing-dir";
  }
  return kept ? "kept-existing-dir" : "adopted";
}

/** Publish this job's installed toolchain dirs as the store entry. */
export function publishRustupStore(input: { rustupHome: string; entry: string }): PublishStatus {
  return publishEntry({
    dest: input.entry,
    populate: (staging) => {
      fs.mkdirSync(staging, { recursive: true });
      for (const name of SHARED_DIRS) {
        const src = path.join(input.rustupHome, name);
        if (fs.existsSync(src)) copyTree(src, path.join(staging, name));
        else fs.mkdirSync(path.join(staging, name));
      }
      fs.writeFileSync(path.join(staging, ".complete"), `${path.basename(input.entry)}\n`);
    },
  });
}

export interface RustupStorePlan {
  entry: string;
  status: RustupAdoptStatus;
}

/**
 * Toolchain phase, before the install: adopt a stored toolchain when this
 * runner keeps one. Returns null when the layer is off or adoption failed
 * (the install then runs into RUSTUP_HOME as before).
 */
export function adoptRustupToolCache(input: {
  env: Record<string, string | undefined>;
  rustupHome: string;
  request: RustupRequest;
  offReason: string;
  logger: StoreLogger;
}): RustupStorePlan | null {
  const decision = decideToolCacheStore({ env: input.env, platform: process.platform, layerOff: input.offReason });
  if (!decision.enabled) {
    input.logger.debug(`rustup-tool-cache: off (${decision.reason})`);
    return null;
  }
  const store = toolCacheStorePath(decision.toolCache, "rustup", process.platform, process.arch);
  const entry = rustupStoreEntry(store, input.request);
  try {
    const status = adoptRustupStore({ rustupHome: input.rustupHome, entry });
    input.logger.log(`rustup-tool-cache: ${status} ${entry} (${decision.reason})`);
    return { entry, status };
  } catch (err) {
    input.logger.warn(`rustup-tool-cache: could not adopt ${entry}: ${(err as Error).message}`);
    return null;
  }
}

/** Toolchain phase, after a successful install on a miss: publish it. Best-effort. */
export function publishRustupToolCache(input: { rustupHome: string; plan: RustupStorePlan; logger: StoreLogger }): void {
  if (input.plan.status !== "miss") return;
  const t0 = Date.now();
  try {
    const status = publishRustupStore({ rustupHome: input.rustupHome, entry: input.plan.entry });
    input.logger.log(`rustup-tool-cache: ${status} ${input.plan.entry} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    input.logger.warn(`rustup-tool-cache: could not publish ${input.plan.entry}: ${(err as Error).message}`);
  }
}
