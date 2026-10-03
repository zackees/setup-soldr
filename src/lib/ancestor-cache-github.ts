import { execFile } from "node:child_process";
import * as github from "@actions/github";
import {
  ancestorKeyPrefix, dagDistances, makeAncestorKey, selectAncestorCache,
  type AncestorCacheEntry, type AncestorKey, type AncestorSelection, type GitParentNode,
} from "./ancestor-cache.js";

export const CLEAN_SAVE_MARKER = "setup-soldr-ancestor-clean-save-v1 ";
export interface CleanSaveProof {
  cacheId: number; key: string; ref: string; sha: string;
  runId: number; attempt: number; clean: true;
}

export function hasCleanSaveProof(log: string, entry: AncestorCacheEntry, key: AncestorKey): boolean {
  for (const line of log.split("\n")) {
    const position = line.indexOf(CLEAN_SAVE_MARKER);
    if (position < 0) continue;
    try {
      const proof = JSON.parse(line.slice(position + CLEAN_SAVE_MARKER.length)) as Partial<CleanSaveProof>;
      if (proof.clean === true && proof.cacheId === entry.id && proof.key === entry.key &&
          proof.ref === entry.ref && proof.sha === key.sha && proof.runId === key.runId && proof.attempt === key.attempt) return true;
    } catch { /* Unknown or truncated metadata is not a clean save. */ }
  }
  return false;
}

async function git(workspace: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args,
    { cwd: workspace, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}

function parseParents(text: string): GitParentNode[] {
  return text.split("\n").filter(Boolean).map(line => {
    const [sha, ...parents] = line.split(" ");
    if (!sha || ![sha, ...parents].every(value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) {
      throw new Error("invalid Git DAG output");
    }
    return { sha, parents };
  });
}

export interface AncestorRestorePlan {
  writeKey: string;
  selection: AncestorSelection;
  writer: AncestorKey;
  ref: string;
  elapsedMs: number;
  requests: number;
}

/** All remote calls are GETs. There is no manifest, payload promotion, or
 * remote cache mutation here. Normal post-phase save gates own publication. */
export async function planAncestorRestore(options: {
  workspace: string; identity: string; token: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<AncestorRestorePlan> {
  const start = Date.now();
  const { workspace, identity, token, env } = options;
  if (!token) throw new Error("ancestor lookup requires an actions: read token");
  const [owner, repo, extra] = (env["GITHUB_REPOSITORY"] ?? "").split("/");
  if (!owner || !repo || extra) throw new Error("missing GitHub repository");
  const ref = env["GITHUB_REF"] ?? "";
  if (!/^refs\/(heads\/[^\s]+|pull\/[1-9][0-9]*\/merge)$/.test(ref)) throw new Error("unsupported cache ref");
  const sha = await git(workspace, ["rev-parse", "HEAD"]);
  const pr = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(ref);
  const writer: AncestorKey = { identity, sha, runId: Number(env["GITHUB_RUN_ID"]),
    attempt: Number(env["GITHUB_RUN_ATTEMPT"]), pr: pr ? Number(pr[1]) : null };
  let writeKey = makeAncestorKey(writer);
  const octokit = github.getOctokit(token, { request: { timeout: 15_000 } });
  let requests = 0;
  function requestBudget(): void {
    if (Date.now() - start > 45_000 || ++requests > 24) {
      throw new Error("ancestor lookup exceeded time/request budget");
    }
  }
  const eventRepository = github.context.payload.repository;
  const defaultBranch = eventRepository?.default_branch;
  const refs = [...new Set([ref,
    ...(env["GITHUB_BASE_REF"] ? [`refs/heads/${env["GITHUB_BASE_REF"]}`] : []),
    ...(defaultBranch ? [`refs/heads/${defaultBranch}`] : []),
  ])];
  let distances: ReadonlyMap<string, number> | null = null;
  let shallow = false;
  async function localDistances(): Promise<ReadonlyMap<string, number>> {
    if (distances) return distances;
    shallow = await git(workspace, ["rev-parse", "--is-shallow-repository"]) === "true";
    if (shallow) {
      // A bounded fetch improves the local path without changing checkout or
      // persistent Git configuration. Failure uses the compare fallback.
      try { await git(workspace, ["fetch", "--no-tags", "--depth=200", "origin", sha]); } catch { /* compare below */ }
    }
    const nodes = parseParents(await git(workspace, ["rev-list", "--max-count=200", "--parents", sha]));
    distances = dagDistances(sha, nodes);
    return distances;
  }
  const selection = await selectAncestorCache(identity, refs, {
    list: async () => {
      const entries: AncestorCacheEntry[] = [];
      for (const scope of refs) {
        for (let page = 1; page <= 2; page++) {
          requestBudget();
          const result = await octokit.rest.actions.getActionsCacheList({ owner, repo, ref: scope,
            key: ancestorKeyPrefix(identity), per_page: 100, page });
          if (result.data.total_count > 200) throw new Error("cache scope exceeds 200-entry scan bound");
          for (const entry of result.data.actions_caches) {
            if (entry.id && entry.key && entry.ref && entry.created_at) {
              entries.push({ id: entry.id, key: entry.key, ref: entry.ref, createdAt: entry.created_at });
            }
          }
          if (result.data.actions_caches.length < 100) break;
        }
      }
      return entries;
    },
    distance: async candidate => {
      if (Date.now() - start > 45_000) throw new Error("ancestor lookup exceeded time budget");
      const local = await localDistances();
      if (local.has(candidate)) {
        await git(workspace, ["merge-base", "--is-ancestor", candidate, sha]);
        return local.get(candidate)!;
      }
      // A candidate outside the bounded local graph may still be a near
      // ancestor across a wide merge. Compare its bounded DAG instead of
      // silently treating unknown distance as divergence.
      requestBudget();
      const first = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo,
        basehead: `${candidate}...${sha}`, per_page: 100, page: 1 });
      if (first.data.behind_by !== 0 || !["ahead", "identical"].includes(first.data.status)) return null;
      if (first.data.total_commits > 199) throw new Error("compare exceeds 200-commit DAG bound");
      const nodes: GitParentNode[] = [{ sha: candidate, parents: [] },
        ...first.data.commits.map(commit => ({ sha: commit.sha, parents: commit.parents.map(parent => parent.sha) }))];
      if (first.data.total_commits > 100) {
        requestBudget();
        const second = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo,
          basehead: `${candidate}...${sha}`, per_page: 100, page: 2 });
        nodes.push(...second.data.commits.map(commit => ({ sha: commit.sha, parents: commit.parents.map(parent => parent.sha) })));
      }
      return dagDistances(sha, nodes).get(candidate) ?? null;
    },
    cleanSave: async (entry, key) => {
      requestBudget();
      const run = await octokit.rest.actions.getWorkflowRunAttempt({ owner, repo,
        run_id: key.runId, attempt_number: key.attempt });
      if (run.data.status !== "completed" || run.data.conclusion !== "success") return false;
      requestBudget();
      const jobs = await octokit.rest.actions.listJobsForWorkflowRunAttempt({ owner, repo,
        run_id: key.runId, attempt_number: key.attempt, per_page: 100 });
      if (jobs.data.total_count > 100) throw new Error("donor job scan exceeds bound");
      for (const job of jobs.data.jobs) {
        if (job.conclusion !== "success") continue;
        const created = Date.parse(entry.createdAt);
        const started = Date.parse(job.started_at ?? "");
        const completed = Date.parse(job.completed_at ?? "");
        if (![created, started, completed].every(Number.isFinite) || created < started || created > completed) continue;
        requestBudget();
        const download = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: job.id });
        // Octokit follows the short-lived log redirect. It must not become a
        // persistent index: unavailable/oversize logs use legacy fallback.
        const log = download.data as unknown;
        if (typeof log !== "string" || Buffer.byteLength(log) > 32 * 1024 * 1024) throw new Error("donor log unavailable or oversized");
        if (hasCleanSaveProof(log, entry, key)) return true;
      }
      return false;
    },
  });
  if (selection.entry && selection.distance === 0) writeKey = selection.entry.key;
  return { writeKey, selection, writer, ref, elapsedMs: Date.now() - start, requests };
}
