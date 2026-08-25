import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { prepareDylint } from "../src/lib/prepare-dylint.js";

test("disabled Dylint mode performs no preparation", async () => {
  let called = false;
  const paths = await prepareDylint({
    enabled: false,
    soldrPath: "/tools/soldr",
    soldrRoot: "/cache/soldr",
    workspace: "/workspace",
    cargoDylintVersion: "6.0.3",
    dylintLinkVersion: "6.0.3",
    execCommand: async () => {
      called = true;
      return 0;
    },
  });
  assert.equal(called, false);
  assert.deepEqual(paths, []);
});

test("Dylint mode delegates preparation to Soldr and exports managed tool directories", async () => {
  const added: string[] = [];
  let invocation:
    | { command: string; args: string[]; cwd: string; forceManaged: string | undefined }
    | undefined;
  const paths = await prepareDylint({
    enabled: true,
    soldrPath: "/tools/soldr",
    soldrRoot: "/cache/soldr",
    workspace: "/workspace",
    cargoDylintVersion: "6.0.3",
    dylintLinkVersion: "6.0.3",
    execCommand: async (command, args, options) => {
      invocation = {
        command,
        args,
        cwd: options.cwd,
        forceManaged: options.env["SOLDR_FORCE_MANAGED_CARGO_SUBCOMMANDS"],
      };
      return 0;
    },
    exists: () => true,
    addPath: (directory) => added.push(directory),
  });

  assert.deepEqual(invocation, {
    command: "/tools/soldr",
    args: ["dylint", "prepare"],
    cwd: "/workspace",
    forceManaged: "1",
  });
  assert.deepEqual(paths, [
    path.join("/cache/soldr", "bin", "cargo-dylint-6.0.3"),
    path.join("/cache/soldr", "bin", "dylint-link-6.0.3"),
  ]);
  assert.deepEqual(added, paths);
});

test("Dylint mode fails closed when setup pins do not match Soldr's materialized tools", async () => {
  await assert.rejects(
    () =>
      prepareDylint({
        enabled: true,
        soldrPath: "/tools/soldr",
        soldrRoot: "/cache/soldr",
        workspace: "/workspace",
        cargoDylintVersion: "99.0.0",
        dylintLinkVersion: "99.0.0",
        execCommand: async () => 0,
        exists: () => false,
      }),
    /Dylint pin must match the installed Soldr release/,
  );
});

test("a failed Soldr preparation stops setup", async () => {
  await assert.rejects(
    () =>
      prepareDylint({
        enabled: true,
        soldrPath: "/tools/soldr",
        soldrRoot: "/cache/soldr",
        workspace: "/workspace",
        cargoDylintVersion: "6.0.3",
        dylintLinkVersion: "6.0.3",
        execCommand: async () => 17,
      }),
    /failed with exit code 17/,
  );
});
