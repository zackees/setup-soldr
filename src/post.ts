// setup-soldr post-job entry point. Owned by Agent 2.
//
// Runs in the post-job phase via action.yml's `post: dist/post.js`. This is
// the architectural fix for zackees/setup-soldr#70 — it lets us tar+zstd
// the build-cache (and optionally cargo-registry) directories BEFORE
// @actions/cache's post-save uploads them, so the wire format is zstd on
// every platform (including Windows-x64 where actions/cache@v5 still
// falls back to gzip).
//
// Reads back the resolve plan from $GITHUB_STATE (set by main.ts) and acts
// on the configured cache directories.

import * as core from "@actions/core";

async function run(): Promise<void> {
  void core;
  throw new Error("not implemented: setup-soldr post");
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  core.warning(`setup-soldr post-job step failed: ${message}`);
});
