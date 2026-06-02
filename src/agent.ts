// Structured, machine-readable progress output for `--agent-driven` mode (PRD §4.4).
//
// When any command is invoked with `--agent-driven`, it emits ONE JSON line per
// step to stdout in the canonical shape
//   { "step": "...", "ok": true|false, "detail": "..." }
// so an agent installer (PRD §2 Path 2) can parse and verify each step. In this
// mode the usual human-readable console output is suppressed — only step lines
// reach stdout.
//
// The emitter takes an injectable {@link StepSink} so tests can collect lines
// without capturing the real process stdout. Zero runtime deps — Node built-ins
// only, matching the package's zero-dep rule.

/** One step of a command's progress, serialized as a single JSON line. */
export interface StepLine {
  /** Short, machine-stable identifier for the step (e.g. "credentials"). */
  step: string;
  /** Whether the step succeeded. */
  ok: boolean;
  /** Human-readable detail about the outcome. */
  detail: string;
}

/** A consumer of step lines (the default writes one JSON line to stdout). */
export type StepSink = (line: StepLine) => void;

/**
 * Serialize a step to its canonical single-line JSON form (PRD §4.4). The field
 * order is fixed (`step`, `ok`, `detail`) so the output is stable to assert
 * against and contains no incidental newlines (detail is JSON-escaped).
 */
export function formatStep(line: StepLine): string {
  return JSON.stringify({ step: line.step, ok: line.ok, detail: line.detail });
}

/** Default sink: one newline-terminated JSON line per step to stdout. */
export const stdoutSink: StepSink = (line) => {
  process.stdout.write(`${formatStep(line)}\n`);
};

/**
 * True when the parsed flags requested agent-driven (machine-readable) output.
 * Accepts the bare boolean form (`--agent-driven`) and the explicit
 * `--agent-driven=true`; any other value (including `=false`) is off.
 */
export function isAgentDriven(flags: Map<string, string | true>): boolean {
  const v = flags.get("agent-driven");
  return v === true || v === "true";
}
