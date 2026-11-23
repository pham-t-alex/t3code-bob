// Synthetic IBM Bob ACP agent (protocol v1) for Bob's modes: `agent`, `plan` and `ask`.
// A new session starts in `agent`; a resume reports the mode the task was saved in
// (T3_BOB_MOCK_SAVED_MODE), and `session/set_mode` saves the new one, like Bob.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "bob-mode-session";
const logPath = process.env.T3_BOB_MOCK_EVENT_LOG;
const modes = [
  { id: "agent", name: "Agent" },
  { id: "plan", name: "Plan" },
  { id: "ask", name: "Ask" },
];
let currentModeId = "agent";

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
