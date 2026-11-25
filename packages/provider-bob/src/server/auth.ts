// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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

/** Where Bob waits for IBM's redirect: the login link's `callback_uri`, a loopback port on Bob's host. */
export function bobLoginCallback(loginUrl: string): URL | undefined {
  try {
    const raw = new URL(loginUrl).searchParams.get("callback_uri");
    const callback = raw === null ? undefined : new URL(raw);
    return callback?.protocol === "http:" &&
      (callback.hostname === "127.0.0.1" || callback.hostname === "localhost")
      ? callback
      : undefined;
  } catch {
    return undefined;
  }
}

/** The pasted redirect, only when it returns to this sign-in's callback port and path. */
export function matchBobRedirect(pasted: string, callback: URL): URL | undefined {
  try {
    const redirect = new URL(pasted.trim());
    return redirect.protocol === callback.protocol &&
      redirect.host === callback.host &&
      redirect.pathname === callback.pathname
      ? redirect
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bob 2.1 on Linux hands its sign-in link only to `xdg-open`, which a host without a browser
 * lacks. This stand-in records the link, then opens it as usual where `xdg-open` exists.
 */
const XDG_OPEN_STAND_IN = `#!/bin/sh
printf '%s\\n' "$1" >> "$T3_BOB_OPENED_LINKS"
PATH="$T3_BOB_PATH"
command -v xdg-open >/dev/null 2>&1 && exec xdg-open "$@"
exit 0
`;

export const makeBobAuth = Effect.fn("makeBobAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: BobSettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onSignedIn: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  // On a host without a browser the redirect cannot reach Bob's loopback port, so the user
  // pastes it into T3, which this server (on Bob's host) requests for them.
  const returnToBob = (pasted: string, callback: URL) => {
    const redirect = matchBobRedirect(pasted, callback);
    if (redirect === undefined)
      return Effect.fail(
        failure("complete", "This redirect URL does not belong to the active IBM Bob sign-in."),
      );
    // A plain loopback request: no proxy, no redirects, and no trace of the one-time code.
    return Effect.callback<void, ProviderSetupError>((resume) => {
      const request = NodeHttp.get(
        {
          host: redirect.hostname,
          port: redirect.port,
          path: `${redirect.pathname}${redirect.search}`,
          // Node 26 can route the global agent through an HTTP proxy.
          agent: false,
          timeout: 15_000,
        },
        (response) => {
          response.resume();
          resume(
            (response.statusCode ?? 500) < 400
              ? Effect.void
              : Effect.fail(
                  failure("complete", "IBM Bob rejected the redirect URL. Start sign-in again."),
                ),
          );
        },
      );
      request.on("timeout", () => request.destroy(new Error("timed out")));
      request.on("error", () =>
        resume(
          Effect.fail(failure("complete", "IBM Bob is no longer waiting. Start sign-in again.")),
        ),
      );
      return Effect.sync(() => request.destroy());
    });
  };

  /** Records the link Bob opens on Linux; undefined elsewhere, where Bob opens it itself. */
  const catchOpenedLink = Effect.fn("BobAuth.catchOpenedLink")(function* () {
    if (platform !== "linux") return undefined;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-sign-in-" });
    const opener = path.join(directory, "xdg-open");
    const links = path.join(directory, "opened-links");
    yield* fileSystem.writeFileString(opener, XDG_OPEN_STAND_IN);
    yield* fileSystem.chmod(opener, 0o755);
    const inheritedPath = options.environment.PATH || "/usr/local/bin:/usr/bin:/bin";
    const firstLink = Effect.gen(function* () {
      while (true) {
        const opened = yield* fileSystem.readFileString(links).pipe(Effect.orElseSucceed(() => ""));
        const link = opened
          .split("\n")
          .map((line) => line.trim())
          .find((line) => /^https?:\/\//.test(line));
        if (link) return link;
        yield* Effect.sleep("250 millis");
      }
    });
    return {
      environment: {
        ...options.environment,
        PATH: `${directory}:${inheritedPath}`,
        T3_BOB_OPENED_LINKS: links,
        T3_BOB_PATH: inheritedPath,
      },
      firstLink,
    };
  });

  const authenticate = Effect.fn("BobAuth.authenticate")(function* (
    _methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (!options.settings.enabled)
      return yield* failure("start", "Enable IBM Bob before signing in.");
    let signingIn = false;
    let shownUrl: string | undefined;
    const showLink = (url: string) => {
      if (shownUrl !== undefined) return Effect.void;
      shownUrl = url;
      // Elsewhere Bob opens the browser on its own host, where the redirect returns by itself.
      const callback = platform === "linux" ? bobLoginCallback(url) : undefined;
      return context.setInteraction(
        {
          type: "browser",
          id: "bob-login",
          url,
          requiresConsent: false,
          ...(callback === undefined ? {} : { acceptsCallback: true }),
        },
        undefined,
        callback === undefined ? undefined : (pasted) => returnToBob(pasted, callback),
      );
    };
    const readLoginUrl = makeBobLoginUrlReader();
    const linkCatcher = yield* catchOpenedLink().pipe(
      Effect.mapError((cause) => failure("start", "Could not start IBM Bob.", cause)),
    );
    const runtime = yield* makeBobAcpRuntime({
      settings: options.settings,
      autoApprove: false,
      logLoginUrl: true,
      cwd: options.cwd,
      environment: linkCatcher?.environment ?? options.environment,
      clientInfo: { name: "t3-code-provider-auth", version: "0.0.0" },
      onStderr: (text) => {
        const url = signingIn && shownUrl === undefined ? readLoginUrl(text) : undefined;
        return url === undefined ? Effect.void : showLink(url);
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
    // On a desktop Bob opens the browser itself and logs no link; a link replaces this.
    yield* context.awaitingBrowser;
    const signIn = runtime
      .authenticate(method.id)
      .pipe(
        Effect.mapError((cause) => failure("start", "IBM Bob could not complete sign-in.", cause)),
      );
    yield* linkCatcher === undefined
      ? signIn
      : Effect.raceFirst(
          signIn,
          linkCatcher.firstLink.pipe(Effect.flatMap(showLink), Effect.andThen(Effect.never)),
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
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    logout: Effect.void,
  });
  // The shared flow stops sessions before calling logout; refuse before that teardown.
  return {
    ...controller,
    logout: () => Effect.fail(failure("logout", "Sign out of IBM Bob with its own CLI.")),
  };
});
