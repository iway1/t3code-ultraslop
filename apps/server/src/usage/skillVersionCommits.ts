/**
 * Names skill versions after commits. The SKILL.md at each recent commit that
 * touched it is hashed the way a recorded version is, and each version takes
 * the oldest commit with the same contents. A version no commit has (edited
 * since the last commit, or kept outside git) stays unnamed.
 *
 * @module usage/skillVersionCommits
 */
import * as NodeCrypto from "node:crypto";

import type { SkillVersionCommit } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as VcsProcess from "../vcs/VcsProcess.ts";

const MAX_LOGGED_COMMITS = 50;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const FIELD_SEPARATOR = "\u001f";

/** Commits from `git log --format=%H%x1f%ct%x1f%s`, newest first. */
export function parseCommitLog(stdout: string): ReadonlyArray<SkillVersionCommit> {
  return stdout.split("\n").flatMap((line) => {
    const [sha, committedAtSeconds, ...subject] = line.split(FIELD_SEPARATOR);
    const committedAt = DateTime.make(Number(committedAtSeconds) * 1000);
    return sha && Option.isSome(committedAt)
      ? [
          {
            sha,
            subject: subject.join(FIELD_SEPARATOR),
            committedAt: DateTime.formatIso(committedAt.value),
          },
        ]
      : [];
  });
}

/** Each requested object's bytes from `git cat-file --batch`, null where it is missing. */
export function parseCatFileBatch(output: Uint8Array): ReadonlyArray<Uint8Array | null> {
  const decoder = new TextDecoder();
  const objects: Array<Uint8Array | null> = [];
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    // `<oid> <type> <size>`, or `<name> missing` when there is no such object.
    const header = decoder.decode(output.subarray(offset, headerEnd)).split(" ");
    offset = headerEnd + 1;
    const size = header.length === 3 ? Number(header[2]) : Number.NaN;
    if (!Number.isInteger(size)) {
      objects.push(null);
      continue;
    }
    objects.push(output.subarray(offset, offset + size));
    offset += size + 1;
  }
  return objects;
}

/** The oldest commit per content hash, from commits newest first and their contents alongside. */
export function oldestCommitByHash(
  commits: ReadonlyArray<SkillVersionCommit>,
  contents: ReadonlyArray<Uint8Array | null>,
): ReadonlyMap<string, SkillVersionCommit> {
  const byHash = new Map<string, SkillVersionCommit>();
  commits.forEach((commit, index) => {
    const bytes = contents[index];
    if (bytes === undefined || bytes === null) return;
    byHash.set(NodeCrypto.createHash("sha256").update(bytes).digest("hex"), commit);
  });
  return byHash;
}

/**
 * The commits that had each version of `file` in `cwd`, by content hash.
 * Empty when the file is not in a git repository or git fails.
 */
export const versionCommitsAt = (
  process: VcsProcess.VcsProcess["Service"],
  cwd: string,
  file: string,
) =>
  Effect.gen(function* () {
    const log = yield* process.run({
      operation: "SkillUsage.versionCommits.log",
      command: "git",
      args: ["log", `--max-count=${MAX_LOGGED_COMMITS}`, "--format=%H%x1f%ct%x1f%s", "--", file],
      cwd,
    });
    const commits = parseCommitLog(log.stdout);
    if (commits.length === 0) return new Map<string, SkillVersionCommit>();
    const chunks: Array<Uint8Array> = [];
    yield* process.run({
      operation: "SkillUsage.versionCommits.contents",
      command: "git",
      args: ["cat-file", "--batch"],
      cwd,
      // `./` resolves the path from `cwd`, wherever the repository root is.
      stdin: commits.map((commit) => `${commit.sha}:./${file}\n`).join(""),
      // The text output would mangle bytes that are not UTF-8; hash what git wrote.
      onStdoutChunk: (chunk) => chunks.push(chunk),
      maxOutputBytes: MAX_CONTENT_BYTES,
      outputMode: "error",
    });
    return oldestCommitByHash(commits, parseCatFileBatch(Buffer.concat(chunks)));
  }).pipe(
    Effect.catch((cause) =>
      Effect.logDebug("skill version commits unavailable", { cause }).pipe(
        Effect.as(new Map<string, SkillVersionCommit>()),
      ),
    ),
  );
