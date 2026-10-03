#!/usr/bin/env node
/**
 * Extract the release notes of a tag from the CHANGELOG.md committed at that tag.
 *
 * Usage: node scripts/generate-release-notes.ts <tag> <revision> <output-file>
 *
 * Contract enforced by .github/workflows/publish.yml:
 * - `<tag>` must match ^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$ (stable releases only).
 * - `<revision>` must resolve to the same commit as refs/tags/<tag> (annotated and
 *   lightweight tags both peel to their commit).
 * - Notes are read with `git show <sha>:CHANGELOG.md`, never from the working tree.
 * - The `## [X.Y.Z]` section (optional `- YYYY-MM-DD` suffix) is matched exactly: 1.2.0
 *   never matches 1.20.0. The body runs to the next H2 heading, code fences are
 *   respected, line endings are normalized, and the body always ends with a newline.
 * - Missing, empty, or duplicate sections fail with a nonzero exit code; there is no
 *   fallback to commit-generated notes.
 *
 * Importing this module never runs the CLI.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHANGELOG_PATH = "CHANGELOG.md";

export class ReleaseNotesError extends Error {}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Track fenced code blocks (CommonMark): an opening fence is a line starting with
 * 3+ backticks (whose info string contains no backtick) or 3+ tildes; the fence
 * closes only on a line whose marker matches the character with at least the
 * opening length, followed by whitespace only.
 */
function updateFence(fence: { char: string; length: number } | null, line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (fence === null) {
    if (!match) return null;
    const char = match[1]![0]!;
    // A backtick fence's info string may not contain backticks; tilde info is allowed.
    if (char === "`" && match[2]!.includes("`")) return null;
    return { char, length: match[1]!.length };
  }
  if (match && match[1]![0] === fence.char && match[1]!.length >= fence.length && match[2]!.trim() === "") {
    return null;
  }
  return fence;
}

/**
 * Pure extraction: return the body of the `## [<version>]` section for `tag`
 * (e.g. "v1.2.0"), excluding the heading, trimmed of surrounding blank lines and
 * terminated by a newline. Throws ReleaseNotesError on an invalid tag or a missing,
 * empty, or duplicate section.
 */
export function extractReleaseNotes(changelog: string, tag: string): string {
  if (!TAG_PATTERN.test(tag)) {
    throw new ReleaseNotesError(`invalid tag "${tag}": expected vX.Y.Z`);
  }
  const version = tag.slice(1);
  const headerPattern = new RegExp(
    `^ {0,3}## \\[${escapeRegExp(version)}\\](?:[ \\t]+-[ \\t]+\\d{4}-\\d{2}-\\d{2})?[ \\t]*$`,
  );

  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  let fence: { char: string; length: number } | null = null;
  let targetIndex = -1;
  let duplicate = false;
  const sectionHeaders: number[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    fence = updateFence(fence, line);
    if (fence !== null) continue;
    // An H2 heading needs a space/tab after "##" (or ends the line); "##foo" is not one.
    if (/^ {0,3}##(?:[ \t]|$)/.test(line)) {
      sectionHeaders.push(index);
      if (headerPattern.test(line)) {
        if (targetIndex !== -1) duplicate = true;
        else targetIndex = index;
      }
    }
  }

  if (targetIndex === -1) {
    throw new ReleaseNotesError(`no "## [${version}]" section in ${CHANGELOG_PATH}`);
  }
  if (duplicate) {
    throw new ReleaseNotesError(`duplicate "## [${version}]" sections in ${CHANGELOG_PATH}`);
  }

  let endIndex = lines.length;
  for (const index of sectionHeaders) {
    if (index > targetIndex) {
      endIndex = index;
      break;
    }
  }

  const body = lines.slice(targetIndex + 1, endIndex);
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
  if (body.length === 0) {
    throw new ReleaseNotesError(`empty "## [${version}]" section in ${CHANGELOG_PATH}`);
  }
  return `${body.join("\n")}\n`;
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...(cwd === undefined ? {} : { cwd }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReleaseNotesError(`git ${args.join(" ")} failed: ${detail}`);
  }
}

/**
 * Resolve `<tag>` against `<revision>` in the repository at `cwd` and return the
 * release notes extracted from the CHANGELOG.md committed at that tag.
 */
export function generateReleaseNotes(tag: string, revision: string, options?: { cwd?: string }): string {
  const cwd = options?.cwd;
  if (!TAG_PATTERN.test(tag)) {
    throw new ReleaseNotesError(`invalid tag "${tag}": expected vX.Y.Z`);
  }
  const version = tag.slice(1);

  const revisionCommit = git(
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    cwd,
  ).trim();
  const tagCommit = git(
    ["rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}^{commit}`],
    cwd,
  ).trim();
  if (revisionCommit !== tagCommit) {
    throw new ReleaseNotesError(
      `${revision} (${revisionCommit}) does not point at refs/tags/${tag} (${tagCommit})`,
    );
  }

  const changelog = git(["show", `${tagCommit}:${CHANGELOG_PATH}`], cwd);
  return extractReleaseNotes(changelog, `v${version}`);
}

function main(argv: string[]): void {
  if (argv.length !== 3) {
    console.error(
      "generate-release-notes: error: usage: node scripts/generate-release-notes.ts <tag> <revision> <output-file>",
    );
    process.exit(1);
  }
  const [tag, revision, output] = argv as [string, string, string];
  try {
    const notes = generateReleaseNotes(tag, revision);
    writeFileSync(output, notes);
    console.log(`generate-release-notes: wrote ${output} from ${tag}`);
  } catch (error) {
    if (error instanceof ReleaseNotesError) {
      console.error(`generate-release-notes: error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2));
