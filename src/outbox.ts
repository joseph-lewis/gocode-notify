// Offline outbox for gocode-notify (PRD §4.4).
//
// When a `send` cannot reach the server, the notification is enqueued to
// `~/.gocode/outbox/` and flushed opportunistically on the next `send`.
// The contract (PRD §4.4) is deliberately SIMPLE and best-effort:
//   - Cap the queue at {@link MAX_OUTBOX_ENTRIES}; when full, drop the OLDEST.
//   - A missed "done" ping is acceptable; a blocked agent is not — so every
//     operation here is best-effort and never throws for routine I/O issues.
//
// Each queued notification is one JSON file named with a zero-padded, strictly
// increasing sequence so that lexicographic filename order === enqueue order.
// That makes "oldest" unambiguous for both drop-oldest and flush ordering
// without needing a wall-clock that could collide or run backwards.
//
// Zero runtime deps — only Node built-ins, to match the package's zero-dep rule.
import { promises as fs } from "node:fs";
import path from "node:path";
import { gocodeDir, type PathOpts } from "./creds.js";
import type { SendPayload, SendResult } from "./send.js";

/** Maximum notifications retained in the outbox; older ones are dropped. */
export const MAX_OUTBOX_ENTRIES = 100;

/** Width of the zero-padded sequence in entry filenames (sortable to 1e12-1). */
const SEQ_WIDTH = 12;

/** Only files matching this are treated as outbox entries. */
const ENTRY_RE = /^(\d{12})\.json$/;

/** Absolute path to the `~/.gocode/outbox/` directory. */
export function outboxDir(opts?: PathOpts): string {
  return path.join(gocodeDir(opts), "outbox");
}

/** A persisted outbox entry: the original payload plus when it was enqueued. */
export interface OutboxEntry {
  payload: SendPayload;
  enqueued_at: string;
}

export interface OutboxOptions extends PathOpts {
  /** Cap override (defaults to {@link MAX_OUTBOX_ENTRIES}). */
  max?: number;
  /** Timestamp source for `enqueued_at` (defaults to ISO now). Eases tests. */
  timestamp?: () => string;
}

/** Pad a sequence number to a fixed, lexicographically-sortable width. */
function seqToName(seq: number): string {
  return `${String(seq).padStart(SEQ_WIDTH, "0")}.json`;
}

/**
 * List entry filenames in enqueue order (oldest first). Returns [] when the
 * outbox dir is absent. Non-entry files are ignored.
 */
export async function listOutbox(opts?: PathOpts): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(outboxDir(opts));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => ENTRY_RE.test(n)).sort();
}

/** Parse the numeric sequence out of an entry filename. */
function seqOf(name: string): number {
  const m = ENTRY_RE.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * Append `payload` to the outbox. Enforces the cap by dropping the OLDEST
 * entries first, then writes the new entry with the next sequence. Best-effort:
 * routine I/O failures are swallowed (a queued ping must never block the agent).
 * Returns the entry filename on success, or null if it could not be written.
 */
export async function enqueue(
  payload: SendPayload,
  opts: OutboxOptions = {},
): Promise<string | null> {
  const max = opts.max ?? MAX_OUTBOX_ENTRIES;
  const dir = outboxDir(opts);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const existing = await listOutbox(opts);

    // Drop oldest until there's room for one more (cap includes the new entry).
    let entries = existing;
    while (entries.length >= max && entries.length > 0) {
      const oldest = entries[0];
      await fs.rm(path.join(dir, oldest), { force: true });
      entries = entries.slice(1);
    }

    // If the cap is 0 (or less), we drop everything and keep nothing.
    if (max <= 0) return null;

    const nextSeq = entries.length > 0 ? seqOf(entries[entries.length - 1]) + 1 : 0;
    const name = seqToName(nextSeq);
    const entry: OutboxEntry = {
      payload,
      enqueued_at: opts.timestamp ? opts.timestamp() : new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, name), JSON.stringify(entry, null, 2) + "\n");
    return name;
  } catch {
    return null;
  }
}

/** Read and parse one entry file; returns null if missing or malformed. */
async function readEntry(dir: string, name: string): Promise<OutboxEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, name), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OutboxEntry>;
    if (parsed && typeof parsed === "object" && parsed.payload && typeof parsed.payload === "object") {
      return parsed as OutboxEntry;
    }
  } catch {
    // Fall through — malformed entry.
  }
  return null;
}

/** Outcome of a {@link flush} pass. */
export interface FlushResult {
  /** Number of entries successfully delivered and removed. */
  sent: number;
  /** Number of entries still queued after this pass. */
  remaining: number;
}

/**
 * Flush queued notifications oldest-first via `sender`. Each successfully sent
 * entry is removed. On the FIRST delivery failure we stop and leave the rest
 * queued — the server is presumably still unreachable, so hammering it (and
 * delaying the caller) buys nothing. A malformed/unreadable entry is dropped
 * (it can never succeed). Best-effort and never throws for routine I/O.
 */
export async function flush(
  sender: (payload: SendPayload) => Promise<SendResult>,
  opts?: PathOpts,
): Promise<FlushResult> {
  const dir = outboxDir(opts);
  let names: string[];
  try {
    names = await listOutbox(opts);
  } catch {
    return { sent: 0, remaining: 0 };
  }

  let sent = 0;
  let index = 0;
  for (; index < names.length; index++) {
    const name = names[index];
    const entry = await readEntry(dir, name);
    if (!entry) {
      // Unrecoverable entry — discard it so it never wedges the queue.
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
      continue;
    }
    let result: SendResult;
    try {
      result = await sender(entry.payload);
    } catch {
      // Treat a throwing sender as a delivery failure: stop, keep the rest.
      break;
    }
    if (!result.ok) break;
    await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
    sent++;
  }

  const remaining = (await listOutbox(opts).catch(() => [] as string[])).length;
  return { sent, remaining };
}
