import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runSeedSkillMonitor } from "./seed-skill-monitor.ts";

const seedInput = { days: 14, seed: 7, clear: false, addProject: false } as const;

it.layer(NodeServices.layer)("seed-skill-monitor", (it) => {
  it.effect("replaces only its own runs, and clears them on request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const sharedHome = yield* fs.makeTempDirectoryScoped();
      const first = yield* runSeedSkillMonitor({ ...seedInput, baseDir }, { sharedHome });
      assert.isAbove(first.runs, 0);

      const counts = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly seeded: number; readonly real: number }>`
          SELECT
            SUM(root_turn_id LIKE 'seed:%') AS "seeded",
            SUM(root_turn_id NOT LIKE 'seed:%') AS "real"
          FROM skill_invocations
        `;
        return rows[0];
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: first.databasePath })));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO skill_invocations (
            root_turn_id, skill_name, thread_id, driver, source, turn_status, recorded_at
          ) VALUES (
            'turn:real', 'code-review', 'thread:real', 'codex', 'user', 'completed',
            '2026-10-01T00:00:00.000Z'
          )
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: first.databasePath })));

      yield* runSeedSkillMonitor({ ...seedInput, baseDir }, { sharedHome });
      assert.deepStrictEqual(yield* counts, { seeded: first.runs, real: 1 });
      yield* runSeedSkillMonitor({ ...seedInput, baseDir, clear: true }, { sharedHome });
      assert.deepStrictEqual(yield* counts, { seeded: 0, real: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped();
      const exit = yield* runSeedSkillMonitor(
        { ...seedInput, baseDir: sharedHome },
        { sharedHome },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(yield* fs.exists(path.join(sharedHome, "userdata")));
    }).pipe(Effect.scoped),
  );
});
