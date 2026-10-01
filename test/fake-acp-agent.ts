// Fake ACP agent speaking newline-delimited JSON-RPC over stdio.
// Tests run it via DEVIN_BIN="bun <this file>" — the appended "acp" arg is ignored.
import { appendFileSync } from "node:fs";

const sessions = [
  {
    sessionId: "fake-session-open",
    cwd: process.env.FAKE_CWD ?? process.cwd(),
    title: "Fake open session",
    updatedAt: new Date().toISOString(),
    _meta: { "cognition.ai/isLocked": false },
  },
  {
    sessionId: "fake-session-locked",
    cwd: process.env.FAKE_CWD ?? process.cwd(),
    title: "Fake locked session",
    updatedAt: new Date().toISOString(),
    _meta: { "cognition.ai/isLocked": true },
  },
];

let nextId = 1000;
let pendingPermission: { requestId: number; promptId: number | string; sessionId: string } | null =
  null;

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notify(sessionId: string, update: unknown) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function textChunk(kind: string, text: string) {
  return { sessionUpdate: kind, content: { type: "text", text } };
}

function onRequest(id: number | string, method: string, params: Record<string, unknown>) {
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "devin-browser", name: "Devin Browser" }],
        },
      });
      break;
    case "authenticate":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "session/list":
      send({ jsonrpc: "2.0", id, result: { sessions } });
      break;
    case "session/new": {
      const sid = `fake-new-${nextId++}`;
      sessions.push({
        sessionId: sid,
        cwd: String(params.cwd ?? process.env.FAKE_CWD ?? process.cwd()),
        title: "Fake new session",
        updatedAt: new Date().toISOString(),
        _meta: { "cognition.ai/isLocked": false },
      });
      send({ jsonrpc: "2.0", id, result: { sessionId: sid } });
      break;
    }
    case "session/load": {
      const sid = String(params.sessionId);
      if (sid === "fake-session-locked") {
        notify(sid, textChunk("user_message_chunk", "locked user msg"));
        notify(sid, textChunk("agent_message_chunk", "locked agent reply"));
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32015,
            message: `Session '${sid}' is already open in another process. Close the other instance before opening it here.`,
            data: { "cognition.ai/errorKind": "session_locked", "cognition.ai/retryable": true },
          },
        });
        break;
      }
      notify(sid, textChunk("user_message_chunk", "hello "));
      notify(sid, textChunk("user_message_chunk", "there"));
      notify(sid, textChunk("agent_message_chunk", "Hi! "));
      notify(sid, textChunk("agent_message_chunk", "How can I help?"));
      notify(sid, {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read file",
        kind: "read",
        status: "completed",
        rawInput: { path: "/tmp/x" },
      });
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    }
    case "session/prompt": {
      const sid = String(params.sessionId);
      const text = ((params.prompt as Array<{ text?: string }>) ?? [])
        .map((b) => b.text ?? "")
        .join("");
      const outFile0 = process.env.FAKE_ANSWER_FILE;
      try {
        if (outFile0) appendFileSync(outFile0, `PROMPT=${sid}=${text.replace(/\n/g, "\\n")}\n`);
      } catch {}
      if (text === "HANG") return; // never respond; turn stays open
      notify(sid, textChunk("agent_message_chunk", "Working on it..."));
      const permId = nextId++;
      pendingPermission = { requestId: permId, promptId: id, sessionId: sid };
      send({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          toolCall: { toolCallId: "tc-perm", title: "Run command", kind: "execute" },
          options: [
            { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
            { optionId: "opt-allow", name: "Allow once", kind: "allow_once" },
            { optionId: "opt-allow-session", name: "Allow this session", kind: "allow_always" },
          ],
        },
      });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, result: {} });
  }
}

function onNotification(method: string, params: Record<string, unknown>) {
  if (method === "session/cancel") {
    const outFile = process.env.FAKE_ANSWER_FILE;
    const line = `CANCELLED=${String(params.sessionId)}\n`;
    if (outFile) appendFileSync(outFile, line);
    else process.stderr.write(line);
  }
}

function onResponse(msg: { id?: number | string; result?: { outcome?: { optionId?: string } } }) {
  if (pendingPermission && msg.id === pendingPermission.requestId) {
    const chosen = msg.result?.outcome?.optionId ?? "CANCELLED";
    const outFile = process.env.FAKE_ANSWER_FILE;
    try {
      if (outFile) appendFileSync(outFile, `PERMISSION_ANSWER=${chosen}\n`);
      else process.stderr.write(`PERMISSION_ANSWER=${chosen}\n`);
    } catch {}
    const { promptId, sessionId } = pendingPermission;
    pendingPermission = null;
    notify(sessionId, textChunk("agent_message_chunk", "Done."));
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method && msg.id !== undefined) onRequest(msg.id, msg.method, msg.params ?? {});
    else if (msg.method) onNotification(msg.method, msg.params ?? {});
    else onResponse(msg);
  }
});
