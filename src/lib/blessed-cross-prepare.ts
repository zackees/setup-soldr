import * as fs from "node:fs";
import * as path from "node:path";
import * as exec from "@actions/exec";
import { shortJsonHash, sanitizeFragment } from "./cache-keys.js";

export interface BlessedPrepareCachePlan {
  enabled: boolean;
  schemaVersion: 3;
  target: string;
  key: string;
  /**
   * Stable, host/target/repository-scoped prefixes. These deliberately omit
   * the Soldr release so immutable toolchain payloads survive frequent Soldr
   * releases. `soldr prepare --restore --save` validates/fills version gaps
   * before promoting a fallback to the current exact key.
   */
  restoreKeys: string[];
  archivePath: string;
  archivePaths: string[];
}

export interface BlessedPrepareCacheUse {
  effectiveExactHit: boolean;
  fallbackHit: boolean;
  restore: boolean;
  save: boolean;
}

const TRIPLE = /^[a-z0-9]+(?:_[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)+$/;

export function parseSingleCrossTarget(raw: string): string | null {
  const values = [...new Set(raw.split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))].sort();
  if (values.length === 0) return null;
  if (values.length > 1) {
    throw new Error(
      `cross-targets accepts one target per job because soldr prepare exports one target environment; use a matrix for: ${values.join(", ")}`,
    );
  }
  const target = values[0]!;
  if (target === "all" || !TRIPLE.test(target) || target.split("-").length < 3) {
    throw new Error(
      `cross-targets requires one canonical Rust target triple (for example x86_64-pc-windows-msvc); aliases such as '${target}' are not accepted`,
    );
  }
  return target;
}

export function prepareTargetsFor(crossTarget: string | null): string[] {
  return crossTarget === "universal2-apple-darwin"
    ? ["x86_64-apple-darwin", "aarch64-apple-darwin"]
    : crossTarget ? [crossTarget] : [];
}

export function mergeToolchainTargets(existing: string[], crossTarget: string | null): string[] {
  const expanded = prepareTargetsFor(crossTarget);
  return [...new Set([...existing, ...expanded].map((v) => v.trim().toLowerCase()).filter(Boolean))].sort();
}

export function blessedPrepareCacheKey(input: {
  runnerOs: string;
  runnerArch: string;
  target: string;
  soldrRepo: string;
  soldrVersion: string;
}): string {
  const base = blessedPrepareCacheBase(input);
  const soldrHash = shortJsonHash({ soldr_version: input.soldrVersion.trim() });
  return `${base}-s${soldrHash}`;
}

function blessedPrepareCacheBase(input: {
  runnerOs: string;
  runnerArch: string;
  target: string;
  soldrRepo: string;
}): string {
  const repoHash = shortJsonHash({ repo: input.soldrRepo.trim() });
  return `setup-soldr-prepare-v3-${sanitizeFragment(input.runnerOs)}-${sanitizeFragment(input.runnerArch)}-${sanitizeFragment(input.target)}-r${repoHash}`;
}

export function planBlessedPrepareCache(input: {
  enabled: boolean;
  cacheEnabled: boolean;
  ref: string;
  runnerTemp: string;
  runnerOs: string;
  runnerArch: string;
  target: string | null;
  soldrRepo: string;
  soldrVersion: string;
}): BlessedPrepareCachePlan {
  const target = input.target ?? "";
  const enabled = input.enabled && input.cacheEnabled && !input.ref.trim() && Boolean(target);
  // Keep the established archive path even though the key schema is v3:
  // @actions/cache includes the path list in its internal cache version.
  const archiveRoot = target
    ? path.join(input.runnerTemp, "setup-soldr-prepare", "v2", sanitizeFragment(target))
    : "";
  const archivePaths = target === "universal2-apple-darwin"
    ? prepareTargetsFor(target).map((realTarget) => path.join(archiveRoot, `${sanitizeFragment(realTarget)}.tar.zst`))
    : target ? [path.join(archiveRoot, "prepared.tar.zst")] : [];
  const restoreKeys = enabled ? [`${blessedPrepareCacheBase({ ...input, target })}-`] : [];
  return {
    enabled,
    schemaVersion: 3,
    target,
    key: enabled ? blessedPrepareCacheKey({ ...input, target }) : "",
    restoreKeys,
    archivePath: archivePaths[0] ?? "",
    archivePaths,
  };
}

export function buildPrepareArgs(input: { target: string; githubEnv?: string; archivePath?: string; restore?: boolean; save?: boolean }): string[] {
  const args = ["prepare", "--target", input.target];
  if (input.githubEnv?.trim()) args.push("--github-env", input.githubEnv.trim());
  if (input.restore && input.archivePath) args.push("--restore", input.archivePath);
  if (input.save && input.archivePath) args.push("--save", input.archivePath);
  return args;
}

export function decideBlessedPrepareCacheUse(input: {
  enabled: boolean;
  exactHit: boolean;
  matchedKey: string;
  archivesExist: boolean;
}): BlessedPrepareCacheUse {
  const effectiveExactHit = input.enabled && input.exactHit && input.archivesExist;
  const fallbackHit = input.enabled
    && !input.exactHit
    && Boolean(input.matchedKey)
    && input.archivesExist;
  return {
    effectiveExactHit,
    fallbackHit,
    restore: effectiveExactHit || fallbackHit,
    save: input.enabled && !effectiveExactHit,
  };
}

export function assertMinimumSoldrVersion(version: string, minimum = "0.8.43"): void {
  const parse = (v: string) => v.trim().replace(/^v/, "").split(".").slice(0, 3).map((n) => Number.parseInt(n.split("-")[0]!, 10));
  const actual = parse(version);
  const required = parse(minimum);
  if (actual.some((n) => !Number.isFinite(n)) || actual[0]! < required[0]! || (actual[0] === required[0] && (actual[1]! < required[1]! || (actual[1] === required[1] && actual[2]! < required[2]!)))) {
    throw new Error(`cross-targets requires soldr ${minimum} or newer; installed ${version}`);
  }
}

export async function executeBlessedPrepare(input: {
  soldrPath: string;
  target: string;
  githubEnv?: string;
  archivePath?: string;
  restore?: boolean;
  save?: boolean;
  execCommand?: (command: string, args: string[]) => Promise<number>;
  exists?: (file: string) => boolean;
  statSize?: (file: string) => number;
}): Promise<void> {
  const run = input.execCommand ?? ((command, args) => exec.exec(command, args));
  await run(input.soldrPath, buildPrepareArgs(input));
  if (input.save && input.archivePath) {
    const exists = input.exists ?? fs.existsSync;
    const size = input.statSize ?? ((file) => fs.statSync(file).size);
    if (!exists(input.archivePath) || size(input.archivePath) <= 0) {
      throw new Error(`soldr prepare completed without a non-empty archive at ${input.archivePath}`);
    }
  }
}
