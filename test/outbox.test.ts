import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SendPayload, SendResult } from "../src/send.js";
import {
  enqueue,
  flush,
  listOutbox,
  outboxDir,
  MAX_OUTBOX_ENTRIES,
  type OutboxEntry,
} from "../src/outbox.js";

/** Fresh temp HOME for PathOpts. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-outbox-"));
  return { home };
}

function payload(n: number): SendPayload {
  return { kind: "finished", title: `n${n}` };
}

const ok: SendResult = { ok: true, status: 200, sent: 1 };
const fail: SendResult = { ok: false, status: 500, error: "boom" };

test("enqueue creates the outbox dir and persists entries oldest-first", async () => {
  const home = await tempHome();
  await enqueue(payload(1), home);
  await enqueue(payload(2), home);

  const names = await listOutbox(home);
  assert.equal(names.length, 2);
  // Lexicographic filename order === enqueue order.
  assert.deepEqual(names, [...names].sort());

  const first = JSON.parse(
    await fs.readFile(path.join(outboxDir(home), names[0]), "utf8"),
  ) as OutboxEntry;
  assert.equal(first.payload.title, "n1");
  assert.equal(typeof first.enqueued_at, "string");
});

test("listOutbox returns [] when the outbox dir does not exist", async () => {
  const home = await tempHome();
  assert.deepEqual(await listOutbox(home), []);
});

test("enqueue caps the queue and drops the OLDEST entries", async () => {
  const home = await tempHome();
  for (let i = 1; i <= 5; i++) await enqueue(payload(i), { ...home, max: 3 });

  const names = await listOutbox(home);
  assert.equal(names.length, 3, "queue is capped at max=3");

  const titles = await Promise.all(
    names.map(async (n) => {
      const e = JSON.parse(
        await fs.readFile(path.join(outboxDir(home), n), "utf8"),
      ) as OutboxEntry;
      return e.payload.title;
    }),
  );
  // 1 and 2 were dropped (oldest); 3,4,5 survive in order.
  assert.deepEqual(titles, ["n3", "n4", "n5"]);
});

test("enqueue with max<=0 keeps nothing", async () => {
  const home = await tempHome();
  const name = await enqueue(payload(1), { ...home, max: 0 });
  assert.equal(name, null);
  assert.deepEqual(await listOutbox(home), []);
});

test("flush delivers all queued entries oldest-first and removes them", async () => {
  const home = await tempHome();
  await enqueue(payload(1), home);
  await enqueue(payload(2), home);
  await enqueue(payload(3), home);

  const seen: string[] = [];
  const res = await flush(async (p) => {
    seen.push(p.title ?? "");
    return ok;
  }, home);

  assert.deepEqual(seen, ["n1", "n2", "n3"], "delivered oldest-first");
  assert.equal(res.sent, 3);
  assert.equal(res.remaining, 0);
  assert.deepEqual(await listOutbox(home), []);
});

test("flush stops on first failure and leaves the rest queued", async () => {
  const home = await tempHome();
  await enqueue(payload(1), home);
  await enqueue(payload(2), home);
  await enqueue(payload(3), home);

  let calls = 0;
  const res = await flush(async () => {
    calls++;
    return calls === 1 ? ok : fail; // first ok, second fails
  }, home);

  assert.equal(calls, 2, "stops after the first failure");
  assert.equal(res.sent, 1);
  assert.equal(res.remaining, 2);

  // The two unsent entries (n2, n3) remain, still in order.
  const names = await listOutbox(home);
  assert.equal(names.length, 2);
  const titles = await Promise.all(
    names.map(async (n) => {
      const e = JSON.parse(
        await fs.readFile(path.join(outboxDir(home), n), "utf8"),
      ) as OutboxEntry;
      return e.payload.title;
    }),
  );
  assert.deepEqual(titles, ["n2", "n3"]);
});

test("flush treats a throwing sender as a failure and keeps the queue", async () => {
  const home = await tempHome();
  await enqueue(payload(1), home);
  const res = await flush(async () => {
    throw new Error("network down");
  }, home);
  assert.equal(res.sent, 0);
  assert.equal(res.remaining, 1);
});

test("flush discards malformed entries instead of wedging the queue", async () => {
  const home = await tempHome();
  await fs.mkdir(outboxDir(home), { recursive: true });
  // A valid entry name with garbage contents.
  await fs.writeFile(path.join(outboxDir(home), "000000000000.json"), "{not json");
  await enqueue(payload(2), home); // gets seq 000000000001

  const seen: string[] = [];
  const res = await flush(async (p) => {
    seen.push(p.title ?? "");
    return ok;
  }, home);

  assert.deepEqual(seen, ["n2"], "malformed entry skipped, valid one sent");
  assert.equal(res.sent, 1);
  assert.equal(res.remaining, 0);
});

test("flush on an empty outbox is a no-op", async () => {
  const home = await tempHome();
  const res = await flush(async () => ok, home);
  assert.deepEqual(res, { sent: 0, remaining: 0 });
});

test("MAX_OUTBOX_ENTRIES is a sane positive cap", () => {
  assert.ok(MAX_OUTBOX_ENTRIES > 0 && Number.isInteger(MAX_OUTBOX_ENTRIES));
});
