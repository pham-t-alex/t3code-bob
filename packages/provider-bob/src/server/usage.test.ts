import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { readBobUsage } from "./usage.ts";

// Bob 2.1's columns for the two tables the reader reads (schema version 18).
const BOB_SCHEMA = [
  `CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
    status TEXT, first_message TEXT, directory TEXT, version TEXT, git_sha TEXT, git_branch TEXT,
    env TEXT, costs TEXT, created_at INTEGER, updated_at INTEGER, time_archived INTEGER,
    locked_by TEXT, lock_lease_until INTEGER, approval_config TEXT, message_queue TEXT,
    task_type TEXT, last_error TEXT, is_pinned INTEGER, is_unread INTEGER)`,
  `CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, data TEXT,
    created_at INTEGER)`,
];

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const writeDatabase = Effect.fn(function* (statements: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "bob-usage-test-" });
  const filename = path.join(dir, "bob.db");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* Layer.build(NodeSqliteClient.layer({ filename })).pipe(
        Effect.map(Context.get(SqlClient.SqlClient)),
      );
      for (const statement of statements) yield* sql.unsafe(statement);
    }),
  );
  return filename;
});

const task = (id: string, parent: string | null, cost: number, updatedAt: number) =>
  `INSERT INTO tasks (id, parent_id, task_type, costs, created_at, updated_at) VALUES
    ('${id}', ${parent === null ? "NULL" : `'${parent}'`}, '${parent === null ? "normal" : "subagent"}',
     '${JSON.stringify({ cost, contextTokens: 1000 })}', ${updatedAt - DAY}, ${updatedAt})`;

const message = (id: string, taskId: string, role: string, createdAt: number, cost?: number) =>
  `INSERT INTO messages (id, task_id, role, data, created_at) VALUES ('${id}', '${taskId}',
    '${role}', '${JSON.stringify(cost === undefined ? { text: "hi" } : { _meta: { spend: { cost, contextTokens: 900, reasoningTokens: 0 } } })}',
    ${createdAt})`;

describe("readBobUsage", () => {
  it.effect("records each response's spend and a root task's unaccounted rest once", () =>
    Effect.gen(function* () {
      const filename = yield* writeDatabase([
        ...BOB_SCHEMA,
        // Root total 0.05 = an earlier response 0.02 (outside the window) + responses 0.01
        // and 0.015 + a subagent's 0.005, which has no response rows.
        task("root", null, 0.05, NOW),
        task("child", "root", 0.005, NOW),
        message("old-reply", "root", "assistant", NOW - 10 * DAY, 0.02),
        message("user-1", "root", "user", NOW - 3_000),
        message("reply-1", "root", "assistant", NOW - 2_000, 0.01),
        message("reply-2", "root", "assistant", NOW - 1_000, 0.015),
        // Last updated before the window: none of its spend is in range.
        task("old", null, 0.02, NOW - 10 * DAY),
        message("old-task-reply", "old", "assistant", NOW - 10 * DAY, 0.02),
      ]);
      const result = yield* readBobUsage(filename, NOW - DAY);
      assert.deepEqual(result.missing || result.error, false);
      assert.deepEqual(
        result.records
          .map((record) => ({
            key: record.dedupeKey,
            at: record.timestampMs,
            session: record.sessionId,
            tokens: record.totals.unsplitTokens,
            usd: Number(record.reportedCostUsd?.toFixed(6)),
            provider: record.provider,
          }))
          .toSorted((a, b) => a.at - b.at),
        [
          {
            key: "bob:reply-1",
            at: NOW - 2_000,
            session: "root",
            tokens: 5_000,
            usd: 0.005,
            provider: "bob",
          },
          {
            key: "bob:reply-2",
            at: NOW - 1_000,
            session: "root",
            tokens: 7_500,
            usd: 0.0075,
            provider: "bob",
          },
          {
            key: "bob:root:rest",
            at: NOW,
            session: "root",
            tokens: 2_500,
            usd: 0.0025,
            provider: "bob",
          },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing database as missing and an unknown schema as an error", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "bob-usage-missing-" });
      const missing = yield* readBobUsage(path.join(dir, "bob.db"), 0);
      assert.deepEqual([missing.missing, missing.error], [true, false]);

      const filename = yield* writeDatabase([
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, costs TEXT)",
        "CREATE TABLE messages (id TEXT PRIMARY KEY)",
      ]);
      const unknown = yield* readBobUsage(filename, 0);
      assert.deepEqual([unknown.missing, unknown.error, unknown.records.length], [false, true, 0]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
