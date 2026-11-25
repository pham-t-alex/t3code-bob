// Synthetic IBM Bob ACP agent (protocol v1) for Bob's modes: `agent`, `plan` and `ask`.
// A new session starts in `agent`; a resume reports the mode the task was saved in
// (T3_BOB_MOCK_SAVED_MODE), and `session/set_mode` saves the new one, like Bob.
// With T3_BOB_MOCK_DATABASE, each prompt saves the task's context size in its `bob.db`.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";

const sessionId = "bob-mode-session";
const logPath = process.env.T3_BOB_MOCK_EVENT_LOG;
const modes = [
  { id: "agent", name: "Agent" },
  { id: "plan", name: "Plan" },
  { id: "ask", name: "Ask" },
];
let currentModeId = "agent";
let prompts = 0;

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (event) => {
  if (logPath) NodeFS.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
};
const modeState = () => ({ modes: { currentModeId, availableModes: modes } });

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  switch (request.method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "bob", version: "mock" },
          agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } },
        },
      });
      break;
    case "session/new":
      log({ event: "session/new" });
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId, ...modeState() } });
      break;
    case "session/resume":
      log({ event: "session/resume" });
      currentModeId = process.env.T3_BOB_MOCK_SAVED_MODE ?? "agent";
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId, ...modeState() } });
      break;
    case "session/set_mode":
      log({ event: "session/set_mode", modeId: request.params?.modeId });
      if (!modes.some((mode) => mode.id === request.params?.modeId)) {
        write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown mode" } });
        break;
      }
      currentModeId = request.params.modeId;
      write({ jsonrpc: "2.0", id: request.id, result: {} });
      break;
    case "session/prompt":
      log({ event: "prompt", mode: currentModeId });
      prompts += 1;
      if (process.env.T3_BOB_MOCK_DATABASE) {
        const database = new NodeSqlite.DatabaseSync(process.env.T3_BOB_MOCK_DATABASE);
        database
          .prepare("UPDATE tasks SET costs = ? WHERE id = ?")
          .run(JSON.stringify({ cost: prompts / 100, contextTokens: prompts * 4_000 }), sessionId);
        database.close();
      }
      write({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
      break;
  }
}
