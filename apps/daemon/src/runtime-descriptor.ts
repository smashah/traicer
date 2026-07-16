import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface RuntimeDescriptor {
  readonly controlPort: number;
  readonly gatewayPort: number;
  readonly instanceId: string;
  readonly pid: number;
  readonly protocolVersion: 1 | 2;
  readonly schema: "traicer.runtime/1";
}

export const writeRuntimeDescriptor = async (
  directory: string,
  descriptor: RuntimeDescriptor
): Promise<void> => {
  const destination = resolve(directory, ".runtime.json");
  const temporary = resolve(directory, `.runtime.${descriptor.instanceId}.tmp`);
  await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
};

export const removeRuntimeDescriptor = async (
  directory: string,
  instanceId: string
): Promise<void> => {
  const path = resolve(directory, ".runtime.json");
  try {
    const current = await Bun.file(path).json() as { readonly instanceId?: unknown };
    if (current.instanceId === instanceId) await unlink(path);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
};
