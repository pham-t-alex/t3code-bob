import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

type BobRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type SessionUpdateHandler = Parameters<BobRuntime["handleSessionUpdate"]>[0];

/**
 * The context size of a task's latest response, which Bob keeps in `tasks.costs`, read without
 * writing to `bob.db`. Undefined when the task, the database or the value is not there.
 */
const readBobContextTokens = Effect.fn("readBobContextTokens")(function* (
  databasePath: string,
  taskId: string,
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Give up at once on Bob's write locks; the next turn reads again.
    yield* sql.unsafe("PRAGMA busy_timeout = 0");
    const rows = yield* sql.unsafe<{ readonly tokens: unknown }>(
      `SELECT CASE WHEN json_valid(costs) THEN json_extract(costs, '$.contextTokens') END AS tokens
       FROM tasks WHERE id = ?`,
      [taskId],
    );
    const tokens = rows[0]?.tokens;
    return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0
      ? tokens
      : undefined;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
    Effect.catchCause(() => Effect.undefined),
  );
});

/**
 * Bob sends no `usage_update`, so after each prompt this reads the session's context size from
 * `bob.db` and hands the adapter's update handlers one. Bob reports no window size.
 */
export const withBobContextUsage = Effect.fn("withBobContextUsage")(function* (
  runtime: BobRuntime,
  databasePath: string,
) {
  const handlers = yield* Ref.make<ReadonlyArray<SessionUpdateHandler>>([]);
  const sessionId = yield* Ref.make<string | undefined>(undefined);
  const remember = <A extends { readonly sessionId: string }, E, R>(
    started: Effect.Effect<A, E, R>,
  ) => Effect.tap(started, (result) => Ref.set(sessionId, result.sessionId));
  // A context row is not worth failing a turn over.
  const reportContextUsage = Effect.gen(function* () {
    const id = yield* Ref.get(sessionId);
    if (id === undefined) return;
    const used = yield* readBobContextTokens(databasePath, id);
    if (used === undefined) return;
    for (const handler of yield* Ref.get(handlers)) {
      yield* handler({ sessionId: id, update: { sessionUpdate: "usage_update", used, size: 0 } });
    }
  }).pipe(Effect.ignore);
  return {
    ...runtime,
    handleSessionUpdate: (handler) =>
      Ref.update(handlers, (current) => [...current, handler]).pipe(
        Effect.andThen(runtime.handleSessionUpdate(handler)),
      ),
    start: () => remember(runtime.start()),
    loadSession: (id, options) => remember(runtime.loadSession(id, options)),
    resumeSession: (id, options) => remember(runtime.resumeSession(id, options)),
    forkSession: (id, options, meta) => remember(runtime.forkSession(id, options, meta)),
    prompt: (payload, options) =>
      runtime.prompt(payload, options).pipe(Effect.tap(() => reportContextUsage)),
  } satisfies BobRuntime;
});
