#!/usr/bin/env node
// Deletes the Actions cache entries this workflow run created, which nobody
// can ever read again (#513 P0).
//
// The cook validation workflows put `${run_id}-${run_attempt}` into
// `cache-key-suffix`, so every entry they save is namespaced to one
// immutable run and becomes pure quota debt the moment the run completes —
// 24 of the repository's 70 entries when this landed. This script deletes
// exactly that namespace and nothing else.
//
// Namespace contract: CACHE_GENERATION is `<workflow>-<run_id>-<run_attempt>`
// (or `consumer-<cache_key>-<run_id>-<run_attempt>` for the reusable
// consumer lane). The deletion prefix strips only the trailing attempt
// digits, keeping the dash:
//
//   cook-selftest-35670871242-1  ->  cook-selftest-35670871242-
//
// so earlier attempts of the *same* run are swept too, while the trailing
// dash stops `cook-selftest-123-` from ever matching run 1234's keys. The
// prefix must still embed GITHUB_RUN_ID after stripping — a namespace typo
// that doesn't name THIS run refuses to run instead of sweeping someone
// else's entries. Scoping stays per workflow (and per consumer cache_key)
// so sibling instances of a reusable workflow sharing one run_id cannot
// delete each other's in-flight entries.
//
// Permission reality: deletion needs `actions: write`. Fork PR tokens are
// read-only no matter what the workflow grants, so those runs warn and exit
// 0 — a token GitHub will not upgrade must not redden the run. Everything
// else fails loudly: entries left over after verification retries, or
// transport errors, exit 1 so an ineffective cleanup job cannot masquerade
// as green.

import { pathToFileURL } from "node:url";

const API_PAGE_SIZE = 100;
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_MS = 2000;

function isPermissionStatus(status) {
  return status === 401 || status === 403;
}

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "setup-soldr-delete-run-scoped-caches",
  };
}

/**
 * Derives the deletion prefix from CACHE_GENERATION. Throws when the
 * namespace does not provably name `runId`'s run — the guard that keeps a
 * malformed generation from sweeping other runs' entries.
 */
export function deriveNamespacePrefix(cacheGeneration, runId) {
  const generation = (cacheGeneration ?? "").trim();
  const rid = (runId ?? "").trim();
  if (!rid) {
    throw new Error("GITHUB_RUN_ID is empty; refusing to delete caches without an exact run namespace.");
  }
  if (!/^\d+$/.test(rid)) {
    throw new Error(`GITHUB_RUN_ID ${JSON.stringify(rid)} is not numeric; refusing to delete caches.`);
  }
  if (!generation) {
    throw new Error("CACHE_GENERATION is empty; refusing to delete caches without an exact run namespace.");
  }
  if (!generation.includes(rid)) {
    throw new Error(
      `CACHE_GENERATION ${JSON.stringify(generation)} does not embed run id ${rid}; refusing to delete caches.`,
    );
  }
  const prefix = generation.replace(/\d+$/, "");
  if (!prefix.endsWith("-")) {
    throw new Error(
      `CACHE_GENERATION ${JSON.stringify(generation)} must end with -<run_attempt> so the deletion prefix ` +
        `keeps its trailing dash; refusing to delete caches.`,
    );
  }
  if (!prefix.includes(rid)) {
    throw new Error(
      `derived namespace ${JSON.stringify(prefix)} does not embed run id ${rid}; ` +
        `CACHE_GENERATION must be <workflow>-<run_id>-<run_attempt>.`,
    );
  }
  return prefix;
}

/** True when a cache key carries this run's deletion prefix. */
export function matchesNamespace(key, prefix) {
  return typeof key === "string" && key.includes(prefix);
}

async function listAllCaches({ fetchImpl, apiBase, repo, token, ref }) {
  const all = [];
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : "";
  for (let page = 1; ; page += 1) {
    const url = `${apiBase}/repos/${repo}/actions/caches?per_page=${API_PAGE_SIZE}&page=${page}${refParam}`;
    const res = await fetchImpl(url, { headers: apiHeaders(token) });
    if (!res.ok) {
      const err = new Error(`listing Actions caches failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    const items = Array.isArray(body.actions_caches) ? body.actions_caches : [];
    // Belt and braces for the server-side ref filter: never act on an
    // entry that belongs to another ref (#513).
    all.push(...(ref ? items.filter((entry) => !entry.ref || entry.ref === ref) : items));
    if (items.length < API_PAGE_SIZE) break;
  }
  return all;
}

/**
 * Deletes every cache entry keyed under this run's namespace and verifies
 * they are actually gone. Injectable deps keep unit tests off the network.
 */
export async function deleteRunScopedCaches(deps) {
  const {
    runId,
    cacheGeneration,
    repo,
    token,
    ref = "",
    fetchImpl = globalThis.fetch,
    apiBase = process.env.GITHUB_API_URL || "https://api.github.com",
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  if (!repo) throw new Error("GITHUB_REPOSITORY is empty; cannot address the repository's caches.");
  if (!token) throw new Error("no token supplied (GH_TOKEN / GITHUB_TOKEN); cannot delete caches.");

  const prefix = deriveNamespacePrefix(cacheGeneration, runId);

  let caches;
  try {
    caches = await listAllCaches({ fetchImpl, apiBase, repo, token, ref });
  } catch (err) {
    if (isPermissionStatus(err.status)) {
      return { prefix, matched: [], deleted: 0, gone: 0, failed: [], leftover: [], permissionDenied: true };
    }
    throw err;
  }

  const matched = caches.filter((entry) => matchesNamespace(entry.key, prefix));
  let deleted = 0;
  let gone = 0;
  let permissionDenied = false;
  const failed = [];

  for (const entry of matched) {
    const url = `${apiBase}/repos/${repo}/actions/caches/${entry.id}`;
    const res = await fetchImpl(url, { method: "DELETE", headers: apiHeaders(token) });
    if (res.ok) {
      deleted += 1;
    } else if (res.status === 404) {
      // Already gone (concurrent sibling cleanup or manual delete) — the
      // desired end state, not a failure.
      gone += 1;
    } else if (isPermissionStatus(res.status)) {
      permissionDenied = true;
      break;
    } else {
      failed.push({ id: entry.id, key: entry.key, status: res.status });
    }
  }

  // Verify the namespace is actually empty: a DELETE that returns 2xx but
  // leaves the entry behind must not pass as green.
  let leftover = [];
  if (matched.length > 0 && !permissionDenied && failed.length === 0) {
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleepImpl(VERIFY_RETRY_MS);
      const after = await listAllCaches({ fetchImpl, apiBase, repo, token, ref });
      leftover = after.filter((entry) => matchesNamespace(entry.key, prefix));
      if (leftover.length === 0) break;
    }
  }

  return {
    prefix,
    matched: matched.map((entry) => ({ id: entry.id, key: entry.key })),
    deleted,
    gone,
    failed,
    leftover,
    permissionDenied,
  };
}

async function main() {
  const env = process.env;
  const result = await deleteRunScopedCaches({
    runId: env.GITHUB_RUN_ID,
    cacheGeneration: env.CACHE_GENERATION,
    repo: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN || env.GITHUB_TOKEN,
    // Only this run's ref: a run can only have saved entries on its own ref.
    ref: env.GITHUB_REF || "",
  });

  console.log(
    `delete-run-scoped-caches: prefix=${JSON.stringify(result.prefix)} ref=${JSON.stringify(process.env.GITHUB_REF || "")} ` +
      `matched=${result.matched.length} deleted=${result.deleted} ` +
      `gone=${result.gone} failed=${result.failed.length} leftover=${result.leftover.length}`,
  );
  for (const entry of result.matched) {
    console.log(`  deleted id=${entry.id} key=${entry.key}`);
  }

  if (result.permissionDenied) {
    console.log(
      `::warning::delete-run-scoped-caches: token lacks actions: write (fork PR or restricted ` +
        `workflow token); ${result.matched.length} run-scoped cache key(s) under ` +
        `${JSON.stringify(result.prefix)} were listed but not deleted. Grant the cleanup job ` +
        `actions: write, or delete these keys manually.`,
    );
    return;
  }
  if (result.failed.length > 0) {
    for (const entry of result.failed) {
      console.log(`::error::delete-run-scoped-caches: HTTP ${entry.status} deleting id=${entry.id} key=${entry.key}`);
    }
    process.exitCode = 1;
    return;
  }
  if (result.leftover.length > 0) {
    for (const entry of result.leftover) {
      console.log(`::error::delete-run-scoped-caches: still present after delete: ${entry.key}`);
    }
    process.exitCode = 1;
  }
}

// Run only when executed directly (workflows), not when imported by tests.
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.log(`::error::delete-run-scoped-caches: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
