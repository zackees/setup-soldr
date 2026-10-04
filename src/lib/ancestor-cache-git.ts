import { dagDistances, type GitParentNode } from "./ancestor-cache.js";

export type GitHistoryRunner = (args: readonly string[]) => Promise<string>;

function parseParents(text: string): GitParentNode[] {
  return text.split("\n").filter(Boolean).map(line => {
    const [sha, ...parents] = line.split(" ");
    if (!sha || ![sha, ...parents].every(value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) {
      throw new Error("invalid Git DAG output");
    }
    return { sha, parents };
  });
}

/** Local history is bounded to 200 nodes. Missing candidates stay unknown so
 * the caller can use its existing bounded authenticated compare fallback. */
export class BoundedGitHistory {
  private distances: ReadonlyMap<string, number> | null = null;
  private shallow = false;
  private fetched = false;

  private readonly sha: string;
  private readonly run: GitHistoryRunner;

  constructor(sha: string, run: GitHistoryRunner) {
    this.sha = sha;
    this.run = run;
  }

  private async load(): Promise<void> {
    const shallow = await this.run(["rev-parse", "--is-shallow-repository"]) === "true";
    const nodes = parseParents(await this.run(["rev-list", "--max-count=200", "--parents", this.sha]));
    this.distances = dagDistances(this.sha, nodes);
    this.shallow = shallow;
  }

  async distance(candidate: string): Promise<number | null> {
    if (!this.distances) await this.load();
    if (!this.distances!.has(candidate) && this.shallow && !this.fetched) {
      this.fetched = true;
      try {
        await this.run(["fetch", "--no-tags", "--depth=200", "origin", this.sha]);
        await this.load();
      } catch { /* Existing local history remains usable; unknown uses compare. */ }
    }
    const distance = this.distances!.get(candidate);
    if (distance === undefined) return null;
    await this.run(["merge-base", "--is-ancestor", candidate, this.sha]);
    return distance;
  }
}
