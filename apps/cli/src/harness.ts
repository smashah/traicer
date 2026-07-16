import { basename } from "node:path";

type CaptureClient = "claude-code" | "codex" | "opencode";

export interface HarnessLaunch {
  readonly args: readonly string[];
  readonly client: CaptureClient;
  readonly environment: Readonly<Record<string, string>>;
  readonly providers: readonly ("anthropic" | "openai")[];
}

const cleanEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter(
    (entry): entry is [string, string] => entry[1] !== undefined &&
      entry[0] !== "__VARLOCK_ENV" && !entry[0].startsWith("TRAICER_")
  ));

const tomlString = (value: string): string => JSON.stringify(value);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const createHarnessLaunch = (
  command: readonly string[],
  providerBaseUrls: { readonly anthropic: string; readonly openai: string },
  environment: NodeJS.ProcessEnv = process.env
): HarnessLaunch => {
  const executable = command[0];
  if (!executable) throw new Error("Pass a harness command after `traicer run --`");
  const name = basename(executable).toLowerCase();
  const clean = cleanEnvironment(environment);
  if (name === "claude") return {
    args: command,
    client: "claude-code",
    environment: { ...clean, ANTHROPIC_BASE_URL: providerBaseUrls.anthropic },
    providers: ["anthropic"],
  };
  if (name === "codex") return {
    args: [executable, "-c", `openai_base_url=${tomlString(providerBaseUrls.openai)}`, ...command.slice(1)],
    client: "codex",
    environment: clean,
    providers: ["openai"],
  };
  if (name === "opencode") {
    let existing: Record<string, unknown> = {};
    if (environment.OPENCODE_CONFIG_CONTENT) {
      try { existing = JSON.parse(environment.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>; }
      catch { throw new Error("OPENCODE_CONFIG_CONTENT must contain valid JSON"); }
    }
    const provider = record(existing.provider);
    const anthropic = record(provider.anthropic);
    const openai = record(provider.openai);
    return {
      args: command,
      client: "opencode",
      environment: {
        ...clean,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...existing,
          provider: {
            ...provider,
            anthropic: {
              ...anthropic,
              options: { ...record(anthropic.options), baseURL: providerBaseUrls.anthropic },
            },
            openai: {
              ...openai,
              options: { ...record(openai.options), baseURL: providerBaseUrls.openai },
            },
          },
        }),
      },
      providers: ["anthropic", "openai"],
    };
  }
  throw new Error("Supported harnesses are `claude`, `codex`, and `opencode`");
};
