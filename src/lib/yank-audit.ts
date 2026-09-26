import * as fs from "node:fs";
import * as path from "node:path";
import * as toml from "@iarna/toml";

export const YANK_AUDIT_WORKER_ARG = "--setup-soldr-yank-audit-worker";

export interface YankAuditDependency {
  name: string;
  version: string;
  source: string;
}

export interface YankedDependency {
  name: string;
  version: string;
}

export interface YankAuditResult {
  status: "pending" | "clean" | "yanked" | "not-checked";
  checkedAt?: string;
  dependencyCount?: number;
  checkedCount?: number;
  yanked?: YankedDependency[];
  errors?: string[];
  joinTimedOut?: boolean;
  auditTimedOut?: boolean;
  workerPid?: number;
}

export interface YankAuditWorkerConfig {
  dependencies: YankAuditDependency[];
  requestTimeoutMs: number;
  overallTimeoutMs: number;
}

type FetchLike = typeof fetch;

interface CargoLockPackage {
  name?: unknown;
  version?: unknown;
  source?: unknown;
}

const CRATES_IO_GIT_INDEX = "registry+https://github.com/rust-lang/crates.io-index";
const CRATES_IO_SPARSE_INDEX = "sparse+https://index.crates.io/";

function isCratesIoSource(source: string): boolean {
  return source === CRATES_IO_GIT_INDEX || source === CRATES_IO_SPARSE_INDEX;
}

export function readRegistryDependencies(lockfilePath: string): YankAuditDependency[] {
  const parsed = toml.parse(fs.readFileSync(lockfilePath, "utf8")) as {
    package?: CargoLockPackage[];
  };
  const seen = new Set<string>();
  const dependencies: YankAuditDependency[] = [];
  for (const pkg of Array.isArray(parsed.package) ? parsed.package : []) {
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue;
    if (
      typeof pkg.source !== "string" ||
      (!pkg.source.startsWith("registry+") && !pkg.source.startsWith("sparse+"))
    ) continue;
    const key = `${pkg.source}\0${pkg.name}\0${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dependencies.push({ name: pkg.name, version: pkg.version, source: pkg.source });
  }
  return dependencies;
}

export type YankAuditPlan =
  | { action: "skip"; reason: string }
  | { action: "audit"; lockfilePath: string; dependencies: YankAuditDependency[] };

/**
 * Decide whether restored dependency caches need a registry yank audit.
 *
 * A missing Cargo.lock means nothing pinned the restored closure: cargo
 * resolves fresh on this run and never selects a yanked version, so there is
 * no pinned closure that a later yank could poison (#526: a "-no-lock"
 * build-cache hit used to start an audit whose post join then failed on the
 * never-written worker config). Any other read or parse failure throws so the
 * caller keeps failing closed.
 */
export function planYankAudit(opts: {
  cacheKeys: readonly string[];
  lockfilePath: string | undefined;
  workspace: string;
}): YankAuditPlan {
  const cacheKeys = opts.cacheKeys.filter(Boolean);
  if (cacheKeys.length === 0) {
    return { action: "skip", reason: "no dependency-bearing cache was restored" };
  }
  if (!opts.lockfilePath) {
    throw new Error("restored dependency cache has no Cargo.lock path");
  }
  const lockfilePath = path.isAbsolute(opts.lockfilePath)
    ? opts.lockfilePath
    : path.resolve(opts.workspace, opts.lockfilePath);
  let dependencies: YankAuditDependency[];
  try {
    dependencies = readRegistryDependencies(lockfilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return {
        action: "skip",
        reason: `no Cargo.lock at ${lockfilePath}; cargo resolves the dependency closure fresh`,
      };
    }
    throw err;
  }
  return { action: "audit", lockfilePath, dependencies };
}

export function cratesIoSparsePath(crateName: string): string {
  const name = crateName.toLowerCase();
  if (name.length === 1) return `1/${name}`;
  if (name.length === 2) return `2/${name}`;
  if (name.length === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

async function fetchCrateYanks(
  crateName: string,
  versions: readonly string[],
  fetchImpl: FetchLike,
  timeoutMs: number,
  overallSignal: AbortSignal,
): Promise<{ checked: YankedDependency[]; yanked: YankedDependency[] }> {
  const controller = new AbortController();
  const abortForOverallDeadline = (): void => controller.abort();
  overallSignal.addEventListener("abort", abortForOverallDeadline, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://index.crates.io/${cratesIoSparsePath(crateName)}`, {
      headers: {
        "Accept": "text/plain",
        "User-Agent": "setup-soldr-yank-audit/1",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = new Map<string, boolean>();
    for (const line of (await response.text()).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { vers?: unknown; yanked?: unknown };
      if (typeof record.vers === "string" && typeof record.yanked === "boolean") {
        records.set(record.vers, record.yanked);
      }
    }
    const checked: YankedDependency[] = [];
    const yanked: YankedDependency[] = [];
    for (const version of versions) {
      if (!records.has(version)) {
        throw new Error(`version ${crateName} ${version} absent from sparse index`);
      }
      const dependency = { name: crateName, version };
      checked.push(dependency);
      if (records.get(version)) yanked.push(dependency);
    }
    return { checked, yanked };
  } finally {
    clearTimeout(timeout);
    overallSignal.removeEventListener("abort", abortForOverallDeadline);
  }
}

export async function auditDependencyYanks(
  dependencies: readonly YankAuditDependency[],
  options: {
    fetchImpl?: FetchLike;
    requestTimeoutMs?: number;
    overallTimeoutMs?: number;
    concurrency?: number;
  } = {},
): Promise<YankAuditResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const concurrency = Math.max(1, options.concurrency ?? 12);
  const overallTimeoutMs = Math.max(1, options.overallTimeoutMs ?? 45_000);
  const overallController = new AbortController();
  let overallTimeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    overallTimeout = setTimeout(() => {
      overallController.abort();
      resolve("deadline");
    }, overallTimeoutMs);
  });
  const errors: string[] = [];
  const yanked: YankedDependency[] = [];
  let checkedCount = 0;

  const byCrate = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    if (!isCratesIoSource(dependency.source)) {
      errors.push(
        `${dependency.name} ${dependency.version}: registry ${dependency.source} is not supported`,
      );
      continue;
    }
    const versions = byCrate.get(dependency.name) ?? new Set<string>();
    versions.add(dependency.version);
    byCrate.set(dependency.name, versions);
  }

  const work = [...byCrate.entries()];
  let index = 0;
  let omittedErrors = 0;
  const recordError = (message: string): void => {
    if (errors.length < 20) errors.push(message);
    else omittedErrors += 1;
  };
  const worker = async (): Promise<void> => {
    while (true) {
      const item = work[index++];
      if (!item) return;
      const [crateName, versions] = item;
      try {
        if (overallController.signal.aborted) {
          throw new Error(`audit deadline exceeded after ${overallTimeoutMs}ms`);
        }
        const result = await fetchCrateYanks(
          crateName,
          [...versions],
          fetchImpl,
          timeoutMs,
          overallController.signal,
        );
        checkedCount += result.checked.length;
        yanked.push(...result.yanked);
      } catch (err) {
        recordError(`${crateName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  let outcome: "complete" | "deadline";
  try {
    const completed = Promise.all(
      Array.from({ length: Math.min(concurrency, work.length) }, () => worker()),
    ).then(() => "complete" as const);
    outcome = await Promise.race([completed, deadline]);
  } finally {
    clearTimeout(overallTimeout);
  }
  if (outcome === "deadline") {
    return {
      status: "not-checked",
      checkedAt: new Date().toISOString(),
      dependencyCount: dependencies.length,
      checkedCount,
      yanked: [...yanked],
      errors: [`audit deadline exceeded after ${overallTimeoutMs}ms`],
      auditTimedOut: true,
    };
  }
  if (omittedErrors > 0) errors.push(`${omittedErrors} additional registry errors omitted`);

  const base = {
    checkedAt: new Date().toISOString(),
    dependencyCount: dependencies.length,
    checkedCount,
  };
  if (yanked.length > 0) {
    return { ...base, status: "yanked", yanked, errors };
  }
  if (errors.length > 0) {
    return { ...base, status: "not-checked", yanked: [], errors };
  }
  return { ...base, status: "clean", yanked: [], errors: [] };
}

export function writeYankAuditResult(resultPath: string, result: YankAuditResult): void {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  const temporaryPath = `${resultPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(result)}\n`, "utf8");
  fs.renameSync(temporaryPath, resultPath);
}

export function readYankAuditResult(resultPath: string): YankAuditResult | null {
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as YankAuditResult;
    if (!["pending", "clean", "yanked", "not-checked"].includes(result.status)) return null;
    return result;
  } catch {
    return null;
  }
}

export async function waitForYankAuditResult(
  resultPath: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<YankAuditResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = readYankAuditResult(resultPath);
    if (result && result.status !== "pending") return result;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    status: "not-checked",
    checkedAt: new Date().toISOString(),
    errors: [`audit did not finish within ${timeoutMs}ms`],
    joinTimedOut: true,
  };
}

/** Join an overlapped audit only until its own deadline, then recheck locally. */
export async function resolveYankAuditResult(
  resultPath: string,
  recheck: () => Promise<YankAuditResult>,
  options: { startedAtMs?: number; backgroundDeadlineMs?: number; fallbackDeadlineMs?: number } = {},
): Promise<YankAuditResult> {
  const backgroundDeadlineMs = options.backgroundDeadlineMs ?? 50_000;
  const fallbackDeadlineMs = options.fallbackDeadlineMs ?? 45_000;
  const remaining = Math.max(0, backgroundDeadlineMs - (Date.now() - (options.startedAtMs ?? Date.now())));
  const existing = readYankAuditResult(resultPath);
  if (existing?.yanked?.length) return { ...existing, status: "yanked" };
  if (existing && (existing.status === "clean" || existing.status === "yanked")) return existing;
  if ((!existing || existing.status === "pending") && remaining > 0) {
    const joined = await waitForYankAuditResult(resultPath, { timeoutMs: remaining });
    if (joined.yanked?.length) return { ...joined, status: "yanked" };
    if (joined.status === "clean" || joined.status === "yanked") return joined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      recheck(),
      new Promise<YankAuditResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "not-checked", errors: ["foreground recheck deadline exceeded"] }), fallbackDeadlineMs);
      }),
    ]);
  } catch (error) {
    return { status: "not-checked", errors: [error instanceof Error ? error.message : String(error)] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runYankAuditWorker(configPath: string, resultPath: string): Promise<void> {
  try {
    writeYankAuditResult(resultPath, { status: "pending", workerPid: process.pid });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as YankAuditWorkerConfig;
    const result = await auditDependencyYanks(config.dependencies, {
      requestTimeoutMs: config.requestTimeoutMs,
      overallTimeoutMs: config.overallTimeoutMs,
    });
    writeYankAuditResult(resultPath, result);
  } catch (err) {
    writeYankAuditResult(resultPath, {
      status: "not-checked",
      checkedAt: new Date().toISOString(),
      errors: [err instanceof Error ? err.message : String(err)],
    });
  }
}
