import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoKeyEnabled, dagDistances, makeAncestorKey, parseAncestorKey, selectAncestorCache,
  type AncestorBackend, type AncestorCacheEntry,
} from "../src/lib/ancestor-cache.js";
import { CLEAN_SAVE_MARKER, hasCleanSaveProof, planAncestorRestore } from "../src/lib/ancestor-cache-github.js";
import { readRawInputs } from "../src/lib/raw-inputs.js";
import { normalizeWorkflowPath, parseTrustedWriters, trustedWriterForRun, type WriterRunMetadata } from "../src/lib/ancestor-cache-trust.js";

const identity = "a".repeat(16);
const head = "1".repeat(40);
const near = "2".repeat(40);
const far = "3".repeat(40);
const diverged = "4".repeat(40);
const ref = "refs/heads/main";
function entry(sha: string, id: number, overrides: Partial<AncestorCacheEntry> = {}): AncestorCacheEntry {
  return { id, key: makeAncestorKey({ identity, sha, runId: id, attempt: 1, pr: null }),
    ref, createdAt: `2026-10-${String(id).padStart(2, "0")}T00:00:00Z`, ...overrides };
}
function backend(entries: AncestorCacheEntry[], clean: readonly number[] = [1, 2, 3]): AncestorBackend {
  const distances = dagDistances(head, [
    { sha: head, parents: [near] }, { sha: near, parents: [far] },
    { sha: far, parents: [] }, { sha: diverged, parents: [] },
  ]);
  return { list: async () => entries, distance: async sha => distances.get(sha) ?? null,
    cleanSave: async candidate => clean.includes(candidate.id) };
}

test("auto opt-in preserves omitted and explicit keys by default", () => {
  assert.equal(autoKeyEnabled(undefined, undefined), false);
  assert.equal(autoKeyEnabled("", "false"), false);
  assert.equal(autoKeyEnabled("auto", "false"), true);
  assert.equal(autoKeyEnabled(undefined, "true"), true);
  assert.equal(autoKeyEnabled("explicit", "true"), false);
});

test("key roundtrip retains source SHA, writer attempt and delimited PR scope", () => {
  const key = { identity, sha: head, runId: 42, attempt: 2, pr: 7 };
  assert.deepEqual(parseAncestorKey(makeAncestorKey(key)), key);
  assert.equal(parseAncestorKey("build-cache-old-no-source"), null);
  assert.throws(() => makeAncestorKey({ ...key, sha: "HEAD; injected" }));
  assert.throws(() => makeAncestorKey({ ...key, runId: Number.MAX_SAFE_INTEGER + 1 }));
});

test("fake DAG selects nearest ancestor instead of newest unrelated cache", async () => {
  const result = await selectAncestorCache(identity, [ref], backend([
    entry(far, 2), entry(near, 1), entry(diverged, 3),
  ]));
  assert.equal(result.entry?.id, 1);
  assert.equal(result.distance, 1);
});

test("merge distance follows shortest parent arm", () => {
  const distances = dagDistances(head, [
    { sha: head, parents: [near, far] }, { sha: near, parents: [far] },
    { sha: far, parents: [] },
  ]);
  assert.equal(distances.get(far), 1);
});

test("entry existence does not prove a clean successful save", async () => {
  const result = await selectAncestorCache(identity, [ref], backend([entry(near, 1), entry(far, 2)], [2]));
  assert.equal(result.entry?.id, 2);
  assert.equal(result.distance, 2);
  assert.equal((await selectAncestorCache(identity, [ref], backend([entry(near, 1)], []))).entry, null);
});

test("identity, own/base/default visibility, and PR key scope are mandatory", async () => {
  const entries = [
    entry(near, 1, { ref: "refs/heads/unrelated" }),
    entry(near, 2, { key: makeAncestorKey({ identity: "b".repeat(16), sha: near, runId: 2, attempt: 1, pr: null }) }),
    entry(near, 3, { ref: "refs/pull/7/merge" }),
  ];
  assert.equal((await selectAncestorCache(identity, [ref, "refs/pull/7/merge"], backend(entries))).entry, null);
});

test("API, shallow-history, and provenance errors preserve legacy restore", async () => {
  for (const stage of ["list", "distance", "cleanSave"] as const) {
    const adapter = backend([entry(near, 1)]);
    adapter[stage] = async () => { throw new Error("bounded backend unavailable"); };
    const result = await selectAncestorCache(identity, [ref], adapter);
    assert.equal(result.entry, null);
    assert.match(result.reason, /^legacy-fallback:/);
  }
});

test("bounded DAG rejects excess history instead of claiming nearest", () => {
  assert.throws(() => dagDistances(head, Array.from({ length: 201 }, () => ({ sha: head, parents: [] }))));
});

test("writer proof binds cache ID, key, actual checkout, attempt and ref", () => {
  const candidate = entry(near, 1);
  const key = parseAncestorKey(candidate.key)!;
  const proof = { cacheId: 1, key: candidate.key, ref, sha: near, runId: 1, attempt: 1, clean: true };
  const writer = parseTrustedWriters(`owner/repo/.github/workflows/ci.yml@${near}:1:1:12`)[0]!;
  assert.equal(hasCleanSaveProof(`2026-10-03T00:00:00Z ${CLEAN_SAVE_MARKER}${JSON.stringify(proof)}`, candidate, key, writer, 12), true);
  for (const change of [{ cacheId: -1 }, { key: "other" }, { ref: "refs/heads/other" },
    { sha: head }, { runId: 2 }, { attempt: 2 }, { clean: false }]) {
    assert.equal(hasCleanSaveProof(`${CLEAN_SAVE_MARKER}${JSON.stringify({ ...proof, ...change })}`, candidate, key, writer, 12), false);
  }
  assert.equal(hasCleanSaveProof(`${CLEAN_SAVE_MARKER}{truncated`, candidate, key, writer, 12), false);
});

test("an arbitrary successful workflow printing exact public metadata cannot authorize a donor", () => {
  const candidate = entry(near, 1);
  const key = parseAncestorKey(candidate.key)!;
  const marker = `${CLEAN_SAVE_MARKER}${JSON.stringify({ cacheId: 1, key: candidate.key,
    ref, sha: near, runId: 1, attempt: 1, clean: true })}`;
  const metadata: WriterRunMetadata = { repository: "owner/repo", headRepository: "owner/repo",
    workflow: ".github/workflows/arbitrary-upload.yml", sha: near, runId: 1, attempt: 1,
    status: "completed", conclusion: "success" };
  const authorized = parseTrustedWriters(`owner/repo/.github/workflows/ci.yml@${near}:1:1:12`);
  assert.equal(hasCleanSaveProof(marker, candidate, key, authorized[0]!, 13), false);
  assert.equal(hasCleanSaveProof(marker, candidate, key, null, 12), false);
  assert.equal(hasCleanSaveProof(marker, candidate, key, trustedWriterForRun([], metadata), 12), false);
  assert.equal(hasCleanSaveProof(marker, candidate, key, trustedWriterForRun(authorized, metadata), 12), false);
});

test("writer authority pins GitHub-authenticated source, repository, workflow, run and attempt", () => {
  const authorized = parseTrustedWriters(`owner/repo/.github/workflows/ci.yml@${near}:1:1:12`);
  const metadata: WriterRunMetadata = { repository: "owner/repo", headRepository: "owner/repo",
    workflow: ".github/workflows/ci.yml", sha: near, runId: 1, attempt: 1,
    status: "completed", conclusion: "success" };
  assert.deepEqual(trustedWriterForRun(authorized, metadata), authorized[0]);
  for (const change of [{ sha: head }, { runId: 2 }, { attempt: 2 }, { repository: "other/repo" },
    { headRepository: "fork/repo" }, { workflow: ".github/workflows/other.yml" },
    { status: "in_progress" }, { conclusion: "failure" }]) {
    assert.equal(trustedWriterForRun(authorized, { ...metadata, ...change }), null);
  }
  assert.equal(normalizeWorkflowPath("owner/repo/.github/workflows/ci.yml@main", "owner/repo"), metadata.workflow);
  assert.throws(() => parseTrustedWriters("owner/repo/.github/workflows/ci.yml@main:1:1:12"));
  assert.throws(() => parseTrustedWriters(`owner/repo/.github/workflows/../ci.yml@${near}:1:1:12`));
});

test("bootstrap writes a normal gated seed but performs no untrusted donor API scan", async () => {
  const plan = await planAncestorRestore({ workspace: process.cwd(), identity, token: "unused-test-token",
    env: { GITHUB_REPOSITORY: "owner/repo", GITHUB_REF: ref, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" } });
  assert.equal(plan.selection.entry, null);
  assert.match(plan.selection.reason, /no reviewed immutable writer/);
  assert.equal(plan.requests, 0);
  assert.equal(parseAncestorKey(plan.writeKey)?.sha, plan.writer.sha);
  assert.equal(parseAncestorKey(plan.writeKey)?.runId, 123);
});

test("action inputs retain explicit opt-in and omitted defaults", () => {
  assert.equal(readRawInputs({ "INPUT_AUTO-KEY": "true", INPUT_KEY: "auto" }).autoKey, "true");
  assert.equal(readRawInputs({ INPUT_AUTO_KEY: "true", INPUT_KEY: "fixed" }).key, "fixed");
  assert.equal(autoKeyEnabled(readRawInputs({}).key, readRawInputs({}).autoKey), false);
});
