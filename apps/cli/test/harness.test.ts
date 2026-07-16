import { describe, expect, test } from "bun:test";

import { createHarnessLaunch } from "../src/harness";

const urls = { anthropic: "http://127.0.0.1:4567/anthropic/token", openai: "http://127.0.0.1:4567/openai/token/v1" };

describe("harness launch configuration", () => {
  test("uses Claude's Anthropic base URL environment variable", () => {
    const launch = createHarnessLaunch(["claude", "--model", "sonnet"], urls, { TRAICER_CONTROL_TOKEN: "secret", HOME: "/home" });
    expect(launch.environment).toEqual({ ANTHROPIC_BASE_URL: urls.anthropic, HOME: "/home" });
    expect(launch.providers).toEqual(["anthropic"]);
  });

  test("injects Codex's openai_base_url config without a shell", () => {
    expect(createHarnessLaunch(["codex", "exec", "test"], urls, {}).args).toEqual([
      "codex", "-c", `openai_base_url=${JSON.stringify(urls.openai)}`, "exec", "test",
    ]);
  });

  test("sets both OpenCode provider URLs in inline config", () => {
    const launch = createHarnessLaunch(["opencode"], urls, {
      OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{"options":{"apiKey":"existing"}}},"theme":"dark"}',
    });
    expect(JSON.parse(launch.environment.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      provider: { anthropic: { options: { baseURL: urls.anthropic } }, openai: { options: { baseURL: urls.openai } } },
      theme: "dark",
    });
    expect(JSON.parse(launch.environment.OPENCODE_CONFIG_CONTENT!).provider.openai.options.apiKey).toBe("existing");
  });
});
