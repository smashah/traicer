import type { AnsweredCall, ToolCallView } from "./exchange";

// Labels that can be read straight off a trace, with no model. They cover the
// common agent tools (Claude Code, Codex, OpenCode) by name and fall back to
// inspecting shell commands, so most agent steps never need a classifier call.

export const stepActivities = [
  "explore_read",
  "plan",
  "edit_code",
  "run_tests",
  "run_build_lint_typecheck",
  "run_app_or_script",
  "inspect_runtime",
  "install_deps",
  "version_control",
  "web_or_docs_lookup",
  "ask_user",
  "report_done",
] as const;
export type StepActivity = (typeof stepActivities)[number];

export const lastResults = [
  "success",
  "test_failure",
  "build_or_type_error",
  "runtime_error",
  "command_or_env_error",
  "permission_denied",
  "timeout",
  "empty",
  "not_applicable",
] as const;
export type LastResult = (typeof lastResults)[number];

export const languages = [
  "c",
  "cpp",
  "csharp",
  "dart",
  "elixir",
  "go",
  "java",
  "javascript",
  "kotlin",
  "lua",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "shell",
  "solidity",
  "sql",
  "swift",
  "typescript",
  "zig",
] as const;
export type Language = (typeof languages)[number];

const extensionLanguages: Readonly<Record<string, Language>> = {
  bash: "shell",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  h: "c",
  hpp: "cpp",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  sh: "shell",
  sol: "solidity",
  sql: "sql",
  swift: "swift",
  ts: "typescript",
  tsx: "typescript",
  zig: "zig",
  zsh: "shell",
};

export const languageOfPath = (path: string): Language | undefined => {
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : extensionLanguages[extension];
};

const testPath = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb|exs)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|swift)$/u;
const checkConfigPath = /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[a-z]+|\.oxlintrc[^/]*|oxlint\.json|biome\.jsonc?|tsconfig[^/]*\.json|pyproject\.toml|setup\.cfg|\.flake8|mypy\.ini|ruff\.toml|jest\.config\.[a-z]+|vitest\.config\.[a-z]+|pytest\.ini|\.pre-commit-config\.yaml|clippy\.toml)$|(^|\/)\.github\/workflows\//u;

export const isTestPath = (path: string): boolean => testPath.test(path);
export const isCheckConfigPath = (path: string): boolean => checkConfigPath.test(path);

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};

const patchFile = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\+\+\+ b\/(.+)$/gmu;

const patchText = (call: ToolCallView): string | undefined => {
  if (typeof call.arguments === "string") return call.arguments;
  const args = record(call.arguments);
  for (const key of ["patch", "input", "diff"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return undefined;
};

export const touchedPaths = (call: ToolCallView): readonly string[] => {
  const args = record(call.arguments);
  const paths = ["file_path", "filePath", "path", "notebook_path", "target_file"]
    .flatMap((key) => (typeof args[key] === "string" ? [args[key] as string] : []));
  if (Array.isArray(args.paths)) {
    paths.push(...args.paths.filter((value): value is string => typeof value === "string"));
  }
  const patch = patchText(call);
  if (patch !== undefined) {
    for (const match of patch.matchAll(patchFile)) {
      const path = match[1] ?? match[2];
      if (path) paths.push(path.trim());
    }
  }
  return [...new Set(paths)];
};

export const shellCommand = (call: ToolCallView): string | undefined => {
  const args = record(call.arguments);
  const command = args.command ?? args.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const parts = command as readonly string[];
    // Codex wraps commands as ["bash", "-lc", "<command>"].
    const wrapped = parts.length >= 3 && /^(ba|z)?sh$/u.test(parts[0] ?? "") && parts[1]?.startsWith("-");
    return wrapped ? parts.slice(2).join(" ") : parts.join(" ");
  }
  return undefined;
};

const editTools = /^(edit|multiedit|write|str_replace(_based_edit_tool|_editor)?|apply_patch|create|create_file|notebookedit|replace|insert|edit_file|write_file|patch)$/u;
const readTools = /^(read|view|cat|open|glob|grep|ls|list|list_dir|list_files|find|search|codebase_search|file_search|read_file|grep_search|lsp)$/u;
const shellTools = /^(bash|shell|exec|exec_command|local_shell|run|run_command|terminal|command|execute|run_terminal_cmd|unified_exec)$/u;
const webTools = /^(webfetch|websearch|web_fetch|web_search|fetch|browse)$/u;
const planTools = /^(todowrite|todo_write|todoread|update_plan|plan|think|exitplanmode)$/u;
const askTools = /^(askuserquestion|ask_user|ask_followup_question|request_user_input)$/u;

const testCommand = /\b(vitest|jest|pytest|mocha|ava|playwright test|cypress run|cargo (nextest|test)|go test|bun test|deno test|(npm|pnpm|yarn|bun) (run )?test(:[a-z-]+)?|rspec|phpunit|mix test|dotnet test|(gradle|gradlew|\.\/gradlew) test|mvn test|swift test|xcodebuild test|tox|nox|unittest)\b/u;
const checkCommand = /\b(tsc|eslint|oxlint|biome|prettier --check|ruff|mypy|pyright|flake8|clippy|cargo (build|check)|go (build|vet)|swift build|xcodebuild|(npm|pnpm|yarn|bun) (run )?(build|lint|typecheck|type-check|check-types|check)|make( |$)|gradle build|mvn (compile|package|verify)|vite build|next build|webpack|turbo (run )?(build|lint|typecheck))\b/u;
const installCommand = /\b((npm|pnpm|yarn|bun) (add|install|i|ci)\b|pip3? install|uv (add|pip install|sync)|poetry (add|install)|cargo add|go (get|mod tidy)|brew install|apt(-get)? install|gem install|bundle install|composer (require|install))/u;
const vcsCommand = /^\s*(git|gh|jj|hg)\b/u;
const inspectCommand = /^\s*(curl|wget|http|https|psql|sqlite3|mysql|redis-cli|mongosh|kubectl|docker (logs|ps|inspect)|journalctl|lsof|ps|top|wrangler tail)\b/u;
const readCommand = /^\s*(cat|head|tail|less|ls|find|grep|rg|fd|tree|wc|sed -n|awk|stat|du|pwd|which|file|jq)\b/u;

export const commandActivity = (command: string): StepActivity => {
  if (testCommand.test(command)) return "run_tests";
  if (checkCommand.test(command)) return "run_build_lint_typecheck";
  if (installCommand.test(command)) return "install_deps";
  if (vcsCommand.test(command)) return "version_control";
  if (inspectCommand.test(command)) return "inspect_runtime";
  if (readCommand.test(command)) return "explore_read";
  return "run_app_or_script";
};

export const stepActivity = (call: ToolCallView): StepActivity | undefined => {
  const name = call.name.toLowerCase().replace(/^mcp__.*__/u, "");
  if (editTools.test(name)) return "edit_code";
  if (readTools.test(name)) return "explore_read";
  if (webTools.test(name)) return "web_or_docs_lookup";
  if (planTools.test(name)) return "plan";
  if (askTools.test(name)) return "ask_user";
  if (shellTools.test(name)) {
    const command = shellCommand(call);
    return command === undefined ? undefined : commandActivity(command);
  }
  return undefined;
};

const permissionDenied = /permission denied|operation not permitted|not allowed to|was (rejected|denied|blocked)|user (rejected|denied|declined)|requires approval|sandbox(ed)? (denied|blocked)|EACCES/iu;
const timedOut = /\btimed? ?out\b|\btimeout\b|ETIMEDOUT|deadline exceeded/iu;
const testFailed = /\b[1-9]\d* (failed|failing)\b|\bFAIL(ED)?\b|AssertionError|assert(ion)? (failed|error)|Tests?:\s+[1-9]\d* failed|test result: FAILED|--- FAIL|✗|✕/u;
const testPassed = /\b\d+ (passed|passing)\b|Tests?:\s+\d+ passed|test result: ok|\bPASS\b|\bok\s+\S+\s+[\d.]+s/u;
const buildFailed = /error TS\d+|SyntaxError|TypeError: .* is not|error\[E\d+\]|compilation failed|build failed|failed to compile|\b[1-9]\d* errors?\b|✖ [1-9]\d* problems?|lint(ing)? errors?/iu;
const commandFailed = /command not found|no such file or directory|ENOENT|cannot find module|module not found|ModuleNotFoundError|is not recognized as|unknown (command|option|flag)|missing script/iu;
const toolUseError = /<tool_use_error>|InputValidationError|String to replace not found|File has not been read yet/u;
const runtimeFailed = /Traceback \(most recent call last\)|\bpanic:|Unhandled|uncaught|\bException\b|\bError:|exit code [1-9]\d*|exited with (code )?[1-9]\d*|Exit code [1-9]\d*/u;

export const lastResult = (activity: StepActivity | undefined, response: string): LastResult => {
  const text = response.trim();
  if (text.length === 0) return activity === "edit_code" ? "success" : "empty";
  if (permissionDenied.test(text)) return "permission_denied";
  if (toolUseError.test(text)) return "command_or_env_error";
  if (activity === "run_tests") {
    if (testFailed.test(text)) return "test_failure";
    if (testPassed.test(text)) return "success";
  }
  if (commandFailed.test(text)) return "command_or_env_error";
  if (activity === "run_build_lint_typecheck" && buildFailed.test(text)) return "build_or_type_error";
  if (activity !== "edit_code" && activity !== "explore_read" && buildFailed.test(text) && /error TS\d+|error\[E\d+\]/u.test(text)) {
    return "build_or_type_error";
  }
  if (timedOut.test(text) && activity !== "edit_code" && activity !== "explore_read") return "timeout";
  if (activity !== "explore_read" && activity !== "web_or_docs_lookup" && runtimeFailed.test(text)) {
    return activity === "run_tests" ? "test_failure" : "runtime_error";
  }
  return "success";
};

export interface EditHunk {
  readonly added: readonly string[];
  readonly path: string;
  readonly removed: readonly string[];
}

const lines = (value: unknown): readonly string[] =>
  typeof value === "string" ? value.split("\n") : [];

export const editHunks = (call: ToolCallView): readonly EditHunk[] => {
  const args = record(call.arguments);
  const path = touchedPaths(call)[0];
  if (typeof args.old_string === "string" || typeof args.new_string === "string") {
    return path === undefined ? [] : [{ added: lines(args.new_string), path, removed: lines(args.old_string) }];
  }
  if (Array.isArray(args.edits) && path !== undefined) {
    return args.edits.map((edit) => {
      const value = record(edit);
      return { added: lines(value.new_string), path, removed: lines(value.old_string) };
    });
  }
  if (typeof args.content === "string" && path !== undefined) {
    return [{ added: lines(args.content), path, removed: [] }];
  }
  const patch = patchText(call);
  if (patch === undefined) return [];
  const hunks: EditHunk[] = [];
  let current: { added: string[]; path: string; removed: string[] } | undefined;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\+\+\+ b\/(.+)$/u.exec(line);
    if (header) {
      current = { added: [], path: (header[1] ?? header[2] ?? "").trim(), removed: [] };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return hunks;
};

const suppressionMarker = /@ts-(ignore|nocheck|expect-error)|eslint-disable|oxlint-disable|biome-ignore|#\s*noqa|#\s*type:\s*ignore|#\s*pragma:\s*no cover|\|\|\s*true\b|\bas any\b|#\[allow\(|@SuppressWarnings|\/\/\s*nolint/u;
const skipMarker = /\b(it|test|describe)\.(skip|todo)\(|\bx(it|describe|test)\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]|@Disabled\b|@Ignore\b|\.only\(/u;

export const addsSuppression = (hunk: EditHunk): boolean =>
  hunk.added.some((line) => suppressionMarker.test(line))
  && !hunk.removed.some((line) => suppressionMarker.test(line));

export const addsSkip = (hunk: EditHunk): boolean =>
  hunk.added.some((line) => skipMarker.test(line))
  && !hunk.removed.some((line) => skipMarker.test(line));

export const unifiedDiff = (hunk: EditHunk, maxLines = 60): string => {
  const body = [...hunk.removed.map((line) => `-${line}`), ...hunk.added.map((line) => `+${line}`)];
  const clipped = body.length > maxLines
    ? [...body.slice(0, maxLines / 2), "…", ...body.slice(-maxLines / 2)]
    : body;
  return [`--- a/${hunk.path}`, `+++ b/${hunk.path}`, ...clipped].join("\n");
};

export const normaliseCommand = (command: string): string =>
  command
    .replace(/^\s*(cd [^&;]+(&&|;)\s*)+/u, "")
    .replace(/\b[A-Z_][A-Z0-9_]*=\S+\s+/gu, "")
    .replace(/\s--(watch|reporter(=\S+)?|color|no-color|silent|verbose|run)\b(\s+(?!-)\S+)?/gu, " ")
    .replace(/\s*(2>&1|\|\s*(tail|head|tee|grep)\b.*)$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

export const claimsTestsPass = (text: string): boolean =>
  /\b(tests?|specs?|suite)\b[^.\n]{0,40}\b(pass|passes|passed|passing|green)\b|\ball \d+ (tests|specs)\b/iu.test(text);

export interface StepView {
  readonly activity: StepActivity | undefined;
  readonly call: AnsweredCall;
  readonly result: LastResult;
}

export const stepsOf = (calls: readonly AnsweredCall[]): readonly StepView[] =>
  calls.map((call) => {
    const activity = stepActivity(call);
    return { activity, call, result: lastResult(activity, call.response) };
  });
