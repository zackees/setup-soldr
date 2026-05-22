// Toolchain delta snapshot.
//
// First step of the toolchain solo-cache work: walk $RUSTUP_HOME/toolchains/
// and $CARGO_HOME/bin/ before and after `ensureRustToolchain`, then diff
// the two snapshots to identify exactly which inodes setup-soldr added on
// top of the runner image. The diff is what a future cache layer would
// tar+zstd; this module only measures — no IO writes happen here.
//
// Identity per entry: `(root, relpath, kind, size, linkTarget?)`. We never
// follow symlinks because rustup component shims under $CARGO_HOME/bin form
// chains that, if followed, can re-walk the entire toolchain dir.

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type EntryKind = "file" | "symlink" | "directory";

export interface SnapshotEntry {
  root: string;
  relpath: string;
  kind: EntryKind;
  size: number;
  linkTarget?: string;
}

export interface Snapshot {
  entries: Map<string, SnapshotEntry>;
}

export interface SnapshotDiff {
  added: SnapshotEntry[];
  removed: SnapshotEntry[];
  changed: { before: SnapshotEntry; after: SnapshotEntry }[];
}

export interface DiffStats {
  addedFiles: number;
  addedBytes: number;
  removedFiles: number;
  changedFiles: number;
}

function entryKey(root: string, relpath: string): string {
  return `${root}#${relpath}`;
}

async function walkRoot(root: string, into: Map<string, SnapshotEntry>): Promise<void> {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }

  interface Frame {
    abs: string;
    rel: string;
  }
  const stack: Frame[] = [{ abs: root, rel: "" }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop() as Frame;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const childAbs = path.join(abs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const key = entryKey(root, childRel);
      if (dirent.isSymbolicLink()) {
        let linkTarget = "";
        try {
          linkTarget = await fs.readlink(childAbs);
        } catch {
          linkTarget = "(unreadable)";
        }
        into.set(key, { root, relpath: childRel, kind: "symlink", size: 0, linkTarget });
      } else if (dirent.isFile()) {
        let size = 0;
        try {
          const s = await fs.stat(childAbs);
          size = s.size;
        } catch {
          size = -1;
        }
        into.set(key, { root, relpath: childRel, kind: "file", size });
      } else if (dirent.isDirectory()) {
        into.set(key, { root, relpath: childRel, kind: "directory", size: 0 });
        stack.push({ abs: childAbs, rel: childRel });
      }
    }
  }
}

export async function walkSnapshot(roots: string[]): Promise<Snapshot> {
  const entries = new Map<string, SnapshotEntry>();
  for (const root of roots) {
    await walkRoot(root, entries);
  }
  return { entries };
}

export function diffSnapshots(baseline: Snapshot, post: Snapshot): SnapshotDiff {
  const added: SnapshotEntry[] = [];
  const removed: SnapshotEntry[] = [];
  const changed: { before: SnapshotEntry; after: SnapshotEntry }[] = [];
  for (const [key, postEntry] of post.entries) {
    const baselineEntry = baseline.entries.get(key);
    if (!baselineEntry) {
      added.push(postEntry);
    } else if (
      baselineEntry.kind !== postEntry.kind ||
      baselineEntry.size !== postEntry.size ||
      baselineEntry.linkTarget !== postEntry.linkTarget
    ) {
      changed.push({ before: baselineEntry, after: postEntry });
    }
  }
  for (const [key, baselineEntry] of baseline.entries) {
    if (!post.entries.has(key)) {
      removed.push(baselineEntry);
    }
  }
  return { added, removed, changed };
}

export function diffStats(diff: SnapshotDiff): DiffStats {
  let addedFiles = 0;
  let addedBytes = 0;
  for (const e of diff.added) {
    if (e.kind === "file") {
      addedFiles += 1;
      if (e.size > 0) addedBytes += e.size;
    }
  }
  const removedFiles = diff.removed.filter((e) => e.kind === "file").length;
  const changedFiles = diff.changed.filter((c) => c.after.kind === "file").length;
  return { addedFiles, addedBytes, removedFiles, changedFiles };
}

export function serializeManifest(diff: SnapshotDiff, stats: DiffStats): string {
  const sortByKey = (a: SnapshotEntry, b: SnapshotEntry): number =>
    entryKey(a.root, a.relpath).localeCompare(entryKey(b.root, b.relpath));
  return JSON.stringify(
    {
      stats,
      added: [...diff.added].sort(sortByKey),
      removed: [...diff.removed].sort(sortByKey),
      changed: [...diff.changed].sort((x, y) =>
        entryKey(x.after.root, x.after.relpath).localeCompare(entryKey(y.after.root, y.after.relpath)),
      ),
    },
    null,
    2,
  );
}
