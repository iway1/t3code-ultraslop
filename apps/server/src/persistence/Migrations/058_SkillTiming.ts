import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // How each user turn's wall clock split between the model, its tool calls,
  // and waiting on the user (approvals and questions).
  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_turn_timing (
      root_turn_id TEXT PRIMARY KEY,
      total_ms INTEGER NOT NULL,
      model_ms INTEGER NOT NULL,
      tool_ms INTEGER NOT NULL,
      waiting_ms INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;

  // Tool time per user turn, grouped by tool (or command, `pnpm test`), one
  // set of rows per agent that made the calls: the turn's own agent and each
  // subagent it started. A repeated event replaces its agent's rows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_turn_tools (
      root_turn_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      calls INTEGER NOT NULL,
      total_ms INTEGER NOT NULL,
      max_ms INTEGER NOT NULL,
      PRIMARY KEY (root_turn_id, part_id, kind, label)
    ) WITHOUT ROWID
  `;
});
