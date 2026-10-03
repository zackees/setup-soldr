/** Opt-in source-build cache selection. Remote and Git adapters stay outside
 * this module so ancestry, visibility, and save provenance can be tested with
 * a fake DAG. Unknown provenance never qualifies for ancestor selection. */
export interface AncestorCacheEntry {
  id: number;
  key: string;
  ref: string;
  createdAt: string;
}

export interface AncestorKey {
  identity: string;
  sha: string;
  runId: number;
  attempt: number;
  pr: number | null;
}

export interface AncestorSelection {
  entry: AncestorCacheEntry | null;
  distance: number | null;
  reason: string;
  inspected: number;
}

export interface AncestorBackend {
  list(): Promise<readonly AncestorCacheEntry[]>;
  distance(sha: string): Promise<number | null>;
  cleanSave(entry: AncestorCacheEntry, key: AncestorKey): Promise<boolean>;
}

export function autoKeyEnabled(key: string | undefined, flag: string | undefined): boolean {
  const explicit = (key ?? "").trim();
  return explicit === "auto" || (explicit === "" && (flag ?? "").trim().toLowerCase() === "true");
}

export function ancestorKeyPrefix(identity: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(identity)) throw new Error("invalid ancestor cache identity");
  return `setup-soldr-ancestor-build-v1-${identity}-`;
}

export function makeAncestorKey(key: AncestorKey): string {
  const prefix = ancestorKeyPrefix(key.identity);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(key.sha) ||
      !Number.isSafeInteger(key.runId) || key.runId <= 0 ||
      !Number.isSafeInteger(key.attempt) || key.attempt <= 0 ||
      (key.pr !== null && (!Number.isSafeInteger(key.pr) || key.pr <= 0))) {
    throw new Error("invalid ancestor cache provenance");
  }
  return `${prefix}source-${key.sha}-run-${key.runId}-attempt-${key.attempt}${key.pr === null ? "" : `-pr-${key.pr}`}`;
}

export function parseAncestorKey(value: string): AncestorKey | null {
  const match = /^setup-soldr-ancestor-build-v1-([0-9a-f]{16,64})-source-([0-9a-f]{40}|[0-9a-f]{64})-run-([1-9][0-9]*)-attempt-([1-9][0-9]*)(?:-pr-([1-9][0-9]*))?$/.exec(value);
  if (!match) return null;
  const key: AncestorKey = {
    identity: match[1]!, sha: match[2]!, runId: Number(match[3]),
    attempt: Number(match[4]), pr: match[5] ? Number(match[5]) : null,
  };
  try { return makeAncestorKey(key) === value ? key : null; } catch { return null; }
}

/** Nearest means shortest parent-edge distance, rather than date or the
 * compare API's ahead_by (which counts commits on both arms of a merge).
 * Any backend error preserves the caller's existing restore path. */
export async function selectAncestorCache(
  identity: string, refs: readonly string[], backend: AncestorBackend,
): Promise<AncestorSelection> {
  let inspected = 0;
  try {
    const entries = await backend.list();
    if (entries.length > 600) throw new Error("candidate scan exceeded bound");
    const ranked: { entry: AncestorCacheEntry; key: AncestorKey; distance: number }[] = [];
    for (const entry of entries) {
      const key = parseAncestorKey(entry.key);
      if (!key || key.identity !== identity || !refs.includes(entry.ref) || entry.id <= 0) continue;
      const pr = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(entry.ref);
      if (key.pr !== (pr ? Number(pr[1]) : null)) continue;
      inspected++;
      if (inspected > 200) throw new Error("ancestry candidate bound exceeded");
      const distance = await backend.distance(key.sha);
      if (distance !== null && Number.isSafeInteger(distance) && distance >= 0 && distance <= 200) {
        ranked.push({ entry, key, distance });
      }
    }
    ranked.sort((a, b) => a.distance - b.distance ||
      b.entry.createdAt.localeCompare(a.entry.createdAt) || b.entry.id - a.entry.id);
    for (const candidate of ranked.slice(0, 20)) {
      if (await backend.cleanSave(candidate.entry, candidate.key)) {
        return { entry: candidate.entry, distance: candidate.distance, reason: "nearest-clean-ancestor", inspected };
      }
    }
    return { entry: null, distance: null, reason: "no-proven-clean-ancestor", inspected };
  } catch (error) {
    return { entry: null, distance: null, reason: `legacy-fallback: ${error instanceof Error ? error.message : String(error)}`, inspected };
  }
}

export interface GitParentNode { sha: string; parents: readonly string[] }

export function dagDistances(head: string, nodes: readonly GitParentNode[]): ReadonlyMap<string, number> {
  if (nodes.length > 200) throw new Error("Git DAG exceeds 200 commits");
  const parents = new Map(nodes.map(node => [node.sha, node.parents]));
  const distances = new Map<string, number>([[head, 0]]);
  const queue = [head];
  for (let position = 0; position < queue.length; position++) {
    const sha = queue[position]!;
    for (const parent of parents.get(sha) ?? []) {
      if (!parents.has(parent) || distances.has(parent)) continue;
      distances.set(parent, distances.get(sha)! + 1);
      queue.push(parent);
    }
  }
  return distances;
}
