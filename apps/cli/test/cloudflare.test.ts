import { describe, expect, test } from "bun:test";

import {
  discoverWranglerIdentity,
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
      findWrangler: () => "/usr/local/bin/wrangler",
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

  test("falls back cleanly when Wrangler is unavailable", async () => {
    expect(await discoverWranglerIdentity({
      findWrangler: () => undefined,
      runWrangler: async () => {
        throw new Error("should not run");
      },
    })).toEqual({ status: "unavailable" });
  });

  test("does not expose Wrangler errors when authentication fails", async () => {
    expect(await discoverWranglerIdentity({
      findWrangler: () => "wrangler",
      runWrangler: async () => ({ exitCode: 1, stdout: "sensitive diagnostics" }),
    })).toEqual({ status: "unauthenticated" });
  });
});
