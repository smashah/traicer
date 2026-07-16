import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  canonicalizeGitRemote,
  createProjectScopeResolver,
  parseProjectScopeId,
} from "../src/project-scope";

const scopeId = parseProjectScopeId("11111111-1111-4111-8111-111111111111");
const mappingKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("project scope resolution", () => {
  test("normalizes equivalent HTTPS and SSH remotes without credentials", () => {
    expect(canonicalizeGitRemote("https://token@example.com/varlock/varlock.git"))
      .toBe("example.com/varlock/varlock");
    expect(canonicalizeGitRemote("git@example.com:varlock/varlock.git"))
      .toBe("example.com/varlock/varlock");
    expect(canonicalizeGitRemote("ssh://git@example.com/varlock/varlock.git"))
      .toBe("example.com/varlock/varlock");
    expect(canonicalizeGitRemote("ssh://git@example.com:2222/varlock/varlock.git"))
      .toBe("example.com:2222/varlock/varlock");
  });

  test("links and resolves a repository without persisting its path or remote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-project-scope-"));
    const root = "/Users/seller/src/private-project";
    const remote = "git@github.com:seller/private-project.git";
    const commands: string[][] = [];
    const resolver = createProjectScopeResolver({
      directory,
      mappingKey,
      runGit: async (args) => {
        commands.push(args);
        if (args.at(-1) === "--show-toplevel") return { exitCode: 0, stdout: `${root}\n` };
        return { exitCode: 0, stdout: `${remote}\n` };
      },
    });

    expect(await resolver.resolve(root)).toEqual({ kind: "unlinked" });
    await resolver.link(root, scopeId);
    expect(await resolver.resolve(join(root, "packages/core"))).toEqual({
      kind: "linked",
      projectScopeId: scopeId,
    });

    const persisted = await readFile(join(directory, "project-links.json"), "utf8");
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain(remote);
    expect(persisted).not.toContain("private-project");
    expect(persisted).toContain(scopeId);
    expect(commands).toContainEqual(["-C", root, "rev-parse", "--show-toplevel"]);
  });

  test("returns explicit states for non-Git directories and missing remotes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-project-scope-"));
    const nonGit = createProjectScopeResolver({
      directory,
      mappingKey,
      runGit: async () => ({ exitCode: 128, stdout: "sensitive diagnostics" }),
    });
    expect(await nonGit.resolve("/tmp/not-a-repository")).toEqual({ kind: "not-git" });

    const noRemote = createProjectScopeResolver({
      directory,
      mappingKey,
      runGit: async (args) => args.at(-1) === "--show-toplevel"
        ? { exitCode: 0, stdout: "/tmp/repository\n" }
        : { exitCode: 2, stdout: "credential-bearing error" },
    });
    expect(await noRemote.resolve("/tmp/repository")).toEqual({ kind: "remote-missing" });
  });

  test("unlink removes only the current repository mapping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traicer-project-scope-"));
    const resolver = createProjectScopeResolver({
      directory,
      mappingKey,
      runGit: async (args) => args.at(-1) === "--show-toplevel"
        ? { exitCode: 0, stdout: "/tmp/repository\n" }
        : { exitCode: 0, stdout: "https://github.com/seller/repository.git\n" },
    });
    await resolver.link("/tmp/repository", scopeId);
    expect(await resolver.unlink("/tmp/repository")).toBe(true);
    expect(await resolver.resolve("/tmp/repository")).toEqual({ kind: "unlinked" });
    expect(await resolver.unlink("/tmp/repository")).toBe(false);
  });
});
