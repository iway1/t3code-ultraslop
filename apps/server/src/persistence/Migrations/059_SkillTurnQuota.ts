import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The estimated share of the account's 5-hour and weekly usage limits each
  // agent's tokens used, priced at the rate the account was using its limits
  // when the row was written. Null when the provider has no such limits or the
  // account had used too little of them to estimate from.
  yield* sql`ALTER TABLE skill_turn_usage ADD COLUMN session_percent REAL`;
  yield* sql`ALTER TABLE skill_turn_usage ADD COLUMN weekly_percent REAL`;
});
