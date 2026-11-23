import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
import { BOB_MODE_OPTION_ID, BOB_SUPPORTED_RUNTIME_MODES } from "./acpSupport.ts";

const BOB_DRIVER_KIND = ProviderDriverKind.make("bob");
const BOB_PRESENTATION = {
  displayName: "IBM Bob",
  // Bob advertises a `plan` mode, which the shared ACP adapter selects for Plan.
  showInteractionModeToggle: true,
  supportedRuntimeModes: BOB_SUPPORTED_RUNTIME_MODES,
} as const;
const BOB_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: BOB_MODE_OPTION_ID,
      label: "Mode",
      type: "select",
      options: [
        { id: "agent", label: "Agent", isDefault: true },
        { id: "plan", label: "Plan" },
        { id: "ask", label: "Ask" },
      ],
    },
  ],
});
// Bob picks its own model and does not support `session/set_model`.
const BOB_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "default", name: "Bob", isCustom: false, capabilities: BOB_CAPABILITIES },
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

/**
 * Bob reports sign-in only when a session opens, so `signIn` is what T3 last saw:
 * a session refused with `auth_required`, or a sign-in that finished.
 */
export function withBobSignIn(
  draft: ServerProviderDraft,
  signIn: "unknown" | "unauthenticated" | "authenticated",
  usesApiKey: boolean,
): ServerProviderDraft {
  const signedOut = signIn === "unauthenticated" && draft.installed && draft.status === "ready";
  return {
    ...draft,
    auth: { status: signIn, canLogout: false },
    setup: { canAuthenticate: draft.installed && !usesApiKey, canInstall: false },
    ...(signedOut
      ? {
          status: "warning",
          message: usesApiKey
            ? "IBM Bob did not accept BOB_API_KEY. Check the key in its provider settings."
            : "Sign in to IBM Bob in its provider settings, or add BOB_API_KEY.",
        }
      : {}),
  };
}

/**
 * Whether the status T3 cached before a restart showed this instance signed in with SSO.
 * A cached sign-out is not reused, since Bob's own CLI may have signed in since.
 */
export function cachedBobSignIn(raw: string, instanceId: string): boolean {
  try {
    const cached = JSON.parse(raw) as {
      readonly driver?: unknown;
      readonly instanceId?: unknown;
      readonly auth?: { readonly status?: unknown };
      readonly setup?: { readonly canAuthenticate?: unknown };
    } | null;
    return (
      cached?.driver === BOB_DRIVER_KIND &&
      cached.instanceId === instanceId &&
      cached.auth?.status === "authenticated" &&
      cached.setup?.canAuthenticate === true
    );
  } catch {
    return false;
  }
}

// The server's provider status cache keeps each instance's last snapshot at `<instanceId>.json`.
export const readCachedBobSignIn = Effect.fn("BobProvider.readCachedBobSignIn")(function* (
  cacheDir: string,
  instanceId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem
    .readFileString(path.join(cacheDir, `${instanceId}.json`))
    .pipe(Effect.orElseSucceed(() => ""));
  return cachedBobSignIn(raw, instanceId);
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
