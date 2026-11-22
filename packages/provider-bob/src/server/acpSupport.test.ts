import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";

import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

import {
  bobAutoApproves,
  bobPermissionDisposition,
  buildBobAcpSpawnInput,
  explainBobSetupRefusal,
} from "./acpSupport.ts";
import { makeBobLoginUrlReader } from "./auth.ts";
import { cachedBobSignIn, withBobSignIn } from "./status.ts";

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
      buildBobAcpSpawnInput({ binaryPath: "" }, "/work", { autoApprove: bobAutoApproves(policy) })
        .args;
    assert.deepEqual(launch({ runtimeMode: "full-access" }), ["acp", "--auto-approve"]);
    assert.deepEqual(launch({ runtimeMode: "approval-required" }), ["acp"]);
    assert.deepEqual(launch({ runtimeMode: "full-access", approvalPolicy: "on-request" }), ["acp"]);
    assert.deepEqual(launch({ runtimeMode: "full-access", sandboxPolicy: "read-only" }), ["acp"]);
    assert.equal(
      buildBobAcpSpawnInput({ binaryPath: "" }, "/work", { autoApprove: false }).command,
      "bob",
    );
  });

  it("sends every prompt Bob still asks under --auto-approve to the user", () => {
    assert.equal(
      bobPermissionDisposition({ runtimeMode: "full-access", cwd: "/work" }, editRequest),
      "ask",
    );
  });
});

describe("Bob sign-in", () => {
  const ready = {
    installed: true,
    status: "ready",
    auth: { status: "unknown" },
  } as unknown as ServerProviderDraft;

  it("offers sign-in after Bob refuses a session, unless an API key is set", () => {
    const signedOut = withBobSignIn(ready, "unauthenticated", false);
    assert.equal(signedOut.status, "warning");
    assert.equal(signedOut.auth.status, "unauthenticated");
    assert.equal(signedOut.setup?.canAuthenticate, true);
    const withKey = withBobSignIn(ready, "unauthenticated", true);
    assert.equal(withKey.setup?.canAuthenticate, false);
    assert.match(withKey.message ?? "", /BOB_API_KEY/);
    assert.equal(withBobSignIn(ready, "unknown", false).status, "ready");
  });

  it("reads the SSO link Bob logs to stderr, even split across chunks", () => {
    const read = makeBobLoginUrlReader();
    assert.equal(read("[info] Starting ACP server\n[info] Open https://login.exa"), undefined);
    assert.equal(
      read("mple.test/auth?state=a&b=c, then return.\n"),
      "https://login.example.test/auth?state=a&b=c",
    );
  });
});

describe("Bob setup refusals", () => {
  const instanceId = ProviderInstanceId.make("bob");
  const shown = (code: number, errorMessage: string) =>
    knownProviderFailureMessage(
      explainBobSetupRefusal(
        instanceId,
        new EffectAcpErrors.AcpRequestError({ code, errorMessage, method: "session/new" }),
      ),
    );

  it("explains Bob's untrusted folder and license refusals, and nothing else", () => {
    assert.match(
      shown(
        -32600,
        'Invalid request: Workspace "/work" is not trusted. Pass --trust to continue.',
      ) ?? "",
      /not to trust this folder/,
    );
    assert.match(shown(-32600, "Invalid request: accept the license first") ?? "", /license/);
    assert.equal(shown(-32600, "Invalid request: unknown session"), undefined);
    assert.equal(shown(-32603, "license server unreachable"), undefined);
  });
});

describe("Bob sign-in after a restart", () => {
  const cached = (value: unknown) => JSON.stringify(value);

  it("reuses only a cached SSO sign-in of the same Bob instance", () => {
    const signedIn = {
      driver: "bob",
      instanceId: "bob",
      auth: { status: "authenticated" },
      setup: { canAuthenticate: true },
    };
    assert.equal(cachedBobSignIn(cached(signedIn), "bob"), true);
    assert.equal(cachedBobSignIn(cached(signedIn), "bob-work"), false);
    assert.equal(cachedBobSignIn(cached({ ...signedIn, driver: "kiro" }), "bob"), false);
    assert.equal(
      cachedBobSignIn(cached({ ...signedIn, auth: { status: "unauthenticated" } }), "bob"),
      false,
    );
    assert.equal(
      cachedBobSignIn(cached({ ...signedIn, setup: { canAuthenticate: false } }), "bob"),
      false,
    );
    assert.equal(cachedBobSignIn("", "bob"), false);
    assert.equal(cachedBobSignIn("null", "bob"), false);
  });
});
