// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { BobSettings } from "../settings.ts";
import { BOB_MODE_OPTION_ID } from "./acpSupport.ts";
import { makeBobAcpAdapterFlavor } from "./adapter.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  SecureRandom.layerWebCrypto,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const instanceId = ProviderInstanceId.make("bob");
const DEFAULT_BOB_SETTINGS = Schema.decodeSync(BobSettings)({});
const RUNTIME_MODE = "approval-required" as const;

const selection = (mode?: string): ModelSelection => ({
  instanceId,
  model: "default",
  ...(mode === undefined ? {} : { options: [{ id: BOB_MODE_OPTION_ID, value: mode }] }),
});

const FixtureEvent = Schema.Struct({
  event: Schema.Literals(["session/new", "session/resume", "session/set_mode", "prompt"]),
  modeId: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
});
const decodeFixtureEvent = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureEvent));

/**
 * Opens a Bob session against the synthetic agent and runs one turn per picked
 * mode (`undefined` picks none). Returns what Bob saw, in wire order, and the
 * thread's context size after each turn.
 */
const runBobSession = (options: {
  readonly picks: ReadonlyArray<string | undefined>;
  readonly savedMode?: string;
  /** Gives the session a task row in `bob.db`, which each prompt updates. */
  readonly withTask?: boolean;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-modes-" });
    const logPath = path.join(directory, "events.ndjson");
    yield* fileSystem.writeFileString(logPath, "");
    const databasePath = path.join(directory, "bob.db");
    if (options.withTask === true) {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE TABLE tasks (id TEXT PRIMARY KEY, costs TEXT)");
        yield* sql.unsafe("INSERT INTO tasks (id, costs) VALUES ('bob-mode-session', NULL)");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
    }
    const agentPath = yield* path.fromFileUrl(
      new URL("./testFixtures/bob-modes-agent.mjs", import.meta.url),
    );
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: makeBobAcpAdapterFlavor({
        instanceId,
        settings: DEFAULT_BOB_SETTINGS,
        environment: {},
        signIn: { onSignInRequired: Effect.void, onSessionStarted: Effect.void },
        databasePath,
        makeRuntime: (runtimeInput) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...runtimeInput,
                spawn: {
                  command: process.execPath,
                  args: [agentPath],
                  cwd: runtimeInput.cwd,
                  env: {
                    T3_BOB_MOCK_EVENT_LOG: logPath,
                    ...(options.withTask === true ? { T3_BOB_MOCK_DATABASE: databasePath } : {}),
                    ...(options.savedMode === undefined
                      ? {}
                      : { T3_BOB_MOCK_SAVED_MODE: options.savedMode }),
                  },
                },
              }),
            );
            return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
              Effect.provide(context),
            );
          }),
      }),
    });
    const threadId = ThreadId.make("bob-modes-thread");
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: RUNTIME_MODE,
      interactionMode: "default",
      cwd: directory,
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("bob-modes-provider-session"),
      modelSelection: selection(options.picks[0]),
      runtimePolicy,
      ...(options.savedMode === undefined ? {} : { initialNativeThreadId: "bob-mode-session" }),
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection(options.picks[0]),
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    const contextTokens: Array<readonly [used: number, max: number | undefined] | undefined> = [];
    for (const [index, pick] of options.picks.entries()) {
      const ordinal = index + 1;
      const suffix = `${threadId}:${ordinal}`;
      const modelSelection = selection(pick);
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("bob-modes-project"),
          title: "Bob modes",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: RUNTIME_MODE,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make(`run:${suffix}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt:${suffix}`),
        rootNodeId: NodeId.make(`node:${suffix}`),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:${suffix}`),
          text: "hello",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      contextTokens.push(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runFold(
            (): readonly [number, number | undefined] | undefined => undefined,
            (tokens, event) => {
              if (event.type !== "provider_thread.updated") return tokens;
              const usage = event.providerThread.contextUsage;
              return usage == null ? undefined : ([usage.usedTokens, usage.maxTokens] as const);
            },
          ),
        ),
      );
    }
    const wire = NodeFS.readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => decodeFixtureEvent(line));
    return { wire, contextTokens };
  }).pipe(Effect.scoped, Effect.provide(layerTest));

describe("Bob modes", () => {
  it.live("prompts in the picked mode, switching only when Bob is in another", () =>
    Effect.gen(function* () {
      const { wire } = yield* runBobSession({ picks: [undefined, "ask", "plan", undefined] });
      assert.deepEqual(wire, [
        { event: "session/new" },
        { event: "prompt", mode: "agent" },
        { event: "session/set_mode", modeId: "ask" },
        { event: "prompt", mode: "ask" },
        { event: "session/set_mode", modeId: "plan" },
        { event: "prompt", mode: "plan" },
        { event: "session/set_mode", modeId: "agent" },
        { event: "prompt", mode: "agent" },
      ]);
    }),
  );

  it.live("resumes a task Bob saved in another mode into the picked mode", () =>
    Effect.gen(function* () {
      assert.deepEqual((yield* runBobSession({ picks: [undefined], savedMode: "plan" })).wire, [
        { event: "session/resume" },
        { event: "session/set_mode", modeId: "agent" },
        { event: "prompt", mode: "agent" },
      ]);
      assert.deepEqual((yield* runBobSession({ picks: ["ask"], savedMode: "plan" })).wire, [
        { event: "session/resume" },
        { event: "session/set_mode", modeId: "ask" },
        { event: "prompt", mode: "ask" },
      ]);
    }),
  );
});

describe("Bob context usage", () => {
  it.live("shows the context size Bob saved for the task after each turn", () =>
    Effect.gen(function* () {
      const withTask = yield* runBobSession({ picks: [undefined, undefined], withTask: true });
      assert.deepEqual(withTask.contextTokens, [
        [4_000, 270_000],
        [8_000, 270_000],
      ]);
      // No database, as before Bob's first task: the row stays empty.
      const withoutTask = yield* runBobSession({ picks: [undefined] });
      assert.deepEqual(withoutTask.contextTokens, [undefined]);
    }),
  );
});
