/**
 * Asynchronous yanked-dependency detection for restored cache layers (#476).
 *
 * A yank is a TRUST change, not a content change. `Cargo.lock` is byte-identical
 * after a crate is yanked, so `lockHash` — and therefore the whole cache key —
 * is unchanged, and a closure built from the yanked crate keeps matching. With
 * Actions cache entries being immutable (#475), that closure is self-poisoning:
 * every later run rematerializes the withdrawn code and reports success.
 *
 * Content-addressed keys are the right design and structurally cannot express
 * this, so invalidation comes from outside the key:
 *
 *   check asynchronously → on detection, delete the key AND fail the run
 *
 * The build that discovers the yank fails; the next run misses honestly,
 * rebuilds against current registry state, and self-heals. Steady state costs
 * nothing because the check never sits on the critical path.
 *
 * CRITICAL: "asynchronous" means off the critical path, NOT fire-and-forget. A
 * run that goes green while the check is still in flight has no check at all on
 * exactly the runs where it matters. Callers MUST join the outstanding check
 * (see `awaitYankVerdict`) before reporting success.
 */

import * as fsp from "node:fs/promises";

/** What the check concluded. `not-checked` is never a pass. */
export type YankStatus = "clean" | "yanked" | "not-checked";

export interface YankedDep {
  name: string;
  version: string;
}

export interface YankVerdict {
  status: YankStatus;
  /** Populated when status is "yanked". */
  yanked: YankedDep[];
  /** Why the check could not run, when status is "not-checked". */
  reason?: string;
}

/**
 * Test seam (#476). `SOLDR_TEST_DEP_YANKED=arrayref` makes the checker treat
 * `arrayref` as yanked without contacting a registry, so the abort-and-delete
 * path is exercisable in unit tests and in a real workflow run.
 *
 * Comma-separated for multiple: `SOLDR_TEST_DEP_YANKED=arrayref,libc`.
 */
export const TEST_YANK_ENV = "SOLDR_TEST_DEP_YANKED";

export function testYankedNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[TEST_YANK_ENV] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse `name`/`version` pairs out of a Cargo.lock.
 *
 * Deliberately a small hand parser rather than a TOML dependency: the lockfile
 * shape here is fixed and trivial, and the whole point of this module is to
 * cost nothing on the common path.
 */
export function parseLockfileDeps(text: string): YankedDep[] {
  const deps: YankedDep[] = [];
  let name: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      name = null;
      continue;
    }
    const m = /^(name|version)\s*=\s*"([^"]*)"$/.exec(line);
    if (!m) continue;
    if (m[1] === "name") name = m[2] ?? null;
    else if (name) {
      deps.push({ name, version: m[2] ?? "" });
      name = null;
    }
  }
  return deps;
}

export interface YankCheckOpts {
  lockfilePath: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam — real registry lookup. Omitted means "registry not consulted". */
  lookupYanked?: (deps: YankedDep[]) => Promise<YankedDep[]>;
}

/**
 * Run the check. Never throws: a checker that can crash the build on its own
 * fault is worse than the fault it detects. Failures become "not-checked",
 * which callers must surface rather than treat as a pass.
 */
export async function checkYankedDeps(opts: YankCheckOpts): Promise<YankVerdict> {
  const env = opts.env ?? process.env;
  let deps: YankedDep[];
  try {
    deps = parseLockfileDeps(await fsp.readFile(opts.lockfilePath, "utf8"));
  } catch (err) {
    return {
      status: "not-checked",
      yanked: [],
      reason: `lockfile unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (deps.length === 0) {
    return { status: "not-checked", yanked: [], reason: "lockfile declared no packages" };
  }

  const forced = testYankedNames(env);
  if (forced.length > 0) {
    const hits = deps.filter((d) => forced.includes(d.name));
    return hits.length > 0
      ? { status: "yanked", yanked: hits }
      : { status: "clean", yanked: [] };
  }

  if (!opts.lookupYanked) {
    return { status: "not-checked", yanked: [], reason: "no registry lookup configured" };
  }
  try {
    const hits = await opts.lookupYanked(deps);
    return hits.length > 0 ? { status: "yanked", yanked: hits } : { status: "clean", yanked: [] };
  } catch (err) {
    return {
      status: "not-checked",
      yanked: [],
      reason: `registry unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Join an in-flight check before the build is allowed to report success (#476).
 *
 * A timeout is acceptable and should be generous, but its expiry is
 * "not-checked" — NOT an all-clear. The check being slow is not evidence that
 * nothing is yanked.
 */
export async function awaitYankVerdict(
  pending: Promise<YankVerdict>,
  timeoutMs: number,
): Promise<YankVerdict> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<YankVerdict>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "not-checked",
          yanked: [],
          reason: `check did not finish within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    // Deliberately NOT unref'd. This timer is the thing standing between a
    // pending check and a build reporting success; letting the event loop
    // drain past it would reintroduce exactly the fire-and-forget hole this
    // join exists to close (#476). It is always cleared in the finally below,
    // so it cannot hold the process open longer than the race.
  });
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The message a run fails with. Names crate, version, and the poisoned key. */
export function yankAbortMessage(verdict: YankVerdict, cacheKey: string): string {
  const list = verdict.yanked.map((d) => `${d.name}@${d.version}`).join(", ");
  return (
    `yanked dependency in the restored cache closure: ${list}. ` +
    `Failing this run rather than shipping withdrawn code. The cache key that ` +
    `carried it (${cacheKey}) is being deleted, so the next run rebuilds ` +
    `against current registry state and self-heals.`
  );
}
