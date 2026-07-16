import { describe, expect, test } from "bun:test";

import {
  discoverWranglerIdentity,
  findWranglerExecutables,
  parseCloudflareAccountId,
  parseWranglerIdentity,
} from "../src/cloudflare";

const whoami = {
  loggedIn: true,
  email: "seller@example.com",
  accounts: [
    { id: "11111111111111111111111111111111", name: "Personal" },
    { id: "22222222222222222222222222222222", name: "Studio" },
  ],
};
const identity = {
  accounts: whoami.accounts.map((account) => ({
    ...account,
    id: parseCloudflareAccountId(account.id),
  })),
  email: "seller@example.com",
};

describe("Wrangler account discovery", () => {
  test("normalizes a valid Cloudflare account ID", () => {
    expect(String(parseCloudflareAccountId(" AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ")))
      .toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("parses only the public identity fields needed by init", () => {
    expect(parseWranglerIdentity({
      ...whoami,
      tokenPermissions: ["account:read", "workers:write"],
    })).toEqual(identity);
  });

  test("rejects malformed account metadata", () => {
    expect(() => parseWranglerIdentity({
      ...whoami,
      accounts: [{ id: "not-an-account-id", name: "Broken" }],
    })).toThrow("32-character Cloudflare account ID");
  });

  test("runs the installed Wrangler CLI with JSON output", async () => {
    const commands: string[][] = [];
    const result = await discoverWranglerIdentity({
      findWranglers: () => ["/usr/local/bin/wrangler"],
      runWrangler: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: JSON.stringify(whoami) };
      },
    });

    expect(commands).toEqual([["/usr/local/bin/wrangler", "whoami", "--json"]]);
    expect(result).toEqual({
      identity,
      status: "authenticated",
    });
  });

  test("skips an incompatible PATH candidate and uses the next Wrangler", async () => {
    const commands: string[][] = [];
    const result = await discoverWranglerIdentity({
      findWranglers: () => [
        "/Users/seller/node_modules/.bin/wrangler",
        "/opt/homebrew/bin/wrangler",
      ],
      runWrangler: async (command) => {
        commands.push(command);
        return command[0]?.includes("node_modules")
          ? { exitCode: 1, stdout: "" }
          : { exitCode: 0, stdout: JSON.stringify(whoami) };
      },
    });

    expect(commands).toEqual([
      ["/Users/seller/node_modules/.bin/wrangler", "whoami", "--json"],
      ["/opt/homebrew/bin/wrangler", "whoami", "--json"],
    ]);
    expect(result).toEqual({
      identity,
      status: "authenticated",
    });
  });

  test("falls back cleanly when Wrangler is unavailable", async () => {
    expect(await discoverWranglerIdentity({
      findWranglers: () => [],
      runWrangler: async () => {
        throw new Error("should not run");
      },
    })).toEqual({ status: "unavailable" });
  });

  test("does not expose Wrangler errors when authentication fails", async () => {
    expect(await discoverWranglerIdentity({
      findWranglers: () => ["wrangler"],
      runWrangler: async () => ({ exitCode: 1, stdout: "sensitive diagnostics" }),
    })).toEqual({ status: "unauthenticated" });
  });

  test("enumerates executable PATH candidates in order and removes aliases", () => {
    expect(findWranglerExecutables({
      environment: { PATH: "/first:/second:/alias" },
      platform: "darwin",
      resolveExecutable: (candidate) => {
        if (candidate === "/first/wrangler") return "/real/old-wrangler";
        if (candidate === "/second/wrangler") return "/real/new-wrangler";
        if (candidate === "/alias/wrangler") return "/real/new-wrangler";
        return undefined;
      },
    })).toEqual([
      "/first/wrangler",
      "/second/wrangler",
    ]);
  });

  test("uses PATHEXT when enumerating Windows PATH candidates", () => {
    expect(findWranglerExecutables({
      environment: {
        PATH: "C:\\first;C:\\second",
        PATHEXT: ".CMD;.EXE",
      },
      platform: "win32",
      resolveExecutable: (candidate) => candidate.endsWith("wrangler.CMD")
        ? candidate.toLowerCase()
        : undefined,
    })).toEqual([
      "C:\\first\\wrangler.CMD",
      "C:\\second\\wrangler.CMD",
    ]);
  });
});
