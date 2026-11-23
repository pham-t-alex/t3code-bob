import type { ProviderUsageReader, UsageRecord } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { BobSettings } from "../settings.ts";

// IBM's default price: $1 = 2 Bobcoins = 1M tokens, one rate for every token type.
// Bob 2.1 stores only Bobcoin spend, so tokens are derived from it and left unsplit.
const TOKENS_PER_BOBCOIN = 500_000;
const USD_PER_BOBCOIN = 0.5;
const BOB_MODEL = "Bob";

const bobcoins = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

function bobRecord(input: {
  readonly key: string;
  readonly taskId: string;
  readonly timestampMs: number;
  readonly cost: number;
}): UsageRecord {
  return {
    provider: "bob",
    timestampMs: input.timestampMs,
    model: BOB_MODEL,
    sessionId: input.taskId,
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      unsplitTokens: Math.round(input.cost * TOKENS_PER_BOBCOIN),
    },
    reportedCostUsd: input.cost * USD_PER_BOBCOIN,
    speed: "standard",
    dedupeKey: `bob:${input.key}`,
  };
}

export interface BobUsageReadResult {
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: boolean;
}

/**
 * Reads Bob's spend from `bob.db` without writing to it. Each assistant response is a
 * record at its own time. A root task's total also covers its subagents, which have no
 * response rows of their own, so the part of the total no response accounts for becomes
 * one record at the task's last update. Subagent task rows are skipped.
 */
export const readBobUsage = Effect.fn("readBobUsage")(function* (
  databasePath: string,
  sinceMs: number,
): Effect.fn.Return<BobUsageReadResult, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(databasePath).pipe(Effect.orElseSucceed(() => false)))) {
    return { records: [], missing: true, error: false };
  }
  // An unknown schema fails a query, which reports the source as partial.
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Fail promptly on Bob's write locks instead of stalling the server.
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const records: UsageRecord[] = [];
    const responses = yield* sql.unsafe<{
      readonly id: unknown;
      readonly task_id: unknown;
      readonly created_at: unknown;
      readonly cost: unknown;
    }>(
      `SELECT message.id, message.task_id, message.created_at,
         json_extract(message.data, '$._meta.spend.cost') AS cost
       FROM messages AS message
       JOIN tasks AS task ON task.id = message.task_id
       WHERE task.parent_id IS NULL AND message.role = 'assistant'
         AND message.created_at >= ? AND json_valid(message.data)`,
      [sinceMs],
    );
    for (const row of responses) {
      const cost = bobcoins(row.cost);
      if (cost === 0 || typeof row.id !== "string" || typeof row.task_id !== "string") continue;
      if (typeof row.created_at !== "number") continue;
      records.push(
        bobRecord({ key: row.id, taskId: row.task_id, timestampMs: row.created_at, cost }),
      );
    }
    const tasks = yield* sql.unsafe<{
      readonly id: unknown;
      readonly updated_at: unknown;
      readonly total: unknown;
      readonly responses: unknown;
    }>(
      `SELECT task.id, task.updated_at,
         CASE WHEN json_valid(task.costs) THEN json_extract(task.costs, '$.cost') END AS total,
         (SELECT SUM(json_extract(message.data, '$._meta.spend.cost')) FROM messages AS message
          WHERE message.task_id = task.id AND message.role = 'assistant'
            AND json_valid(message.data)) AS responses
       FROM tasks AS task
       WHERE task.parent_id IS NULL AND task.updated_at >= ?`,
      [sinceMs],
    );
    for (const row of tasks) {
      // Bob can save a task's total before its response rows, so the rest may shrink later.
      const rest = bobcoins(row.total) - bobcoins(row.responses);
      if (rest < 1e-9 || typeof row.id !== "string" || typeof row.updated_at !== "number") {
        continue;
      }
      records.push(
        bobRecord({
          key: `${row.id}:rest`,
          taskId: row.id,
          timestampMs: row.updated_at,
          cost: rest,
        }),
      );
    }
    return { records, missing: false, error: false };
  }).pipe(
    (read) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(read)),
    NodeSqliteClient.readOnly,
    Effect.provide(
      NodeSqliteClient.layer({ filename: databasePath, readonly: true, readerWorker: true }),
    ),
    Effect.catchTags({
      SqlError: () => Effect.succeed({ records: [], missing: false, error: true }),
    }),
  );
});

export type BobUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const bobUsageReader: ProviderUsageReader<BobSettings, BobUsageReaderEnv> = {
  kind: "scan",
  provider: "bob",
  scan: Effect.fn("bobUsageReader.scan")(function* ({ windowStartMs }) {
    const path = yield* Path.Path;
    const dir = path.join(yield* HostProcess.HomeDirectory, ".bob", "db");
    const databasePath = path.join(dir, "bob.db");
    const result = yield* readBobUsage(databasePath, windowStartMs);
    return [
      {
        dir,
        files: result.missing ? null : [{ path: databasePath, records: result.records }],
        status: result.error ? ("partial" as const) : ("ok" as const),
        ...(result.error ? { message: "Some IBM Bob usage could not be read." } : {}),
      },
    ];
  }),
};
