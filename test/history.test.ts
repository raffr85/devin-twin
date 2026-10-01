import { test, expect } from "bun:test";
import { foldUpdates, summarize, deriveState } from "../src/history.ts";

const chunk = (kind: string, text: string) =>
  ({ sessionUpdate: kind, content: { type: "text", text } }) as never;

test("folds consecutive chunks of the same role", () => {
  const items = foldUpdates([
    chunk("user_message_chunk", "hello "),
    chunk("user_message_chunk", "there"),
    chunk("agent_message_chunk", "hi"),
    chunk("agent_thought_chunk", "hmm"),
  ]);
  expect(items.map((i) => i.role)).toEqual(["user", "agent", "thought"]);
  expect(items[0]!.text).toBe("hello there");
});

test("tool_call and tool_call_update merge by toolCallId", () => {
  const items = foldUpdates([
    {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run",
      status: "in_progress",
      rawInput: { cmd: "ls" },
    } as never,
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "done" } }],
    } as never,
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]!.role).toBe("tool");
  expect(items[0]!.status).toBe("completed");
  expect(items[0]!.text).toContain("done");
});

test("drops available_commands_update", () => {
  const items = foldUpdates([
    { sessionUpdate: "available_commands_update", availableCommands: [] } as never,
    chunk("agent_message_chunk", "x"),
  ]);
  expect(items).toHaveLength(1);
});

test("summarize keeps last N items within char budget", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ role: "agent" as const, text: `m${i}` }));
  const s = summarize(items, { maxItems: 10, maxChars: 8000 });
  expect(s).toHaveLength(10);
  expect(s[0]!.text).toBe("m40");
  const long = [{ role: "agent" as const, text: "x".repeat(100) }, { role: "agent" as const, text: "tail" }];
  const s2 = summarize(long, { maxChars: 50 });
  expect(s2[s2.length - 1]!.text).toBe("tail");
  expect(s2[0]!.text.endsWith("…")).toBe(true);
});

test("deriveState: running tool => running; locked+recent => running; else idle", () => {
  expect(
    deriveState([{ role: "tool", text: "", status: "in_progress" }], { isLocked: false }).state,
  ).toBe("running");
  expect(
    deriveState([{ role: "agent", text: "" }], {
      isLocked: true,
      updatedAt: new Date().toISOString(),
    }).state,
  ).toBe("running");
  expect(
    deriveState([{ role: "tool", text: "", status: "completed" }], { isLocked: false }).state,
  ).toBe("idle");
});
