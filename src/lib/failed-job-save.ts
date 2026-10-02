// setup-soldr#559: a job that did not succeed does not save its build outputs.
//
// The post step runs on failure too (`post-if: always()`, for the daemon
// shutdown). It used to save the build-cache store regardless, so a failed
// build -- disk full under `bosn ci`, a compile error, a cancel -- saved a
// partial store under the run's key. The next run got an exact hit on it and,
// being an exact hit, never re-saved: the key stayed poisoned until it
// changed. Like `actions/cache` (`post-if: success()`), a job that failed or
// was cancelled now skips the build-output layers (build-cache and
// target-cache). Toolchain and registry layers are unaffected: their content
// is a verified install, not a half-finished build.
//
// The job status comes from the `job-status` input, which the workflow sets
// to `${{ job.status }}` (an action's own input default cannot read the `job`
// context). The runner re-evaluates a step's `with:` inputs for its post step,
// so the post step sees the job's status at the end of its steps. An empty
// status (the default) keeps the old always-save behaviour, as does
// `save-on-failure: true`.

import { readRawInputs } from "./raw-inputs.js";

/** Save status recorded when a failed or cancelled job skips the save. */
export const FAILED_JOB_SKIP_STATUS = "failed-job-skip" as const;

export interface BuildOutputSaveDecision {
  save: boolean;
  reason: string;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["", "0", "false", "no", "off"]);
const NOT_SUCCEEDED = new Set(["failure", "cancelled"]);

export function decideBuildOutputSave(input: { jobStatus: string; saveOnFailure: string }): BuildOutputSaveDecision {
  const status = input.jobStatus.trim().toLowerCase();
  const raw = input.saveOnFailure.trim().toLowerCase();
  if (!TRUTHY.has(raw) && !FALSY.has(raw)) {
    throw new Error(`save-on-failure must be true or false (got '${input.saveOnFailure}')`);
  }
  if (!NOT_SUCCEEDED.has(status)) {
    return { save: true, reason: `job status ${status || "unknown"}` };
  }
  if (TRUTHY.has(raw)) return { save: true, reason: `job status ${status}, save-on-failure=true` };
  return { save: false, reason: `job status ${status} (set save-on-failure: true to save anyway)` };
}

/** The gate as the post step sees it, from its re-evaluated inputs. */
export function readBuildOutputSaveGate(env: Record<string, string | undefined>): BuildOutputSaveDecision {
  const raw = readRawInputs(env);
  return decideBuildOutputSave({ jobStatus: raw.jobStatus, saveOnFailure: raw.saveOnFailure });
}
