import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  type ProviderProbeResult,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

import type { BobSettings } from "../settings.ts";
import { BOB_SUPPORTED_RUNTIME_MODES } from "./acpSupport.ts";

const BOB_DRIVER_KIND = ProviderDriverKind.make("bob");
const BOB_PRESENTATION = {
  displayName: "IBM Bob",
  // Bob advertises a `plan` mode, which the shared ACP adapter selects for Plan.
  showInteractionModeToggle: true,
  supportedRuntimeModes: BOB_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
// Bob picks its own model and does not support `session/set_model`.
const BOB_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "default", name: "Bob", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];
const VERSION_PROBE_TIMEOUT_MS = 10_000;

const snapshot = (
  settings: BobSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: BOB_DRIVER_KIND,
    presentation: BOB_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: BOB_MODELS,
    probe,
  }),
  // Keeps Bob out of the text generation pickers; the driver rejects those calls.
  supportsTextGeneration: false,
});

export const buildInitialBobProviderSnapshot = Effect.fn(
  "BobProvider.buildInitialBobProviderSnapshot",
)(function* (settings: BobSettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking IBM Bob Shell availability..."
      : "IBM Bob is disabled in T3 Code settings.",
  });
});

const runBobVersion = Effect.fn("BobProvider.runBobVersion")(function* (
  settings: BobSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "bob";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/** Sign-in is not checked yet: Bob reports it only when a session starts. */
export const checkBobProviderStatus = Effect.fn("checkBobProviderStatus")(function* (
  settings: BobSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "IBM Bob is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runBobVersion(settings, providerProbeEnvironment(environment)).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("bob", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "IBM Bob Shell (`bob`) is not installed or not on PATH."
        : "Failed to run `bob --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "IBM Bob Shell is installed but failed to run.",
    });
  }
  return snapshot(settings, checkedAt, {
    installed: true,
    version: parseCliVersionResult(versionOutput),
    status: "ready",
    auth: { status: "unknown" },
  });
});
