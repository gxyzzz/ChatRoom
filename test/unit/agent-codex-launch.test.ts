import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexLaunch } from "../../src/plugins/agent/providers/codex/launch.js";

const nodeExecutable = "C:\\node\\node.exe";

test("Codex uses the system command on non-Windows platforms", () => {
  assert.deepEqual(
    resolveCodexLaunch({
      platform: "linux",
      path: "/usr/local/bin",
      exists: () => false,
    }),
    { command: "codex", args: [] },
  );
});

test("Codex prefers a native Windows executable from PATH", () => {
  const executable = "C:\\tools\\codex.exe";
  assert.deepEqual(
    resolveCodexLaunch({
      platform: "win32",
      path: "C:\\tools;C:\\npm",
      exists: (candidate) => candidate === executable,
    }),
    { command: executable, args: [] },
  );
});

test("Codex launches the npm Windows shim via its JS entry point", () => {
  const directory = "C:\\Users\\example\\AppData\\Roaming\\npm";
  const shim = directory + "\\codex.cmd";
  const entry = directory + "\\node_modules\\@openai\\codex\\bin\\codex.js";
  assert.deepEqual(
    resolveCodexLaunch({
      platform: "win32",
      path: "C:\\missing;" + directory,
      nodeExecutable,
      exists: (candidate) => candidate === shim || candidate === entry,
    }),
    { command: nodeExecutable, args: [entry] },
  );
});

test("Codex preserves PATH search order between npm and native installs", () => {
  const npmDir = "C:\\npm";
  const entry = npmDir + "\\node_modules\\@openai\\codex\\bin\\codex.js";
  assert.deepEqual(
    resolveCodexLaunch({
      platform: "win32",
      path: npmDir + ";C:\\native",
      nodeExecutable,
      exists: (candidate) =>
        candidate === npmDir + "\\codex.cmd" ||
        candidate === entry ||
        candidate === "C:\\native\\codex.exe",
    }),
    { command: nodeExecutable, args: [entry] },
  );
});

test("Codex retains a missing-command failure when not installed", () => {
  assert.deepEqual(
    resolveCodexLaunch({
      platform: "win32",
      path: "C:\\empty",
      exists: () => false,
    }),
    { command: "codex", args: [] },
  );
});
