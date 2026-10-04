// Private host state for the data-only transport. Source execution never mounts
// this directory: only its build-cache child is writable in the source sandbox.
// The SDK hashes path strings into its cache version, so save and restore must
// use the same relative archive name even when the owned directory is fresh.
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const DATA_ARCHIVE_BASENAME = "build-cache.tar.zst";
export const DATA_ARCHIVE_MAX_BYTES = 209_715_200;

export interface DataWorkspace {
  root: string;
  cache: string;
  archive: string;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function createDataWorkspace(runnerTemp: string, source: string): Promise<DataWorkspace> {
  const temporary = await fs.realpath(runnerTemp);
  const sourceRoot = await fs.realpath(source);
  if (temporary !== path.resolve(runnerTemp) || sourceRoot !== path.resolve(source)) {
    throw new Error("data transport roots must not use symlink aliases");
  }
  if (within(sourceRoot, temporary) || within(temporary, sourceRoot)) {
    throw new Error("data transport and source roots must be separate");
  }
  const root = await fs.mkdtemp(path.join(temporary, "setup-soldr-data-"));
  await fs.chmod(root, 0o700);
  const cache = path.join(root, "build-cache");
  await fs.mkdir(cache, { mode: 0o700 });
  return { root, cache, archive: path.join(root, DATA_ARCHIVE_BASENAME) };
}

let scoped = false;

export async function withDataArchiveWorkspace<T>(workspace: DataWorkspace, operation: (paths: string[]) => Promise<T>): Promise<T> {
  if (scoped) throw new Error("data archive workspace operations must be serial");
  const previousDirectory = process.cwd();
  const previousWorkspace = process.env["GITHUB_WORKSPACE"];
  scoped = true;
  try {
    if (await fs.realpath(workspace.root) !== workspace.root ||
        workspace.cache !== path.join(workspace.root, "build-cache") ||
        workspace.archive !== path.join(workspace.root, DATA_ARCHIVE_BASENAME)) {
      throw new Error("invalid private data archive workspace");
    }
    process.chdir(workspace.root);
    // Process-local only: never export this value into the workflow environment.
    process.env["GITHUB_WORKSPACE"] = workspace.root;
    return await operation([DATA_ARCHIVE_BASENAME]);
  } finally {
    try {
      process.chdir(previousDirectory);
    } finally {
      if (previousWorkspace === undefined) delete process.env["GITHUB_WORKSPACE"];
      else process.env["GITHUB_WORKSPACE"] = previousWorkspace;
      scoped = false;
    }
  }
}

export async function validateDataArchive(workspace: DataWorkspace): Promise<number> {
  const metadata = await fs.lstat(workspace.archive);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > DATA_ARCHIVE_MAX_BYTES) {
    throw new Error("data archive must be a bounded nonempty regular file");
  }
  return metadata.size;
}
