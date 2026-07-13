import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const targets = {
  "darwin-arm64": ["bun-darwin-arm64", "aarch64-apple-darwin", ""],
  "darwin-x64": ["bun-darwin-x64", "x86_64-apple-darwin", ""],
  "linux-arm64": ["bun-linux-arm64", "aarch64-unknown-linux-gnu", ""],
  "linux-x64": ["bun-linux-x64", "x86_64-unknown-linux-gnu", ""],
  "win32-x64": ["bun-windows-x64", "x86_64-pc-windows-msvc", ".exe"],
} as const;

const selected = targets[`${process.platform}-${process.arch}` as keyof typeof targets];
if (!selected) throw new Error(`Unsupported desktop sidecar target: ${process.platform}-${process.arch}`);
const [bunTarget, rustTarget, extension] = selected;
const output = resolve(import.meta.dir, `../src-tauri/binaries/traicer-daemon-${rustTarget}${extension}`);
await mkdir(dirname(output), { recursive: true });
const processResult = Bun.spawn([
  "bun",
  "build",
  resolve(import.meta.dir, "../../daemon/src/index.ts"),
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  `--target=${bunTarget}`,
  `--outfile=${output}`,
], { stderr: "inherit", stdout: "inherit" });
if ((await processResult.exited) !== 0) throw new Error("Daemon sidecar compilation failed");
