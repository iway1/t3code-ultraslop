import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("060_SkillInvocationModel", (it) => {
  it.effect("backfills each recorded turn's model from its run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });

      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, payload_json
        ) VALUES (
          'run:1', 'thread:1', 1, 'claudeAgent', 'completed', '2026-10-01T00:00:00.000Z',
          '{"modelSelection":{"instanceId":"claude","model":"claude-opus-4-5"}}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_thread_id, status, payload_json
        ) VALUES (
          'attempt:1', 'thread:1', 'run:1', 1, 'root:1', 'claudeAgent', 'pthread:1',
          'completed', '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_turns (
          provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
          status, payload_json
        ) VALUES (
          'turn:1', 'thread:1', 'pthread:1', 'root:1', 'attempt:1', 1, 'completed', '{}'
        )
      `;
      for (const turnId of ["turn:1", "turn:gone"]) {
        yield* sql`
          INSERT INTO skill_invocations (
            root_turn_id, skill_name, thread_id, driver, source, turn_status, recorded_at
          ) VALUES (
            ${turnId}, 'review', 'thread:1', 'claudeAgent', 'user', 'completed',
            '2026-10-01T00:00:00.000Z'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 60 });

      // A turn whose run is no longer projected keeps no model.
      assert.deepStrictEqual(
        yield* sql<{ readonly root_turn_id: string; readonly model: string | null }>`
          SELECT root_turn_id, model FROM skill_invocations ORDER BY root_turn_id
        `,
        [
          { root_turn_id: "turn:1", model: "claude-opus-4-5" },
          { root_turn_id: "turn:gone", model: null },
        ],
      );
    }),
  );
});
