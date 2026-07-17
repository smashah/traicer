export interface DaemonReady {
  readonly controlPort: number;
  readonly gatewayPort: number;
  readonly pid: number;
  readonly protocolVersion: 1 | 2;
  readonly proxyPort?: number;
}

const validPort = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;

export const waitForDaemonReady = async (
  stdout: ReadableStream<Uint8Array>,
  timeoutMs = 30_000
): Promise<DaemonReady> => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Traicer daemon did not become ready in time")), timeoutMs);
  });
  const read = async (): Promise<DaemonReady> => {
    for (;;) {
      const next = await reader.read();
      buffered += decoder.decode(next.value, { stream: !next.done });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (
          value.type === "ready"
          && validPort(value.controlPort)
          && validPort(value.gatewayPort)
          && Number.isInteger(value.pid)
          && Number(value.pid) > 0
          && (value.protocolVersion === 1 || value.protocolVersion === 2)
        ) {
          return {
            controlPort: value.controlPort,
            gatewayPort: value.gatewayPort,
            pid: Number(value.pid),
            protocolVersion: value.protocolVersion,
            ...(validPort(value.proxyPort) ? { proxyPort: value.proxyPort } : {}),
          };
        }
      }
      if (next.done) throw new Error("Traicer daemon exited before reporting readiness");
    }
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
};

export const waitForDaemonStop = async (
  isStopped: () => Promise<boolean>,
  timeoutMs = 10_000,
  pollMs = 100
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await isStopped()) return;
    } catch {
      // A transient read failure is not proof that the process has stopped.
    }
    await Bun.sleep(pollMs);
  }
  throw new Error("Traicer daemon did not stop in time");
};
