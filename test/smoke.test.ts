import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.js";
import { COMMANDS, run } from "../src/cli.js";

test("VERSION is a semver-ish string", () => {
  assert.equal(typeof VERSION, "string");
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test("COMMANDS lists the supported subcommands", () => {
  assert.deepEqual(
    [...COMMANDS],
    ["login", "send", "test", "setup", "status", "mcp", "uninstall", "config"],
  );
});

test("run() returns 0 for help and version", () => {
  assert.equal(run(["--help"]), 0);
  assert.equal(run([]), 0);
  assert.equal(run(["--version"]), 0);
});

test("run() returns 1 for a known-but-unimplemented command", () => {
  assert.equal(run(["send"]), 1);
});

test("run() returns 2 for an unknown command", () => {
  assert.equal(run(["wat"]), 2);
});
