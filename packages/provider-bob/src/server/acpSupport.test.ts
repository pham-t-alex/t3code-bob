import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { bobAutoApproves, bobPermissionDisposition, buildBobAcpSpawnInput } from "./acpSupport.ts";

const editRequest = {
  sessionId: "session-1",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write file" },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} as unknown as EffectAcpSchema.RequestPermissionRequest;

describe("Bob ACP launch and approvals", () => {
  it("passes --auto-approve only for unrestricted Full access, never --trust", () => {
    const launch = (policy: Parameters<typeof bobAutoApproves>[0]) =>
      buildBobAcpSpawnInput({ binaryPath: "" }, "/work", bobAutoApproves(policy)).args;
    assert.deepEqual(launch({ runtimeMode: "full-access" }), ["acp", "--auto-approve"]);
    assert.deepEqual(launch({ runtimeMode: "approval-required" }), ["acp"]);
    assert.deepEqual(launch({ runtimeMode: "full-access", approvalPolicy: "on-request" }), ["acp"]);
    assert.deepEqual(launch({ runtimeMode: "full-access", sandboxPolicy: "read-only" }), ["acp"]);
    assert.equal(buildBobAcpSpawnInput({ binaryPath: "" }, "/work", false).command, "bob");
  });

  it("sends every prompt Bob still asks under --auto-approve to the user", () => {
    assert.equal(
      bobPermissionDisposition({ runtimeMode: "full-access", cwd: "/work" }, editRequest),
      "ask",
    );
  });
});
