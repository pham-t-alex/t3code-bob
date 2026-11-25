import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { BobSettings } from "../settings.ts";
import { type BobAdapterV2DriverEnv, makeBobAdapterV2Driver } from "./adapter.ts";
import {
  bobDatabasePath,
  bobUsageReader,
  type BobUsageReaderEnv,
  readBobUsageLimits,
} from "./usage.ts";
import { makeBobAuth } from "./auth.ts";
import { discoverBobCatalog } from "./discovery.ts";
import {
  bobModels,
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
  readCachedBobSignIn,
  withBobSignIn,
} from "./status.ts";

const DRIVER_KIND = ProviderDriverKind.make("bob");
const decodeBobSettings = Schema.decodeSync(BobSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "IBM Bob does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
})();

export type BobDriverEnv = BobAdapterV2DriverEnv | ChildProcessSpawner.ChildProcessSpawner;

export const BobDriver: ProviderDriver<BobSettings, BobDriverEnv, BobUsageReaderEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "IBM Bob",
    supportsMultipleInstances: true,
  },
  usage: bobUsageReader,
  configSchema: BobSettings,
  defaultConfig: (): BobSettings => decodeBobSettings({}),
  create: Effect.fn("BobDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies BobSettings;
    const usesApiKey = Boolean(processEnv.BOB_API_KEY?.trim());
    const { paths } = yield* ProviderHost.ProviderHost;
    const signIn = yield* Ref.make<"unknown" | "unauthenticated" | "authenticated">(
      // An API key's result says nothing about SSO, and the key may have changed.
      !usesApiKey && (yield* readCachedBobSignIn(paths.providerStatusCacheDir, instanceId))
        ? "authenticated"
        : "unknown",
    );
    const monthlyBobcoins = Number(effectiveConfig.monthlyBobcoinLimit);
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const path = yield* Path.Path;
    const databasePath = bobDatabasePath(path, homeDirectory);
    const fileSystem = yield* FileSystem.FileSystem;
    const discoverCatalog = (cwd?: string) =>
      discoverBobCatalog(homeDirectory, cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const withGlobalCatalog = (draft: ServerProviderDraft) =>
      effectiveConfig.enabled
        ? discoverCatalog().pipe(
            Effect.map((catalog) => ({
              ...draft,
              models: bobModels(catalog.modes),
              slashCommands: catalog.skills,
            })),
          )
        : Effect.succeed(draft);
    const withMonthlyLimit = (draft: ServerProviderDraft) =>
      effectiveConfig.enabled && monthlyBobcoins > 0
        ? Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) => readBobUsageLimits(databasePath, monthlyBobcoins, nowMs)),
            Effect.map((usageLimits) => ({ ...draft, usageLimits })),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          )
        : Effect.succeed(draft);
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<BobSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialBobProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkBobProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((draft) =>
          Ref.get(signIn).pipe(Effect.map((state) => withBobSignIn(draft, state, usesApiKey))),
        ),
        Effect.flatMap(withMonthlyLimit),
        Effect.flatMap(withGlobalCatalog),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build IBM Bob snapshot.",
            cause,
          }),
      ),
    );

    const scope = yield* Scope.Scope;
    // Refreshes in the background so a session start never waits on `bob --version`.
    const recordSignIn = (state: "unauthenticated" | "authenticated") =>
      Ref.getAndSet(signIn, state).pipe(
        Effect.flatMap((previous) =>
          previous === state
            ? Effect.void
            : snapshot.refresh.pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
        ),
      );
    // An API-key instance stays out of the shared SSO binding, so SSO sign-in never stops its sessions.
    const auth = usesApiKey
      ? undefined
      : yield* makeBobAuth({
          instanceId,
          settings: effectiveConfig,
          cwd: paths.cwd,
          environment: processEnv,
          onSignedIn: recordSignIn("authenticated"),
        });

    const orchestrationAdapter = yield* makeBobAdapterV2Driver({
      onSignInRequired: recordSignIn("unauthenticated"),
      onSessionStarted: recordSignIn("authenticated"),
    })
      .create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: effectiveConfig,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build IBM Bob orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      // A project's `.bob` folder adds its own skills and custom modes to the global ones.
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([snapshot.getSnapshot, discoverCatalog(cwd)]).pipe(
              Effect.map(([machineSnapshot, catalog]) => {
                const models = bobModels(catalog.modes);
                return {
                  ...machineSnapshot,
                  slashCommands: catalog.skills,
                  ...(JSON.stringify(models) === JSON.stringify(machineSnapshot.models)
                    ? {}
                    : { models, workspaceModels: models }),
                };
              }),
            ),
      ...(auth ? { auth } : {}),
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
