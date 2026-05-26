// Detect *-unknown-linux-musl cross compilers on PATH and return the
// cc-rs env-var exports needed to make cc-rs find them.
//
// cc-rs strips the "-unknown-" segment from a Rust target triple when
// probing for a cross compiler, so the cross-tools archives (which
// ship binaries named with the full triple, e.g.
// aarch64-unknown-linux-musl-gcc) are missed and cc-rs falls back to
// the host gcc. The symptom is wheels/binaries that link against host
// glibc's libgcc_s.so.1 and fail at runtime. Auto-exporting
// CC_<triple>, CXX_<triple>, and AR_<triple> in snake-case from
// setup-soldr fixes the build without forcing every consumer to edit
// their workflow. See PR #111 for background.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  detectSoldrSupportsToolchainSubcommands,
  soldrToolchainDoctor,
  type SoldrExecFn,
} from "./soldr-toolchain-client.js";

const MUSL_TRIPLE_RE = /^[a-z0-9_]+-unknown-linux-musl$/;

export function tripleToCcRsSuffix(triple: string): string {
  return triple.replace(/-/g, "_");
}

function findOnPathSync(env: Record<string, string | undefined>, cmd: string): string | null {
  const pathRaw = env["PATH"] ?? env["Path"] ?? "";
  if (!pathRaw) return null;
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const dir of pathRaw.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${cmd}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not present; continue
      }
    }
  }
  return null;
}

function scanPathForMuslTriples(
  env: Record<string, string | undefined>,
  readDir: (dir: string) => string[],
): Set<string> {
  const triples = new Set<string>();
  const pathRaw = env["PATH"] ?? env["Path"] ?? "";
  if (!pathRaw) return triples;
  const sep = process.platform === "win32" ? ";" : ":";
  const isWin = process.platform === "win32";
  const tail = isWin ? /-unknown-linux-musl-gcc(?:\.exe)?$/i : /-unknown-linux-musl-gcc$/;
  for (const dir of pathRaw.split(sep)) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = entry.match(tail);
      if (!m) continue;
      const triple = entry.slice(0, entry.length - m[0].length) + "-unknown-linux-musl";
      if (MUSL_TRIPLE_RE.test(triple)) triples.add(triple);
    }
  }
  return triples;
}

export interface MuslCcResolution {
  triple: string;
  exports: Record<string, string>;
  resolvedPaths: { cc: string; cxx: string; ar: string };
}

export interface DetectMuslCcDeps {
  findOnPath?: (cmd: string) => string | null;
  readDir?: (dir: string) => string[];
}

/**
 * Detect *-unknown-linux-musl cross compilers on PATH and return the
 * cc-rs env-var exports needed to make cc-rs find them.
 *
 * Triples are sourced from: CARGO_BUILD_TARGET, any CARGO_TARGET_<T>_*
 * env vars the user has already set, and PATH-scanning for
 * `*-unknown-linux-musl-gcc` binaries. A triple is skipped when the user
 * has already set any of CC_/CXX_/AR_<snake_triple>.
 */
export function detectMuslCcEnv(
  env: Record<string, string | undefined>,
  deps?: DetectMuslCcDeps,
): MuslCcResolution[] {
  const find = deps?.findOnPath ?? ((cmd: string) => findOnPathSync(env, cmd));
  const readDir = deps?.readDir ?? ((dir: string) => fs.readdirSync(dir));
  const triples = new Set<string>();

  const cbt = (env["CARGO_BUILD_TARGET"] ?? "").trim();
  if (cbt && MUSL_TRIPLE_RE.test(cbt)) triples.add(cbt);

  // Cargo encodes triples by uppercasing and replacing `-` with `_`, so
  // `x86_64-unknown-linux-musl` becomes `X86_64_UNKNOWN_LINUX_MUSL` — the
  // reverse is ambiguous (the arch may contain a real underscore). Match on
  // the fixed `_UNKNOWN_LINUX_MUSL_` suffix and treat the prefix as the
  // verbatim arch name to round-trip safely.
  for (const name of Object.keys(env)) {
    const m = name.match(/^CARGO_TARGET_(.+?)_UNKNOWN_LINUX_MUSL_(LINKER|RUSTFLAGS|RUNNER)$/);
    if (!m) continue;
    const arch = m[1]!.toLowerCase();
    if (!/^[a-z0-9_]+$/.test(arch)) continue;
    const triple = `${arch}-unknown-linux-musl`;
    if (MUSL_TRIPLE_RE.test(triple)) triples.add(triple);
  }

  for (const t of scanPathForMuslTriples(env, readDir)) {
    triples.add(t);
  }

  const out: MuslCcResolution[] = [];
  for (const triple of [...triples].sort()) {
    const suffix = tripleToCcRsSuffix(triple);
    const ccVar = `CC_${suffix}`;
    const cxxVar = `CXX_${suffix}`;
    const arVar = `AR_${suffix}`;
    if ((env[ccVar] ?? "").trim() !== "") continue;
    if ((env[cxxVar] ?? "").trim() !== "") continue;
    if ((env[arVar] ?? "").trim() !== "") continue;
    const ccPath = find(`${triple}-gcc`);
    const cxxPath = find(`${triple}-g++`);
    const arPath = find(`${triple}-ar`);
    if (!ccPath || !cxxPath || !arPath) continue;
    out.push({
      triple,
      exports: {
        [ccVar]: `${triple}-gcc`,
        [cxxVar]: `${triple}-g++`,
        [arVar]: `${triple}-ar`,
      },
      resolvedPaths: { cc: ccPath, cxx: cxxPath, ar: arPath },
    });
  }
  return out;
}

/**
 * Wave 3.4 (setup-soldr#133): try sourcing the musl-cc resolution from
 * `soldr toolchain doctor --json`'s `musl-cc` probe. Returns:
 *   - an array of MuslCcResolution when the probe exists and yielded data
 *     (the array may be empty if the probe found nothing)
 *   - `null` when delegation is not possible (binary missing, soldr < 0.7.35,
 *     schema mismatch, non-zero exit, probe missing). Callers must fall back
 *     to the legacy in-process scan in that case.
 *
 * Exported for unit tests.
 */
export async function tryDelegateToSoldrDoctorMuslCc(opts: {
  soldrPath: string;
  exec?: SoldrExecFn;
  warn?: (msg: string) => void;
}): Promise<MuslCcResolution[] | null> {
  const detected = await detectSoldrSupportsToolchainSubcommands(opts.soldrPath, {
    exec: opts.exec,
    warn: opts.warn,
  });
  if (!detected.supported) return null;
  const doctor = await soldrToolchainDoctor(opts.soldrPath, {
    exec: opts.exec,
    warn: opts.warn,
  });
  if (doctor === null) return null;
  const probe = doctor.probes.find((p) => p.name === "musl-cc");
  if (!probe) return null;
  const details = probe.details ?? {};
  const resolutionsRaw = Array.isArray((details as Record<string, unknown>)["resolutions"])
    ? ((details as Record<string, unknown>)["resolutions"] as Record<string, unknown>[])
    : [];
  const out: MuslCcResolution[] = [];
  for (const r of resolutionsRaw) {
    const triple = String(r["triple"] ?? "");
    if (!MUSL_TRIPLE_RE.test(triple)) continue;
    const exportsRaw = (r["exports"] ?? {}) as Record<string, unknown>;
    const expRec: Record<string, string> = {};
    for (const [k, v] of Object.entries(exportsRaw)) {
      if (typeof v === "string") expRec[k] = v;
    }
    out.push({
      triple,
      exports: expRec,
      resolvedPaths: {
        cc: String(r["cc"] ?? ""),
        cxx: String(r["cxx"] ?? ""),
        ar: String(r["ar"] ?? ""),
      },
    });
  }
  return out;
}
