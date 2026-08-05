import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createOwnerAccessClient,
  formatTraceList,
  writeTraceExport,
} from "../src/owner-access";

const paths: string[] = [];

const canonical = (traceId: string, input = "owner-visible") => ({
  schema: "traice.otel-genai.trace/1",
  schemaUrl: "https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev",
  semconvCommit: "b694ec35855d8eccfacd5b09e4b72a808b363038",
  span: {
    attributes: {
      "gen_ai.input.messages": [{ parts: [{ content: input, type: "text" }], role: "user" }],
      "gen_ai.operation.name": "chat",
      "gen_ai.output.messages": [{ finish_reason: "stop", parts: [{ content: "safe output", type: "text" }], role: "assistant" }],
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-test",
      "gen_ai.response.model": "gpt-test",
      "gen_ai.usage.input_tokens": 2,
      "gen_ai.usage.output_tokens": 3,
    },
    kind: "CLIENT",
    name: "chat gpt-test",
  },
  traice: {
    capturedAt: "2026-07-17T08:00:00.000Z",
    client: "codex",
    providerResponse: { statusCode: 200 },
    traceId,
  },
});

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => Bun.$`rm -rf ${path}`.quiet()));
});

describe("CLI owner trace access", () => {
  test("lists only bounded lifecycle metadata", async () => {
    const client = createOwnerAccessClient({
      controlBaseUrl: "http://127.0.0.1:43100",
      controlToken: "control-capability",
      fetcher: async (input, init) => {
        expect(String(input)).toBe("http://127.0.0.1:43100/v1/traces?limit=25&offset=50");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer control-capability");
        return Response.json({ traces: [{
          capturedAt: "2026-07-17T08:00:00.000Z",
          state: "committed",
          traceId: "trace-1",
          updatedAt: "2026-07-17T08:00:01.000Z",
        }] });
      },
    });
    const traces = await client.list({ limit: 25, offset: 50 });
    expect(traces).toHaveLength(1);
    expect(formatTraceList(traces)).toContain("trace-1");
    expect(formatTraceList(traces)).not.toContain("ciphertextHash");
  });

  test("parses streamed progress before returning the selected plaintext trace", async () => {
    const events: unknown[] = [];
    const trace = canonical("trace-1");
    const client = createOwnerAccessClient({
      controlBaseUrl: "http://127.0.0.1:43100",
      controlToken: "control-capability",
      fetcher: async () => new Response([
        JSON.stringify({ completedBytes: 50, phase: "download", totalBytes: 100, type: "progress" }),
        JSON.stringify({ source: "storage", trace, type: "trace" }),
        "",
      ].join("\n"), { headers: { "content-type": "application/x-ndjson" } }),
    });
    expect(await client.read("trace-1", (event) => events.push(event))).toEqual({
      source: "storage",
      trace,
    });
    expect(events).toEqual([{ completedBytes: 50, phase: "download", totalBytes: 100 }]);
  });

  test("exports with owner-only permissions and refuses to overwrite by default", async () => {
    const directory = resolve(await realpath(tmpdir()), `traicer-export-${crypto.randomUUID()}`);
    const destination = `${directory}/trace.json`;
    paths.push(directory);
    await writeTraceExport(destination, canonical("trace-1"));
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(destination).json()).toEqual(canonical("trace-1"));
    await expect(writeTraceExport(destination, { replaced: true })).rejects.toThrow("already exists");
    expect(await Bun.file(destination).text()).not.toContain("replaced");
    await writeTraceExport(destination, { replaced: true }, { force: true });
    expect(await Bun.file(destination).json()).toEqual({ replaced: true });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("supports bounded multi-trace JSONL and Markdown and rejects unsafe paths", async () => {
    const directory = resolve(await realpath(tmpdir()), `traicer-export-${crypto.randomUUID()}`);
    paths.push(directory);
    const traces = [
      canonical("trace-1"),
      canonical("trace-2"),
    ];
    const jsonl = `${directory}/traces.jsonl`;
    await writeTraceExport(jsonl, traces, { format: "jsonl" });
    expect((await Bun.file(jsonl).text()).trim().split("\n")).toHaveLength(2);
    expect(await Bun.file(jsonl).text()).toContain("traicer.owner-export-record/1");
    const markdown = `${directory}/traces.md`;
    await writeTraceExport(markdown, traces, { format: "markdown" });
    expect(await Bun.file(markdown).text()).toContain("# Traice 2");

    const fenced = `${directory}/fenced.md`;
    await writeTraceExport(
      fenced,
      canonical("trace-1", "```\n<script>alert(1)</script>"),
      { format: "markdown" }
    );
    const fencedText = await Bun.file(fenced).text();
    expect(fencedText).toContain("````text");
    expect(fencedText).toContain("<script>alert(1)</script>");

    const target = `${directory}/target.json`;
    await Bun.write(target, "safe");
    const linked = `${directory}/linked.json`;
    await symlink(target, linked);
    await expect(writeTraceExport(linked, traces[0], { force: true })).rejects.toThrow("symbolic link");
    await expect(writeTraceExport(`${directory}/../escaped.json`, traces[0])).rejects.toThrow("path traversal");
    expect(await Bun.file(target).text()).toBe("safe");

    const realParent = `${directory}/real-parent`;
    const linkedParent = `${directory}/linked-parent`;
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    await expect(writeTraceExport(`${linkedParent}/trace.json`, traces[0])).rejects.toThrow("symbolic link");
  });

  test("does not change permissions on an existing export directory", async () => {
    const directory = resolve(await realpath(tmpdir()), `traicer-existing-export-${crypto.randomUUID()}`);
    paths.push(directory);
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);
    await writeTraceExport(`${directory}/trace.json`, { traceId: "trace-1" });
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect((await stat(`${directory}/trace.json`)).mode & 0o777).toBe(0o600);
  });

  test("escapes terminal control sequences in human-readable output", () => {
    const trace = {
      capturedAt: "2026-07-17T08:00:00.000Z\u001b[2J",
      client: "codex\u001b]52;c;payload\u0007",
      provider: "openai" as const,
      state: "committed",
      traceId: "trace-1\u001b[31m",
      updatedAt: "2026-07-17T08:00:01.000Z",
    };
    const rendered = formatTraceList([trace]);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).toContain("\\u001b");
  });

  test("reports and explicitly clears only the bounded plaintext cache", async () => {
    const requests: string[] = [];
    const client = createOwnerAccessClient({
      controlBaseUrl: "http://127.0.0.1:43100",
      controlToken: "control-capability",
      fetcher: async (input, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        return init?.method === "DELETE"
          ? Response.json({ cleared: { removed: 3 }, success: true })
          : Response.json({ cache: { bytes: 1024, entries: 3 }, maxAgeDays: 7 });
      },
    });
    expect(await client.cacheStats()).toEqual({ bytes: 1024, entries: 3, maxAgeDays: 7 });
    expect(await client.clearCache()).toEqual({ removed: 3 });
    expect(requests).toEqual([
      "GET http://127.0.0.1:43100/v1/cache/plaintext",
      "DELETE http://127.0.0.1:43100/v1/cache/plaintext",
    ]);
  });
});
