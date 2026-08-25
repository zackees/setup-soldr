import * as fs from "node:fs";
import * as path from "node:path";
import * as exec from "@actions/exec";

type ExecCommand = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; ignoreReturnCode: boolean },
) => Promise<number>;

export interface PrepareDylintOptions {
  enabled: boolean;
  soldrPath: string;
  soldrRoot: string;
  workspace: string;
  cargoDylintVersion: string;
  dylintLinkVersion: string;
  execCommand?: ExecCommand;
  exists?: (candidate: string) => boolean;
  addPath?: (directory: string) => void;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
}

function executableName(tool: string): string {
  return process.platform === "win32" ? `${tool}.exe` : tool;
}

/**
 * Ask Soldr to materialize and verify the complete pinned Dylint foundation.
 *
 * setup-soldr owns when this happens; Soldr owns which catalogued binaries,
 * nightly components, and driver are valid. The versioned tool directories
 * are then exported for Dylint UI tests whose nested Cargo process invokes
 * `dylint-link` directly rather than returning through `soldr cargo dylint`.
 */
export async function prepareDylint(options: PrepareDylintOptions): Promise<string[]> {
  if (!options.enabled) return [];

  const run = options.execCommand ?? exec.exec;
  const code = await run(options.soldrPath, ["dylint", "prepare"], {
    cwd: options.workspace,
    env: {
      ...processEnvironment(),
      SOLDR_FORCE_MANAGED_CARGO_SUBCOMMANDS: "1",
    },
    ignoreReturnCode: true,
  });
  if (code !== 0) {
    throw new Error(`soldr dylint prepare failed with exit code ${code}`);
  }

  const tools = [
    ["cargo-dylint", options.cargoDylintVersion],
    ["dylint-link", options.dylintLinkVersion],
  ] as const;
  const exists = options.exists ?? fs.existsSync;
  const directories = tools.map(([tool, version]) => {
    const directory = path.join(options.soldrRoot, "bin", `${tool}-${version}`);
    const binary = path.join(directory, executableName(tool));
    if (!exists(binary)) {
      throw new Error(
        `soldr dylint prepare did not materialize ${tool} ${version} at ${binary}; ` +
          "the setup-soldr Dylint pin must match the installed Soldr release",
      );
    }
    return directory;
  });

  for (const directory of directories) options.addPath?.(directory);
  return directories;
}
