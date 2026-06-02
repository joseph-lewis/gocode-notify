// Canonical agent-runtime detection (PRD §5.2).
//
// Owns the runtime table, the {@link RuntimeStatus} shape, and the detector that
// both `setup` (the installer) and `status` consume through a single seam. A
// runtime counts as "detected" when EITHER:
//   - one of its well-known config dirs exists under the home dir, OR
//   - one of its `pathCommands` resolves to a file on `$PATH`.
// The PATH branch covers the PRD §5.2 rule for Claude Code — "`~/.claude/` exists
// OR `claude` on PATH" — so a globally-installed runtime is found even before it
// has written its config dir.
//
// Both the home dir (`PathOpts.home`) and `$PATH` (`DetectOptions.path`) are
// injectable, so the whole detector is unit-testable against fixture HOMEs with
// zero reliance on the machine's real config dirs or installed binaries.
//
// Detection is best-effort and NEVER throws (a stat failure just reads as
// "absent"). Zero runtime deps — Node built-ins only, matching the package rule.
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveHome, type PathOpts } from "./creds.js";

/** A coding-agent runtime we know how to detect + configure (PRD §5.2). */
export interface RuntimeSpec {
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** Home-relative dirs whose existence indicates the runtime is installed. */
  detectDirs: string[];
  /** Config file (within the detected dir) the installer writes to. */
  configBasename: string;
  /**
   * Command names whose presence on `$PATH` ALSO indicates the runtime (PRD
   * §5.2 — e.g. `claude` for Claude Code). Optional; runtimes detected purely by
   * config dir omit it.
   */
  pathCommands?: string[];
}

/** The runtimes we detect, in install-priority order (PRD §5.2). */
export const RUNTIMES: readonly RuntimeSpec[] = [
  {
    name: "Claude Code",
    detectDirs: [".claude"],
    configBasename: "settings.json",
    pathCommands: ["claude"],
  },
  { name: "Cursor", detectDirs: [".cursor"], configBasename: "hooks.json" },
  {
    name: "OpenCode",
    detectDirs: [".config/opencode", ".opencode"],
    configBasename: "mcp.json",
  },
];

/** Per-runtime detection result. */
export interface RuntimeStatus {
  /** Display name. */
  name: string;
  /** True when the runtime was found (by config dir or PATH command). */
  detected: boolean;
  /** Absolute path to the config file we'd write for this runtime. */
  configPath: string;
  /** True when that config file already exists on disk. */
  configWritten: boolean;
}

/** Options for {@link detectRuntimes}. */
export interface DetectOptions extends PathOpts {
  /**
   * Override for `$PATH` (defaults to `process.env.PATH`). Lets tests inject a
   * fixture PATH so command-on-PATH detection is fully deterministic.
   */
  path?: string;
}

/** True when `p` exists (any stat error → false). Never throws. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort check: does `cmd` resolve to a file on any entry of `pathEnv`?
 * On Windows we also try the usual executable extensions. Empty/undefined PATH →
 * false. Never throws.
 */
async function commandOnPath(cmd: string, pathEnv: string | undefined): Promise<boolean> {
  if (!pathEnv) return false;
  const names =
    process.platform === "win32" ? [cmd, `${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`] : [cmd];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (await pathExists(path.join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * Detect every runtime in {@link RUNTIMES}. The installer (`setup`) and `status`
 * both consume this as their single detection seam, so detection stays
 * consistent across the CLI. Resolves (never rejects).
 */
export async function detectRuntimes(opts?: DetectOptions): Promise<RuntimeStatus[]> {
  return Promise.all(RUNTIMES.map((spec) => detectRuntime(spec, opts)));
}

/**
 * Detect one runtime: which (if any) detect-dir exists, else whether a PATH
 * command resolves, plus the config path we'd write and whether it already
 * exists.
 */
export async function detectRuntime(
  spec: RuntimeSpec,
  opts?: DetectOptions,
): Promise<RuntimeStatus> {
  const home = resolveHome(opts);

  let detectedDir: string | undefined;
  for (const rel of spec.detectDirs) {
    if (await pathExists(path.join(home, rel))) {
      detectedDir = rel;
      break;
    }
  }

  // Only consult PATH when no config dir was found (cheap-first), and only for
  // runtimes that declare PATH commands.
  let onPath = false;
  if (detectedDir === undefined && spec.pathCommands?.length) {
    const pathEnv = opts?.path ?? process.env.PATH;
    for (const cmd of spec.pathCommands) {
      if (await commandOnPath(cmd, pathEnv)) {
        onPath = true;
        break;
      }
    }
  }

  const detected = detectedDir !== undefined || onPath;
  // Anchor the config path at the detected dir, else the primary detect-dir.
  const baseDir = detectedDir ?? spec.detectDirs[0];
  const configPath = path.join(home, baseDir, spec.configBasename);
  return {
    name: spec.name,
    detected,
    configPath,
    configWritten: detected ? await pathExists(configPath) : false,
  };
}
