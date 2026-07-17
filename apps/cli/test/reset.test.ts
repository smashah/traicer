import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { parseCloudflareAccountId } from "../src/cloudflare";
import { createScaffold } from "../src/scaffold";

const exists = (path: string) => access(path).then(() => true, () => false);

test("reset destroys managed Cloudflare storage and preserves unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "traicer-reset-"));
  const directory = join(root, "config");
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
  await writeFile(join(directory, "keep-me.txt"), "unrelated\n");

  const fakeBin = join(root, "fake-bin");
  const commandLog = join(root, "pnpm-commands.log");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "pnpm"), `#!${process.execPath}\nimport { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(commandLog)}, process.argv.slice(2).join(" ") + "\\n");\n`, {
    mode: 0o755,
  });

  const invokeReset = () => Bun.spawn([
    process.execPath,
    join(import.meta.dir, "../src/index.ts"),
    "reset",
    "--yes",
    "--state-store",
    "--directory",
    directory,
  ], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    stderr: "pipe",
    stdout: "pipe",
  });

  const first = invokeReset();
  const [firstExitCode, firstStdout, firstStderr] = await Promise.all([
    first.exited,
    new Response(first.stdout).text(),
    new Response(first.stderr).text(),
  ]);
  expect(firstExitCode).toBe(0);
  expect(firstStderr).toBe("");
  expect(firstStdout).toContain("Traicer reset complete");
  expect(await exists(join(directory, "traicer.config.json"))).toBe(false);
  expect(await exists(join(directory, "infra"))).toBe(false);
  expect(await readFile(join(directory, "keep-me.txt"), "utf8")).toBe("unrelated\n");
  expect((await readFile(commandLog, "utf8")).trim().split("\n")).toEqual([
    "install",
    "alchemy destroy --yes",
    "alchemy cloudflare teardown",
  ]);

  const second = invokeReset();
  const [secondExitCode, secondStdout] = await Promise.all([
    second.exited,
    new Response(second.stdout).text(),
  ]);
  expect(secondExitCode).toBe(0);
  expect(secondStdout).toContain("Nothing to reset");
});
