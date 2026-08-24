/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQaGate } from "./qa";
import type { SandboxRunner } from "./sandbox";

describe("QA sandbox policy", () => {
  test("refuses verification when no sandbox is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-qa-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    await expect(runQaGate({ root, command: "bun test" })).rejects.toThrow(/sandbox is unavailable/);
  });

  test("does not treat shell metacharacters as a second command", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-qa-argv-"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    const commands: string[] = [];
    const sandbox: SandboxRunner = {
      name: "test-sandbox",
      run: async () => "exit code: 0",
      runCapture: async (_root, command) => {
        commands.push(command);
        return { code: 0, stdout: "ok", stderr: "", timedOut: false, overflow: false };
      },
    };

    const result = await runQaGate({ root, command: "echo safe && touch should-not-run", sandbox });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("rejected by verification policy");
    expect(commands).toEqual([]);
  });

  test("runs verification through the supplied sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-qa-sandbox-"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    const commands: string[] = [];
    const captureOptions: Array<{ readOnly?: boolean; network?: boolean }> = [];
    const sandbox: SandboxRunner = {
      name: "test-sandbox",
      run: async () => "exit code: 0",
      runCapture: async (_root, command, options) => {
        commands.push(command);
        captureOptions.push({ readOnly: options?.readOnly, network: options?.network });
        return { code: 0, stdout: "ok", stderr: "", timedOut: false, overflow: false };
      },
    };

    const result = await runQaGate({ root, sandbox });
    expect(result.passed).toBe(true);
    expect(commands).toEqual(["npm run test"]);
    expect(captureOptions).toEqual([{ readOnly: true, network: false }]);
  });
});
