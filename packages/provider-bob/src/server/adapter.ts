import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

import { BobSettings } from "../settings.ts";
import {
  applyBobMode,
  BOB_MODE_OPTION_ID,
  bobAutoApproves,
  bobPermissionDisposition,
  bobSetupRefusal,
  explainBobSetupRefusal,
  isBobAuthRequired,
  makeBobAcpRuntime,
} from "./acpSupport.ts";
import { withBobContextUsage } from "./contextUsage.ts";

const BOB_PROVIDER = ProviderDriverKind.make("bob");
const DEFAULT_BOB_SETTINGS = Schema.decodeSync(BobSettings)({});

/** Reports what each Bob session start learned about sign-in. */
export interface BobSignInObserver {
  readonly onSignInRequired: Effect.Effect<void>;
  readonly onSessionStarted: Effect.Effect<void>;
}

interface BobAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: BobSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly signIn: BobSignInObserver;
  /** Bob's task database, where it keeps each task's context size. */
  readonly databasePath: string;
  /** Replaces the `bob acp` launch in tests. */
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

export function makeBobAcpAdapterFlavor(options: BobAdapterV2Options): AcpAdapterV2Flavor {
  // `--auto-approve` is fixed at launch; a runtime-mode change restarts and resumes the session.
  const launchBob: AcpAdapterV2Flavor["makeRuntime"] = ({
    runtimePolicy,
    processEnvironment,
    ...input
  }) =>
    makeBobAcpRuntime({
      ...input,
      settings: options.settings,
      autoApprove: bobAutoApproves(runtimePolicy),
      environment: { ...options.environment, ...processEnvironment },
    });
  return {
    driver: BOB_PROVIDER,
    runtimeHarness: "Bob",
    capabilities: AcpProviderCapabilitiesV2,
    makeRuntime: (runtimeInput) =>
      (options.makeRuntime ?? launchBob)(runtimeInput).pipe(
        Effect.flatMap((runtime) => withBobContextUsage(runtime, options.databasePath)),
        Effect.map((runtime) => ({
          ...runtime,
          start: () =>
            runtime.start().pipe(
              Effect.tap(() => options.signIn.onSessionStarted),
              Effect.tapError((cause) =>
                isBobAuthRequired(cause) ? options.signIn.onSignInRequired : Effect.void,
              ),
              Effect.mapError((cause) => explainBobSetupRefusal(options.instanceId, cause)),
            ),
        })),
      ),
    // Also ends retries for a trust or license refusal, which only the user can clear.
    requiresSignIn: (cause) => isBobAuthRequired(cause) || bobSetupRefusal(cause) !== undefined,
    permissionDisposition: bobPermissionDisposition,
    // Bob has no model choice (`session/set_model` is unsupported); its selection carries the mode.
    applyModelSelection: ({ runtime, modelSelection }) => applyBobMode(runtime, modelSelection),
    ownedModelOptionIds: [BOB_MODE_OPTION_ID],
  };
}

export type BobAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeBobAdapterV2Driver = (
  signIn: BobSignInObserver,
): ProviderAdapterDriver<BobSettings, BobAdapterV2DriverEnv> => ({
  driverKind: BOB_PROVIDER,
  configSchema: BobSettings,
  defaultConfig: (): BobSettings => DEFAULT_BOB_SETTINGS,
  create: Effect.fn("BobAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<BobSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const path = yield* Path.Path;
      return yield* makeAcpAdapterV2({
        instanceId: input.instanceId,
        flavor: makeBobAcpAdapterFlavor({
          instanceId: input.instanceId,
          settings: { ...input.config, enabled: input.enabled },
          environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
          signIn,
          databasePath: path.join(yield* HostProcess.HomeDirectory, ".bob", "db", "bob.db"),
        }),
        selfInvocation: yield* resolveSelfInvocation(),
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: BOB_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: BOB_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create the IBM Bob ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
