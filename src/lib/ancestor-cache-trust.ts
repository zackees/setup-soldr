/** Phase 1's bounded pilot trusts explicitly reviewed immutable writer jobs.
 * An arbitrary successful workflow and its stdout are not writer authority.
 * The backend interface remains independent of this policy so a future
 * isolated, automatically authenticated writer can replace it. */
export interface TrustedWriter {
  repository: string;
  workflow: string;
  sha: string;
  runId: number;
  attempt: number;
  jobId: number;
}

export interface WriterRunMetadata {
  repository: string;
  headRepository: string;
  workflow: string;
  sha: string;
  runId: number;
  attempt: number;
  status: string | null;
  conclusion: string | null;
}

/** One line per writer:
 * owner/repo/.github/workflows/file.yml@FULL_SHA:RUN_ID:ATTEMPT:JOB_ID
 * The caller reviews the complete immutable writer execution, including the
 * pinned action/post code and transitive scripts, before authorizing it. */
export function parseTrustedWriters(input: string | undefined): readonly TrustedWriter[] {
  const lines = (input ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 32) throw new Error("trusted writer list exceeds 32 entries");
  return lines.map(line => {
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@([0-9a-f]{40}|[0-9a-f]{64}):([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*)$/.exec(line);
    if (!match) throw new Error("trusted writer must pin repository, workflow, source SHA, run, attempt and job");
    const writer: TrustedWriter = { repository: match[1]!, workflow: match[2]!, sha: match[3]!,
      runId: Number(match[4]), attempt: Number(match[5]), jobId: Number(match[6]) };
    if (![writer.runId, writer.attempt, writer.jobId].every(Number.isSafeInteger)) {
      throw new Error("invalid trusted writer identifier");
    }
    return writer;
  });
}

export function trustedWriterForRun(
  writers: readonly TrustedWriter[], metadata: WriterRunMetadata,
): TrustedWriter | null {
  if (metadata.status !== "completed" || metadata.conclusion !== "success" ||
      metadata.repository !== metadata.headRepository) return null;
  return writers.find(writer => writer.repository === metadata.repository &&
    writer.workflow === metadata.workflow && writer.sha === metadata.sha &&
    writer.runId === metadata.runId && writer.attempt === metadata.attempt) ?? null;
}

export function normalizeWorkflowPath(path: string, repository: string): string {
  // GitHub reports either a repository-relative file or the qualified
  // owner/repo/path@ref form. Neither stdout nor candidate keys supply it.
  const prefix = `${repository}/`;
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return relative.split("@")[0]!;
}
