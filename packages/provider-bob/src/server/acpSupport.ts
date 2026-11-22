import type * as EffectAcpSchema from "effect-acp/compat";
import type { RuntimeMode } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import type { BobSettings } from "../settings.ts";

/** Bob has no edits-only approval mode, so T3 offers Supervised and Full access. */
export const BOB_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/**
 * Bob approves on its own (`--auto-approve`) only for an unrestricted Full access
 * thread. An approval or sandbox override keeps every prompt on T3's policy
 * check, the same rule as Grok's `grokLaunchRuntimeMode`.
 */
export function bobAutoApproves(policy: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}): boolean {
  return (
    policy.runtimeMode === "full-access" &&
    policy.approvalPolicy === undefined &&
    policy.sandboxPolicy === undefined
  );
}

/** Never `--trust`: it would save every opened folder as trusted in Bob's own settings. */
export function buildBobAcpSpawnInput(
  settings: Pick<BobSettings, "binaryPath"> | null | undefined,
  cwd: string,
  autoApprove: boolean,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "bob",
    args: autoApprove ? ["acp", "--auto-approve"] : ["acp"],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

/**
 * Under `--auto-approve` Bob still asks about protected operations, such as
 * files outside the workspace. Those always reach the user.
 */
export function bobPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return bobAutoApproves(policy) ? "ask" : acpPermissionDisposition(policy, request);
}

export interface BobAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: Pick<BobSettings, "binaryPath"> | null | undefined;
  readonly autoApprove: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeBobAcpRuntime = Effect.fn("BobAcpSupport.makeBobAcpRuntime")(function* (
  input: BobAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, autoApprove, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: buildBobAcpSpawnInput(settings, input.cwd, autoApprove, environment),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
