import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type ModelSelection,
  type ProviderInstanceId,
  ProviderSetupError,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

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

/** The composer's Bob mode option. */
export const BOB_MODE_OPTION_ID = "mode";
export const BOB_DEFAULT_MODE = "agent";
const MODE_REFUSAL = "IBM Bob does not offer the mode";

/** T3's own refusal of a picked mode, which a retry cannot fix. */
export function isBobModeRefusal(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const { _tag, errorMessage } = cause as {
    readonly _tag?: unknown;
    readonly errorMessage?: unknown;
  };
  return (
    _tag === "AcpRequestError" &&
    typeof errorMessage === "string" &&
    errorMessage.startsWith(MODE_REFUSAL)
  );
}

/**
 * Bob saves a task's mode and keeps it on `session/resume`, so every session configure
 * sets the picked mode, Agent when none is picked. A picked mode the session does not
 * offer, such as a custom mode Bob could not load, fails the turn instead of running in Agent.
 */
export const applyBobMode = Effect.fn("BobAcpSupport.applyBobMode")(function* (
  instanceId: ProviderInstanceId,
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
): Effect.fn.Return<undefined, EffectAcpErrors.AcpError> {
  const modeState = yield* runtime.getModeState;
  if (modeState === undefined) return undefined;
  const offered = (id: string) => modeState.availableModes.some((mode) => mode.id === id);
  const picked = modelSelection.options?.find((option) => option.id === BOB_MODE_OPTION_ID)?.value;
  const target = typeof picked === "string" ? picked : BOB_DEFAULT_MODE;
  if (offered(target)) {
    yield* runtime.setMode(target);
  } else if (target !== BOB_DEFAULT_MODE) {
    return yield* new EffectAcpErrors.AcpRequestError({
      code: -32600,
      errorMessage: `${MODE_REFUSAL} "${target}" here.`,
      cause: new ProviderSetupError({
        instanceId,
        operation: "openSession",
        detail: `IBM Bob does not offer the mode "${target}" in this folder. Check its custom modes file, or pick another mode.`,
      }),
    });
  }
  return undefined;
});

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

/**
 * Never `--trust`: it saves every opened folder as trusted in Bob's settings, even one the
 * user marked untrusted. Bob 2.1 already trusts undecided folders for the session.
 */
export function buildBobAcpSpawnInput(
  settings: Pick<BobSettings, "binaryPath"> | null | undefined,
  cwd: string,
  launch: { readonly autoApprove: boolean; readonly logLoginUrl?: boolean },
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "bob",
    args: [
      "acp",
      ...(launch.autoApprove ? ["--auto-approve"] : []),
      // Bob prints its SSO link to stderr only at info level, which a host without a browser needs.
      ...(launch.logLoginUrl ? ["--log-level", "info"] : []),
    ],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

/** ACP's reserved `auth_required` code. */
export function isBobAuthRequired(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown })._tag === "AcpRequestError" &&
    (cause as { readonly code?: unknown }).code === -32000
  );
}

/** What the user must do when Bob refuses a session over an untrusted folder or its license. */
export function bobSetupRefusal(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const { _tag, code, errorMessage } = cause as {
    readonly _tag?: unknown;
    readonly code?: unknown;
    readonly errorMessage?: unknown;
  };
  if (_tag !== "AcpRequestError" || code !== -32600 || typeof errorMessage !== "string") {
    return undefined;
  }
  if (/not trusted|untrusted/i.test(errorMessage)) {
    return "IBM Bob is set not to trust this folder. Trust it with `bob` in a terminal, then retry the turn.";
  }
  if (/licen[cs]e/i.test(errorMessage)) {
    return "IBM Bob's license has not been accepted on this machine. Run `bob` in a terminal and accept it, then retry the turn.";
  }
  return undefined;
}

/**
 * T3 shows a setup error's text from anywhere in a failure's cause chain, but hides
 * agent request text, so Bob's refusal carries T3's own advice as its cause.
 */
export function explainBobSetupRefusal(
  instanceId: ProviderInstanceId,
  cause: EffectAcpErrors.AcpError,
): EffectAcpErrors.AcpError {
  const detail = bobSetupRefusal(cause);
  if (detail === undefined || cause._tag !== "AcpRequestError") return cause;
  return new EffectAcpErrors.AcpRequestError({
    code: cause.code,
    errorMessage: cause.errorMessage,
    ...(cause.method === undefined ? {} : { method: cause.method }),
    cause: new ProviderSetupError({ instanceId, operation: "openSession", detail }),
  });
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
  "authMethodId" | "authenticateOnAuthRequired" | "spawn"
> {
  readonly settings: Pick<BobSettings, "binaryPath"> | null | undefined;
  readonly autoApprove: boolean;
  readonly logLoginUrl?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeBobAcpRuntime = Effect.fn("BobAcpSupport.makeBobAcpRuntime")(function* (
  input: BobAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, autoApprove, logLoginUrl, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      // Signing in from a turn would block on a browser, which an SSH host never opens.
      authenticateOnAuthRequired: false,
      spawn: buildBobAcpSpawnInput(
        settings,
        input.cwd,
        { autoApprove, ...(logLoginUrl ? { logLoginUrl } : {}) },
        environment,
      ),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
