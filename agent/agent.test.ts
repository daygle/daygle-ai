/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, type AgentEvent } from "./agent";
import type { ChatProvider } from "./providers";

/**
 * A provider that emits a tool call as plain text (no structured tool_calls) on
 * the first turn, then finishes. Weak local models do this, and the autonomous
 * loop must recover the call rather than treating the turn as a final answer.
 */
function textToolCallProvider(firstTurnContent: string): ChatProvider {
  let turn = 0;
  return {
    name: "test",
    async chat() {
      turn += 1;
      if (turn === 1) return { content: firstTurnContent, toolCalls: [] };
      return { content: "All done.", toolCalls: [] };
    },
    async listModels() {
      return ["test"];
    },
    async healthCheck() {
      return true;
    },
  };
}

describe("runAgentLoop text tool-call fallback", () => {
  test("recovers a tool call emitted as plain text", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-agent-text-"));
    writeFileSync(join(root, "hello.txt"), "hi\n");
    const events: AgentEvent[] = [];
    const summary = await runAgentLoop({
      root,
      task: "List the files.",
      model: "test",
      provider: textToolCallProvider('Let me look: {"name": "list_files", "arguments": {"path": "."}}'),
      emit: (event) => events.push(event),
    });

    const toolStart = events.find((event) => event.type === "tool_start");
    expect(toolStart).toMatchObject({ name: "list_files" });
    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult?.type === "tool_result" && toolResult.result).toContain("hello.txt");
    expect(summary).toBe("All done.");
  });

  test("ignores text-emitted tools outside the autonomous surface (create_pr)", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-agent-nopr-"));
    writeFileSync(join(root, "hello.txt"), "hi\n");
    const events: AgentEvent[] = [];
    await runAgentLoop({
      root,
      task: "Open a PR.",
      model: "test",
      provider: textToolCallProvider('{"name": "create_pr", "arguments": {"title": "x", "body": "y"}}'),
      emit: (event) => events.push(event),
    });

    // create_pr is not in AGENT_TOOL_DEFINITIONS, so the text call is dropped and
    // the loop treats the turn as its final answer - no tool ever runs.
    expect(events.some((event) => event.type === "tool_start")).toBe(false);
  });
});
