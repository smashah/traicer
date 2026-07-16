import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { base64UrlToBytes, bytesToBase64Url } from "@traice/crypto";

declare const projectScopeIdBrand: unique symbol;

export type ProjectScopeId = string & {
  readonly [projectScopeIdBrand]: true;
};

export type ProjectScopeResolution =
  | { readonly kind: "linked"; readonly projectScopeId: ProjectScopeId }
  | { readonly kind: "not-git" | "remote-missing" | "unlinked" };

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
}

interface ProjectScopeResolverOptions {
  readonly directory: string;
  readonly mappingKey: string;
  readonly runGit?: (args: string[]) => Promise<GitResult>;
}

interface ProjectLinksFile {
  readonly links: Readonly<Record<string, ProjectScopeId>>;
  readonly schema: "traicer.project-links/1";
}

const projectScopePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export const parseProjectScopeId = (value: string): ProjectScopeId => {
  const normalized = value.trim().toLowerCase();
  if (!projectScopePattern.test(normalized)) {
    throw new Error("Expected a UUID project scope ID");
  }
  return normalized as ProjectScopeId;
};

const normalizedRepositoryPath = (value: string): string => {
  const normalized = value
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Git remote has no repository path");
  }
  return normalized;
};

export const canonicalizeGitRemote = (value: string): string => {
  const remote = value.trim();
  const scp = remote.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  if (scp && !remote.includes("://")) {
    const host = scp[1]?.toLowerCase();
    const path = scp[2];
    if (!host || !path) throw new Error("Git remote is not supported");
    return `${host}/${normalizedRepositoryPath(path)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error("Git remote is not supported");
  }
  if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) {
    throw new Error("Git remote protocol is not supported");
  }
  if (!parsed.hostname) throw new Error("Git remote has no host");
  return `${parsed.host.toLowerCase()}/${normalizedRepositoryPath(parsed.pathname)}`;
};

const defaultRunGit = async (args: string[]): Promise<GitResult> => {
  const child = Bun.spawn(["git", ...args], {
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stdout };
};

const fingerprint = async (mappingKey: string, canonicalRemote: string): Promise<string> => {
  const keyBytes = base64UrlToBytes(mappingKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error("Project mapping key must contain 32 bytes");
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(keyBytes).buffer,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    const digest = new Uint8Array(await crypto.subtle.sign(
      "HMAC",
      key,
      Uint8Array.from(encoder.encode(`traicer/project-link/v1:${canonicalRemote}`)).buffer
    ));
    return `h1_${bytesToBase64Url(digest)}`;
  } finally {
    keyBytes.fill(0);
  }
};

const emptyLinks = (): ProjectLinksFile => ({ links: {}, schema: "traicer.project-links/1" });

const parseLinks = (value: unknown): ProjectLinksFile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project link registry is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== "traicer.project-links/1" || !record.links || typeof record.links !== "object" || Array.isArray(record.links)) {
    throw new Error("Project link registry is invalid");
  }
  const links = Object.fromEntries(Object.entries(record.links as Record<string, unknown>).map(([key, scope]) => {
    if (!/^h1_[A-Za-z0-9_-]{43}$/.test(key) || typeof scope !== "string") {
      throw new Error("Project link registry is invalid");
    }
    return [key, parseProjectScopeId(scope)];
  }));
  return { links, schema: "traicer.project-links/1" };
};

export const createProjectScopeResolver = (options: ProjectScopeResolverOptions) => {
  const directory = resolve(options.directory);
  const path = resolve(directory, "project-links.json");
  const runGit = options.runGit ?? defaultRunGit;

  const readLinks = async (): Promise<ProjectLinksFile> => {
    try {
      return parseLinks(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return emptyLinks();
      }
      throw error;
    }
  };

  const writeLinks = async (links: ProjectLinksFile): Promise<void> => {
    await mkdir(directory, { mode: 0o700, recursive: true });
    const temporary = resolve(directory, `.project-links.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(links, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  };

  const repositoryFingerprint = async (
    cwd: string
  ): Promise<{ readonly kind: "found"; readonly value: string } | { readonly kind: "not-git" | "remote-missing" }> => {
    const root = await runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
    if (root.exitCode !== 0 || !root.stdout.trim()) return { kind: "not-git" };
    const remote = await runGit(["-C", root.stdout.trim(), "remote", "get-url", "origin"]);
    if (remote.exitCode !== 0 || !remote.stdout.trim()) return { kind: "remote-missing" };
    return {
      kind: "found",
      value: await fingerprint(options.mappingKey, canonicalizeGitRemote(remote.stdout)),
    };
  };

  return {
    link: async (cwd: string, projectScopeId: ProjectScopeId): Promise<void> => {
      const repository = await repositoryFingerprint(cwd);
      if (repository.kind !== "found") throw new Error(`Cannot link project: ${repository.kind}`);
      const current = await readLinks();
      await writeLinks({
        links: { ...current.links, [repository.value]: projectScopeId },
        schema: "traicer.project-links/1",
      });
    },
    resolve: async (cwd: string): Promise<ProjectScopeResolution> => {
      const repository = await repositoryFingerprint(cwd);
      if (repository.kind !== "found") return repository;
      const projectScopeId = (await readLinks()).links[repository.value];
      return projectScopeId ? { kind: "linked", projectScopeId } : { kind: "unlinked" };
    },
    unlink: async (cwd: string): Promise<boolean> => {
      const repository = await repositoryFingerprint(cwd);
      if (repository.kind !== "found") return false;
      const current = await readLinks();
      if (!current.links[repository.value]) return false;
      const links = { ...current.links };
      delete links[repository.value];
      if (Object.keys(links).length === 0) {
        await unlink(path).catch((error: unknown) => {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        });
      } else {
        await writeLinks({ links, schema: "traicer.project-links/1" });
      }
      return true;
    },
  };
};
