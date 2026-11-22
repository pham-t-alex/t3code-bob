import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";

import type { BobSettings } from "../settings.ts";
import { makeBobAcpRuntime } from "./acpSupport.ts";

const SSO_METHOD_ID = "sso";
const LOGIN_URL = /https:\/\/[^\s"'<>]+/;

/**
 * Finds the first https link in Bob's stderr, where Bob prints its SSO link.
 * Reads whole lines, since a chunk can end partway through the link.
 */
export function makeBobLoginUrlReader(): (chunk: string) => string | undefined {
  let partial = "";
  return (chunk) => {
    const text = partial + chunk;
    const end = text.lastIndexOf("\n");
    partial = text.slice(end + 1).slice(-16_384);
    return end < 0 ? undefined : LOGIN_URL.exec(text.slice(0, end))?.[0].replace(/[).,;]+$/, "");
  };
}

export const makeBobAuth = Effect.fn("makeBobAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: BobSettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onSignedIn: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  const authenticate = Effect.fn("BobAuth.authenticate")(function* (
    _methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (!options.settings.enabled)
      return yield* failure("start", "Enable IBM Bob before signing in.");
    let signingIn = false;
    let shownUrl: string | undefined;
    const readLoginUrl = makeBobLoginUrlReader();
    const runtime = yield* makeBobAcpRuntime({
      settings: options.settings,
      autoApprove: false,
      logLoginUrl: true,
      cwd: options.cwd,
      environment: options.environment,
      clientInfo: { name: "t3-code-provider-auth", version: "0.0.0" },
      onStderr: (text) => {
        const url = signingIn && shownUrl === undefined ? readLoginUrl(text) : undefined;
        if (url === undefined) return Effect.void;
        shownUrl = url;
        return context.setInteraction({
          type: "browser",
          id: "bob-login",
          url,
          requiresConsent: false,
        });
      },
    }).pipe(Effect.mapError((cause) => failure("start", "Could not start IBM Bob.", cause)));
    const initialized = yield* runtime
      .initialize()
      .pipe(Effect.mapError((cause) => failure("start", "Could not start IBM Bob.", cause)));
    const method = initialized.authMethods?.find(
      (candidate) => candidate.type === undefined || candidate.type === "agent",
    );
    if (method === undefined || runtime.authenticate === undefined)
      return yield* failure(
        "start",
        "IBM Bob did not offer in-app sign-in. Run `bob` in a terminal on this machine to sign in, or add BOB_API_KEY.",
      );
    signingIn = true;
    yield* runtime
      .authenticate(method.id)
      .pipe(
        Effect.mapError((cause) => failure("start", "IBM Bob could not complete sign-in.", cause)),
      );
    yield* options.onSignedIn;
  });

  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // Bob keeps one sign-in per machine, shared by every instance and Bob's own CLI.
    credentialBinding: { owner: "provider", key: "bob" },
    methods: Effect.succeed([
      { id: SSO_METHOD_ID, name: "Sign in with IBM", description: null, type: "agent" },
    ]),
    authenticate: (methodId, context) =>
      authenticate(methodId, context).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, random),
      ),
    logout: Effect.void,
  });
  // The shared flow stops sessions before calling logout; refuse before that teardown.
  return {
    ...controller,
    logout: () => Effect.fail(failure("logout", "Sign out of IBM Bob with its own CLI.")),
  };
});
