import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { parseCloudflareAccountId } from "../src/cloudflare";
import { createScaffold } from "../src/scaffold";

test("rerunning init resumes a failed managed storage deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "traicer-init-resume-"));
  const accountId = parseCloudflareAccountId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await createScaffold({
    accountId,
    directory,
    marketplaceApiBaseUrl: "https://api.traice.market",
    region: "auto",
    storage: "cloudflare-r2",
  }, {
    encryptSecret: async () => 'varlock("encrypted-fixture")',
    generateSigningKeyPair: async () => ({
      keyId: "fixture-key-id",
      privateKey: "fixture-private-key",
      publicKey: "fixture-public-key",
    }),
    randomBytes: (length) => new Uint8Array(length).fill(7),
    randomUuid: () => "12345678-1234-1234-1234-123456789abc",
  });

  const configPath = join(directory, "traicer.config.json");
  const environmentPath = join(directory, ".env.local");
  const infrastructurePackagePath = join(directory, "infra/package.json");
  const infrastructureWorkspacePath = join(directory, "infra/pnpm-workspace.yaml");
  const originalConfig = await readFile(configPath, "utf8");
  const originalEnvironment = await readFile(environmentPath, "utf8");
  const infrastructurePackage = JSON.parse(
    await readFile(infrastructurePackagePath, "utf8")
  ) as { dependencies: Record<string, string> };
  infrastructurePackage.dependencies.alchemy = "2.0.0-beta.61";
  await writeFile(infrastructurePackagePath, `${JSON.stringify(infrastructurePackage, null, 2)}\n`);

  const fakeBin = join(directory, "fake-bin");
  const commandLog = join(directory, "pnpm-commands.log");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "pnpm"), `#!${process.execPath}\nimport { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(commandLog)}, process.argv.slice(2).join(" ") + "\\n");\n`, {
    mode: 0o755,
  });

  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../src/index.ts"),
    "init",
    "--yes",
    "--deploy",
    "--storage",
    "cloudflare-r2",
    "--account-id",
    accountId,
    "--directory",
    directory,
  ], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("Resuming storage deployment");
  expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  expect(await readFile(environmentPath, "utf8")).toBe(originalEnvironment);
  expect(JSON.parse(await readFile(infrastructurePackagePath, "utf8")).dependencies.alchemy)
    .toBe("2.0.0-beta.62");
  expect(await readFile(infrastructureWorkspacePath, "utf8"))
    .toContain("  - 'alchemy@2.0.0-beta.62'");
  expect((await readFile(commandLog, "utf8")).trim().split("\n")).toEqual([
    "install",
    "alchemy deploy",
  ]);
});
