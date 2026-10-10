// @effect-diagnostics nodeBuiltinImport:off - builds a real repository with the git CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { parseCatFileBatch, versionCommitsAt } from "./skillVersionCommits.ts";

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const commitsAt = (path: string) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return yield* versionCommitsAt(process, NodePath.dirname(path), NodePath.basename(path));
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))));

const tempDirs: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "skill-commits-"));
  tempDirs.push(dir);
  return dir;
};

describe("skillVersionCommits", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("reads each object's bytes and marks missing ones", () => {
    const output = new TextEncoder().encode(
      "aaa blob 3\nv2\n\nbbb:./SKILL.md missing\nccc blob 5\nhello\n",
    );
    assert.deepStrictEqual(
      parseCatFileBatch(output).map((bytes) =>
        bytes === null ? null : new TextDecoder().decode(bytes),
      ),
      ["v2\n", null, "hello"],
    );
  });

  it.effect("names each version after the oldest commit with its SKILL.md", () =>
    Effect.gen(function* () {
      const root = tempDir();
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
          { cwd: root, encoding: "utf8" },
        ).trim();
      const path = NodePath.join(root, "skills", "review", "SKILL.md");
      // Bytes that are not UTF-8 still match the recorded hash.
      const v1 = Buffer.from([0x72, 0x31, 0xff, 0x0a]);
      git("init", "-q");
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, v1);
      git("add", ".");
      git("commit", "-qm", "Add review skill");
      const first = git("rev-parse", "HEAD");
      NodeFS.writeFileSync(path, "review v2\n");
      git("commit", "-qam", "Tighten review steps");
      const second = git("rev-parse", "HEAD");
      NodeFS.writeFileSync(path, v1);
      git("commit", "-qam", "Revert review steps");
      // Edited since the last commit: no commit has it.
      NodeFS.writeFileSync(path, "review v3\n");

      const commits = yield* commitsAt(path);
      assert.deepStrictEqual(
        Object.fromEntries(
          [...commits].map(([hash, commit]) => [hash, [commit.sha, commit.subject]]),
        ),
        {
          [sha256(v1)]: [first, "Add review skill"],
          [sha256("review v2\n")]: [second, "Tighten review steps"],
        },
      );
    }),
  );

  it.effect("names nothing outside a git repository", () =>
    Effect.gen(function* () {
      const root = tempDir();
      const path = NodePath.join(root, "SKILL.md");
      NodeFS.writeFileSync(path, "loose\n");
      assert.strictEqual((yield* commitsAt(path)).size, 0);
    }),
  );
});
