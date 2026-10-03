import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ReleaseNotesError, extractReleaseNotes, generateReleaseNotes } from "../scripts/generate-release-notes.ts";

const CHANGELOG = `# Changelog

## [1.2.0] - 2026-09-25

Editorial summary of the release.

### Features
- Feature one

### Fixes
- Fix one

## [1.20.0] - 2026-10-01

Later release that must never match 1.2.0.
`;

describe("extractReleaseNotes", () => {
  test("extracts the body of the requested section without the heading", () => {
    expect(extractReleaseNotes(CHANGELOG, "v1.2.0")).toBe(
      "Editorial summary of the release.\n\n### Features\n- Feature one\n\n### Fixes\n- Fix one\n",
    );
  });

  test("matches the version exactly: v1.2.0 does not match v1.20.0", () => {
    expect(extractReleaseNotes(CHANGELOG, "v1.20.0")).toBe(
      "Later release that must never match 1.2.0.\n",
    );
  });

  test("keeps a section that ends at the end of the file and terminates with a newline", () => {
    const notes = extractReleaseNotes(CHANGELOG, "v1.20.0");
    expect(notes.endsWith("\n")).toBe(true);
    expect(notes.endsWith("\n\n")).toBe(false);
  });

  test("preserves meaningful whitespace inside the body", () => {
    const changelog = "# Changelog\n\n## [0.1.0]\n\nIntro\n\n    indented block\n\nTail\n";
    expect(extractReleaseNotes(changelog, "v0.1.0")).toBe(
      "Intro\n\n    indented block\n\nTail\n",
    );
  });

  test("accepts headings indented up to three spaces with trailing horizontal whitespace", () => {
    const changelog = "# Changelog\n\n   ## [0.1.0] - 2026-09-25  \n\nBody.\n";
    expect(extractReleaseNotes(changelog, "v0.1.0")).toBe("Body.\n");
  });

  test("rejects a heading indented more than three spaces", () => {
    const changelog = "# Changelog\n\n    ## [0.1.0]\n\nBody.\n\n## [0.2.0]\n\nLater.\n";
    expect(() => extractReleaseNotes(changelog, "v0.1.0")).toThrow(ReleaseNotesError);
  });

  test("does not end the section at an H3 heading", () => {
    const changelog = "# Changelog\n\n## [0.1.0]\n\n### Notes\n- item\n";
    expect(extractReleaseNotes(changelog, "v0.1.0")).toBe("### Notes\n- item\n");
  });

  test("ignores headings inside backtick fences but keeps the fenced block", () => {
    const changelog = `# Changelog

## [0.1.0]

Example:

\`\`\`md
## [not-a-release]
\`\`\`

Real closing content.
`;
    const notes = extractReleaseNotes(changelog, "v0.1.0");
    expect(notes).toContain("## [not-a-release]");
    expect(notes).toContain("Real closing content.");
    expect(notes).not.toContain("# Changelog");
  });

  test("ignores headings inside tilde fences", () => {
    const changelog = "# Changelog\n\n## [0.1.0]\n\n~~~\n## [not-a-release]\n~~~\nAfter.\n";
    const notes = extractReleaseNotes(changelog, "v0.1.0");
    expect(notes).toContain("## [not-a-release]");
    expect(notes).toContain("After.");
  });

  test("does not close a fence with a marker followed by non-whitespace", () => {
    const backtick = [
      "# Changelog",
      "",
      "## [0.1.0]",
      "",
      "````md",
      "```` trailing-text",
      "## [not-a-release]",
      "still fenced",
      "````",
      "",
      "## [0.2.0]",
      "",
      "Later.",
      "",
    ].join("\n");
    const notes = extractReleaseNotes(backtick, "v0.1.0");
    expect(notes).toContain("```` trailing-text");
    expect(notes).toContain("## [not-a-release]");
    expect(notes).toContain("still fenced");
    expect(notes).not.toContain("Later.");

    const tilde = "# Changelog\n\n## [0.1.0]\n\n~~~~\n~~~~ trailing\n## [not-a-release]\n~~~~\n\n## [0.2.0]\n\nLater.\n";
    const tildeNotes = extractReleaseNotes(tilde, "v0.1.0");
    expect(tildeNotes).toContain("~~~~ trailing");
    expect(tildeNotes).toContain("## [not-a-release]");
    expect(tildeNotes).not.toContain("Later.");
  });

  test("ends the section at an H2 heading separated by a tab or a bare ##", () => {
    const tabbed = "# Changelog\n\n## [0.1.0]\n\nBody.\n##\t[0.2.0]\n\nLater.\n";
    expect(extractReleaseNotes(tabbed, "v0.1.0")).toBe("Body.\n");

    const bare = "# Changelog\n\n## [0.1.0]\n\nBody.\n##\n\nLater.\n";
    expect(extractReleaseNotes(bare, "v0.1.0")).toBe("Body.\n");
  });

  test("does not open a backtick fence whose info string contains a backtick", () => {
    const changelog = "# Changelog\n\n## [0.1.0]\n\n```md `snippet`\n## [0.2.0]\n\nLater.\n";
    expect(extractReleaseNotes(changelog, "v0.1.0")).toBe("```md `snippet`\n");
    expect(extractReleaseNotes(changelog, "v0.2.0")).toBe("Later.\n");
  });

  test("still opens a backtick fence with a valid info string", () => {
    const changelog = "# Changelog\n\n## [0.1.0]\n\n```md\n## [not-a-release]\n```\nAfter.\n";
    const notes = extractReleaseNotes(changelog, "v0.1.0");
    expect(notes).toContain("## [not-a-release]");
    expect(notes).toContain("After.");
  });

  test("closes a fence only with a marker of at least the opener length", () => {
    const changelog = "# Changelog\n\n## [0.1.0]\n\n````md\n```\nstill fenced\n````\n## [0.2.0]\n\nLater.\n";
    const notes = extractReleaseNotes(changelog, "v0.1.0");
    expect(notes).toContain("still fenced");
    expect(notes).toContain("```");
  });

  test("normalizes CRLF and lone CR line endings", () => {
    const crlf = "# Changelog\r\n\r\n## [0.1.0] - 2026-09-25\r\n\r\nBody line.\r\n";
    const notes = extractReleaseNotes(crlf, "v0.1.0");
    expect(notes).toBe("Body line.\n");
    expect(notes.includes("\r")).toBe(false);

    const cr = "# Changelog\r\r## [0.1.0]\r\rBody.\r";
    expect(extractReleaseNotes(cr, "v0.1.0")).toBe("Body.\n");
  });

  test("trims surrounding blank lines but keeps a final newline", () => {
    const changelog = "# Changelog\n\n## [0.1.0]\n\n\nBody.\n\n\n\n## [0.2.0]\n\nLater.\n";
    expect(extractReleaseNotes(changelog, "v0.1.0")).toBe("Body.\n");
  });

  test("handles CRLF hard breaks inside the body", () => {
    const changelog = "# Changelog\r\n\r\n## [0.1.0]\r\n\r\nLine one.\r\nLine two.\r\n\r\n## [0.2.0]\r\n\r\nLater.\r\n";
    expect(extractReleaseNotes(changelog, "v0.1.0")).toBe("Line one.\nLine two.\n");
  });

  test("throws on a missing section", () => {
    expect(() => extractReleaseNotes(CHANGELOG, "v9.9.9")).toThrow(ReleaseNotesError);
    expect(() => extractReleaseNotes("", "v0.1.0")).toThrow(ReleaseNotesError);
  });

  test("throws on an empty section", () => {
    const changelog = "# Changelog\n\n## [0.1.0] - 2026-09-25\n\n## [0.2.0] - 2026-09-26\n\nBody.\n";
    expect(() => extractReleaseNotes(changelog, "v0.1.0")).toThrow(ReleaseNotesError);
  });

  test("throws on adjacent duplicate sections", () => {
    const changelog =
      "# Changelog\n\n## [0.1.0] - 2026-09-25\n\nFirst.\n\n## [0.1.0] - 2026-09-25\n\nSecond.\n";
    expect(() => extractReleaseNotes(changelog, "v0.1.0")).toThrow(/duplicate/);
  });

  test("throws on duplicates separated by another release", () => {
    const changelog =
      "# Changelog\n\n## [0.1.0] - 2026-09-25\n\nFirst.\n\n## [0.2.0] - 2026-09-26\n\nMiddle.\n\n## [0.1.0] - 2026-09-25\n\nSecond.\n";
    expect(() => extractReleaseNotes(changelog, "v0.1.0")).toThrow(/duplicate/);
  });

  test("does not treat a duplicate as extracted even when it appears before other releases", () => {
    const changelog =
      "# Changelog\n\n## [0.1.0]\n\nFirst.\n\n## [0.1.0]\n\nSecond.\n\n## [0.2.0]\n\nLater.\n";
    expect(() => extractReleaseNotes(changelog, "v0.1.0")).toThrow(/duplicate/);
  });

  test("rejects an invalid tag", () => {
    expect(() => extractReleaseNotes(CHANGELOG, "1.2.0")).toThrow(/invalid tag/);
    expect(() => extractReleaseNotes(CHANGELOG, "v1.2")).toThrow(/invalid tag/);
    expect(() => extractReleaseNotes(CHANGELOG, "v01.2.0")).toThrow(/invalid tag/);
    expect(() => extractReleaseNotes(CHANGELOG, "v1.2.0-beta.1")).toThrow(/invalid tag/);
  });

  test("rejects a version whose heading differs only by surrounding text", () => {
    const changelog = "# Changelog\n\n## [0.1.0-extra]\n\nBody.\n";
    expect(() => extractReleaseNotes(changelog, "v0.1.0")).toThrow(ReleaseNotesError);
  });
});


function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "test"]);
  git(["config", "user.email", "test@example.com"]);
  return dir;
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
    .toString()
    .trim();
}

function commitChangelog(dir: string, changelog: string): string {
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  gitIn(dir, ["add", "CHANGELOG.md"]);
  gitIn(dir, ["commit", "-m", "changelog", "--no-verify"]);
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

describe("generateReleaseNotes", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("reads notes from the tagged commit with an annotated tag", () => {
    const repo = makeRepo("release-notes-");
    cleanup.push(repo);
    const sha = commitChangelog(repo, CHANGELOG);
    gitIn(repo, ["tag", "-a", "v1.2.0", "-m", "release"]);

    const notes = generateReleaseNotes("v1.2.0", sha, { cwd: repo });
    expect(notes).toContain("Editorial summary of the release.");
    expect(notes).toContain("- Fix one");
  });

  test("reads notes from the tagged commit with a lightweight tag", () => {
    const repo = makeRepo("release-notes-");
    cleanup.push(repo);
    const sha = commitChangelog(repo, CHANGELOG);
    gitIn(repo, ["tag", "v1.2.0"]);

    expect(generateReleaseNotes("v1.2.0", sha, { cwd: repo })).toContain(
      "Editorial summary of the release.",
    );
  });

  test("ignores working-tree edits and reads the committed changelog", () => {
    const repo = makeRepo("release-notes-");
    cleanup.push(repo);
    commitChangelog(repo, CHANGELOG);
    gitIn(repo, ["tag", "v1.2.0"]);
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [1.2.0]\n\nDirty edit.\n");

    const notes = generateReleaseNotes("v1.2.0", "HEAD", { cwd: repo });
    expect(notes).not.toContain("Dirty edit.");
    expect(notes).toContain("Editorial summary of the release.");
  });

  test("fails when the revision does not point at the tag commit", () => {
    const repo = makeRepo("release-notes-");
    cleanup.push(repo);
    commitChangelog(repo, CHANGELOG);
    gitIn(repo, ["tag", "v1.2.0"]);
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [1.2.0]\n\nSecond.\n");
    gitIn(repo, ["add", "CHANGELOG.md"]);
    gitIn(repo, ["commit", "-m", "second", "--no-verify"]);

    expect(() => generateReleaseNotes("v1.2.0", "HEAD", { cwd: repo })).toThrow(
      /does not point at/,
    );
  });

  test("fails when the tagged changelog is missing", () => {
    const repo = makeRepo("release-notes-");
    cleanup.push(repo);
    writeFileSync(join(repo, "README.md"), "no changelog\n");
    gitIn(repo, ["add", "README.md"]);
    gitIn(repo, ["commit", "-m", "readme", "--no-verify"]);
    const sha = gitIn(repo, ["rev-parse", "HEAD"]);
    gitIn(repo, ["tag", "v1.2.0"]);

    expect(() => generateReleaseNotes("v1.2.0", sha, { cwd: repo })).toThrow(/CHANGELOG/);
  });

  test("fails on an invalid tag", () => {
    const repo = makeRepo("release-notes-");
    cleanup.push(repo);
    const sha = commitChangelog(repo, CHANGELOG);
    expect(() => generateReleaseNotes("1.2.0", sha, { cwd: repo })).toThrow(/invalid tag/);
    expect(() => generateReleaseNotes("v1.2.0-rc.1", sha, { cwd: repo })).toThrow(/invalid tag/);
  });
});

describe("CLI", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const SCRIPT = join(import.meta.dirname, "..", "scripts", "generate-release-notes.ts");

  function run(repo: string, args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("node", [SCRIPT, ...args], {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const err = error as { status: number; stdout: string; stderr: string };
      return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  test("writes notes for a tagged commit", () => {
    const repo = makeRepo("release-notes-cli-");
    cleanup.push(repo);
    commitChangelog(repo, CHANGELOG);
    gitIn(repo, ["tag", "v1.2.0"]);
    const sha = gitIn(repo, ["rev-parse", "HEAD"]);
    const output = join(repo, "notes.md");

    const result = run(repo, ["v1.2.0", sha, output]);
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("Editorial summary of the release.");
  });

  test("rejects a fourth argument and accepts --end-of-options as the output name", () => {
    const repo = makeRepo("release-notes-cli-");
    cleanup.push(repo);
    commitChangelog(repo, CHANGELOG);
    gitIn(repo, ["tag", "v1.2.0"]);
    const sha = gitIn(repo, ["rev-parse", "HEAD"]);
    const output = join(repo, "notes.md");

    const rejected = run(repo, ["v1.2.0", sha, output, "--end-of-options"]);
    expect(rejected.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);

    const accepted = run(repo, ["v1.2.0", sha, "--end-of-options"]);
    expect(accepted.status).toBe(0);
    expect(readFileSync(join(repo, "--end-of-options"), "utf8")).toContain(
      "Editorial summary of the release.",
    );
  });

  test("rejects wrong argument counts and exits nonzero on mismatch", () => {
    const repo = makeRepo("release-notes-cli-");
    cleanup.push(repo);
    expect(run(repo, []).status).not.toBe(0);
    expect(run(repo, ["v1.2.0", "HEAD"]).status).not.toBe(0);
    expect(run(repo, ["v1.2.0", "HEAD", "out.md", "extra"]).status).not.toBe(0);

    commitChangelog(repo, CHANGELOG);
    gitIn(repo, ["tag", "v1.2.0"]);
    gitIn(repo, ["commit", "--allow-empty", "-m", "next", "--no-verify"]);

    const mismatch = run(repo, ["v1.2.0", "HEAD", join(repo, "notes.md")]);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/does not point at/);
  });
});
