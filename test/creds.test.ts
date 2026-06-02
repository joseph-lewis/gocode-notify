import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SERVER,
  type Credentials,
  credentialsPath,
  configPath,
  gocodeDir,
  readCredentials,
  writeCredentials,
  readConfig,
  writeConfig,
  resolveServer,
  resolveServerUrl,
} from "../src/creds.js";

/** Make a fresh temp HOME and return PathOpts pointing at it. */
async function tempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gocode-creds-"));
  return { home };
}

const SAMPLE: Credentials = {
  api_key: "gck_testkey0000000000000000000000",
  server: "https://oh.jeltechsolutions.com",
  user_id: "github:123",
  label: "Test Machine — Cursor",
};

test("path helpers compose under the temp HOME", async () => {
  const opts = await tempHome();
  assert.equal(gocodeDir(opts), path.join(opts.home, ".gocode"));
  assert.equal(credentialsPath(opts), path.join(opts.home, ".gocode", "credentials"));
  assert.equal(configPath(opts), path.join(opts.home, ".gocode", "config.json"));
});

test("readCredentials returns null when no file exists", async () => {
  const opts = await tempHome();
  assert.equal(await readCredentials(opts), null);
});

test("writeCredentials round-trips and writes mode 0o600", async () => {
  const opts = await tempHome();
  await writeCredentials(SAMPLE, opts);

  const back = await readCredentials(opts);
  assert.deepEqual(back, SAMPLE);

  const stat = await fs.stat(credentialsPath(opts));
  assert.equal(stat.mode & 0o777, 0o600, "credentials must be chmod 600");
});

test("writeCredentials creates ~/.gocode with private (0o700) perms", async () => {
  const opts = await tempHome();
  await writeCredentials(SAMPLE, opts);
  const stat = await fs.stat(gocodeDir(opts));
  assert.equal(stat.mode & 0o777, 0o700, "~/.gocode must be owner-only");
});

test("readCredentials throws on a non-object file", async () => {
  const opts = await tempHome();
  await fs.mkdir(gocodeDir(opts), { recursive: true });
  await fs.writeFile(credentialsPath(opts), "[]");
  await assert.rejects(() => readCredentials(opts), /not a JSON object/);
});

test("readCredentials throws when a required field is missing", async () => {
  const opts = await tempHome();
  await fs.mkdir(gocodeDir(opts), { recursive: true });
  await fs.writeFile(credentialsPath(opts), JSON.stringify({ api_key: "x" }));
  await assert.rejects(() => readCredentials(opts), /missing string field/);
});

test("readCredentials throws on invalid JSON", async () => {
  const opts = await tempHome();
  await fs.mkdir(gocodeDir(opts), { recursive: true });
  await fs.writeFile(credentialsPath(opts), "{ not json");
  await assert.rejects(() => readCredentials(opts), /invalid JSON/);
});

test("config round-trips and preserves extra keys", async () => {
  const opts = await tempHome();
  assert.equal(await readConfig(opts), null);
  await writeConfig({ server: "https://example.test", source: "manual", extra: 7 }, opts);
  const back = await readConfig(opts);
  assert.deepEqual(back, { server: "https://example.test", source: "manual", extra: 7 });
});

test("resolveServer precedence: flag > env > creds > default", () => {
  // flag wins over everything
  assert.equal(
    resolveServer({
      flag: "https://flag.test",
      env: "https://env.test",
      creds: { server: "https://creds.test" },
    }),
    "https://flag.test",
  );
  // env wins when no flag
  assert.equal(
    resolveServer({ env: "https://env.test", creds: { server: "https://creds.test" } }),
    "https://env.test",
  );
  // creds wins when no flag/env
  assert.equal(resolveServer({ creds: { server: "https://creds.test" } }), "https://creds.test");
  // default when nothing supplied
  assert.equal(resolveServer({}), DEFAULT_SERVER);
});

test("resolveServer skips empty/whitespace values", () => {
  assert.equal(
    resolveServer({ flag: "   ", env: "", creds: { server: "https://creds.test" } }),
    "https://creds.test",
  );
});

test("resolveServer trims and strips trailing slashes", () => {
  assert.equal(resolveServer({ flag: "  https://x.test/  " }), "https://x.test");
  assert.equal(resolveServer({ flag: "https://x.test///" }), "https://x.test");
});

test("resolveServer honours a custom default", () => {
  assert.equal(resolveServer({ default: "https://my.default" }), "https://my.default");
});

test("resolveServerUrl reads creds from disk and the live env", async (t) => {
  const opts = await tempHome();
  const prev = process.env.GOCODE_SERVER;
  t.after(() => {
    if (prev === undefined) delete process.env.GOCODE_SERVER;
    else process.env.GOCODE_SERVER = prev;
  });

  // No creds, no env, no flag → default.
  delete process.env.GOCODE_SERVER;
  assert.equal(await resolveServerUrl(undefined, opts), DEFAULT_SERVER);

  // Creds on disk → used when no env/flag.
  await writeCredentials({ ...SAMPLE, server: "https://creds.test" }, opts);
  assert.equal(await resolveServerUrl(undefined, opts), "https://creds.test");

  // env beats creds.
  process.env.GOCODE_SERVER = "https://env.test";
  assert.equal(await resolveServerUrl(undefined, opts), "https://env.test");

  // flag beats env + creds.
  assert.equal(await resolveServerUrl("https://flag.test", opts), "https://flag.test");
});

test("resolveServerUrl: a corrupt creds file does not block flag/env/default", async (t) => {
  const opts = await tempHome();
  const prev = process.env.GOCODE_SERVER;
  t.after(() => {
    if (prev === undefined) delete process.env.GOCODE_SERVER;
    else process.env.GOCODE_SERVER = prev;
  });
  delete process.env.GOCODE_SERVER;

  // Write a corrupt credentials file (would make readCredentials() throw).
  await fs.mkdir(gocodeDir(opts), { recursive: true });
  await fs.writeFile(credentialsPath(opts), "{ not json");

  // Higher-precedence flag still wins despite the unusable creds file.
  assert.equal(await resolveServerUrl("https://flag.test", opts), "https://flag.test");
  // env still wins too.
  process.env.GOCODE_SERVER = "https://env.test";
  assert.equal(await resolveServerUrl(undefined, opts), "https://env.test");
  // With neither flag nor env, a corrupt creds file falls through to default
  // (it must not crash server resolution).
  delete process.env.GOCODE_SERVER;
  assert.equal(await resolveServerUrl(undefined, opts), DEFAULT_SERVER);
});
