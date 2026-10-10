import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The model each user turn's run started with, so the Skill Monitor can
  // compare a skill across models.
  yield* sql`ALTER TABLE skill_invocations ADD COLUMN model TEXT`;

  // Turns recorded earlier take it from their run, while it is still projected.
  yield* sql`
    UPDATE skill_invocations
    SET model = (
      SELECT json_extract(run.payload_json, '$.modelSelection.model')
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
      WHERE turn.provider_turn_id = skill_invocations.root_turn_id
    )
  `;
});
