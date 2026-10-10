import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Token use of each user turn, one row per agent that did the work: the
  // turn's own agent (`part_id` = the turn) and each subagent it started,
  // however late that subagent finishes. Rows are replaced, never added to,
  // so a repeated event cannot count twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_turn_usage (
      root_turn_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (root_turn_id, part_id)
    ) WITHOUT ROWID
  `;

  // The skills each user turn ran. `content_hash` is the SHA-256 of the
  // skill's SKILL.md when the turn ended, and identifies the version.
  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_invocations (
      root_turn_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      skill_path TEXT,
      content_hash TEXT,
      source TEXT NOT NULL,
      turn_status TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (root_turn_id, skill_name)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill
    ON skill_invocations(skill_name, content_hash)
  `;
});
