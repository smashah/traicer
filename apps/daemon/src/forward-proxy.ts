import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";

import { constantTimeEqual } from "@traice/crypto";

const blockedHeaders = new Set([
  "connection", "host", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

interface ProxyRequest extends AsyncIterable<unknown> {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
}

interface ProxyResponse {
  statusCode: number;
  end(): unknown;
  end(body: string | Uint8Array): unknown;
  setHeader: (name: string, value: string) => unknown;
}

const publicIpv4 = (host: string) => {
  const parts = host.split(".").map(Number);
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;
  return !(first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && [0, 2, 168].includes(second)) ||
    (first === 198 && [18, 19, 51].includes(second)) ||
    (first === 203 && second === 0));
};

const publicIp = (host: string) => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return publicIpv4(normalized);
  if (isIP(normalized) === 6) {
    return !/^(?:::|::1$|f[cd]|fe[89ab]|ff|2001:db8:|::ffff:(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.)/i.test(normalized);
  }
  return false;
};

const safeTunnelHost = (host: string) => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "localhost.localdomain"].includes(normalized)) return false;
  if (isIP(normalized)) return publicIp(normalized);
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized) && !normalized.endsWith(".local");
};

const resolvePublicHost = async (host: string) => {
  if (!safeTunnelHost(host)) throw new Error("Private or loopback proxy targets are denied");
  if (isIP(host)) return { address: host, family: isIP(host) } as const;
  const addresses = await lookup(host, { all: true, verbatim: true });
  const selected = addresses.find((address) => publicIp(address.address));
  if (!selected || addresses.some((address) => !publicIp(address.address))) {
    throw new Error("Proxy DNS resolved to a private or mixed-address target");
  }
  return selected;
};

const requestHeaders = (request: ProxyRequest): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (blockedHeaders.has(name) || value === undefined || name.startsWith(":")) continue;
    if (typeof value === "string") headers.set(name, value);
    else value.forEach((item) => headers.append(name, item));
  }
  return headers;
};

const readBody = async (request: ProxyRequest): Promise<Uint8Array | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string"
      ? new TextEncoder().encode(chunk)
      : chunk instanceof Uint8Array
        ? Uint8Array.from(chunk)
        : new Uint8Array(chunk as ArrayBuffer);
    length += bytes.byteLength;
    if (length > 64 * 1024 * 1024) throw new Error("Proxy request exceeds the 64 MiB transport limit");
    chunks.push(bytes);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const writeResponse = async (target: ProxyResponse, response: Response) => {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (!blockedHeaders.has(name.toLowerCase())) target.setHeader(name, value);
  });
  target.end(new Uint8Array(await response.arrayBuffer()));
};

const requestBody = (body: Uint8Array | undefined) => body
  ? { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer }
  : {};

const readU16 = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

export const clientHelloOffersHttp2 = (records: Uint8Array): boolean | undefined => {
  const handshakeParts: Uint8Array[] = [];
  let offset = 0;
  let handshakeLength: number | undefined;
  while (offset + 5 <= records.byteLength) {
    const recordLength = readU16(records, offset + 3);
    if (offset + 5 + recordLength > records.byteLength) return undefined;
    if (records[offset] !== 22) return false;
    handshakeParts.push(records.slice(offset + 5, offset + 5 + recordLength));
    const available = handshakeParts.reduce((total, part) => total + part.byteLength, 0);
    if (available >= 4 && handshakeLength === undefined) {
      const header = new Uint8Array(4);
      let headerOffset = 0;
      for (const part of handshakeParts) {
        const slice = part.slice(0, Math.min(part.byteLength, 4 - headerOffset));
        header.set(slice, headerOffset);
        headerOffset += slice.byteLength;
        if (headerOffset === 4) break;
      }
      if (header[0] !== 1) return false;
      handshakeLength = ((header[1] ?? 0) << 16) | ((header[2] ?? 0) << 8) | (header[3] ?? 0);
    }
    if (handshakeLength !== undefined && available >= handshakeLength + 4) break;
    offset += 5 + recordLength;
  }
  if (handshakeLength === undefined) return undefined;
  const handshake = new Uint8Array(handshakeParts.reduce((total, part) => total + part.byteLength, 0));
  let writeOffset = 0;
  for (const part of handshakeParts) {
    handshake.set(part, writeOffset);
    writeOffset += part.byteLength;
  }
  if (handshake.byteLength < handshakeLength + 4) return undefined;
  let cursor = 4 + 2 + 32;
  const sessionLength = handshake[cursor] ?? 0;
  cursor += 1 + sessionLength;
  if (cursor + 2 > handshake.byteLength) return false;
  cursor += 2 + readU16(handshake, cursor);
  const compressionLength = handshake[cursor] ?? 0;
  cursor += 1 + compressionLength;
  if (cursor + 2 > handshake.byteLength) return false;
  const extensionsEnd = Math.min(handshake.byteLength, cursor + 2 + readU16(handshake, cursor));
  cursor += 2;
  while (cursor + 4 <= extensionsEnd) {
    const extensionType = readU16(handshake, cursor);
    const extensionLength = readU16(handshake, cursor + 2);
    const extensionEnd = cursor + 4 + extensionLength;
    if (extensionEnd > extensionsEnd) return false;
    if (extensionType === 16 && extensionLength >= 3) {
      let protocolOffset = cursor + 6;
      const protocolEnd = Math.min(extensionEnd, protocolOffset + readU16(handshake, cursor + 4));
      while (protocolOffset < protocolEnd) {
        const protocolLength = handshake[protocolOffset] ?? 0;
        protocolOffset += 1;
        const protocol = new TextDecoder().decode(handshake.slice(protocolOffset, protocolOffset + protocolLength));
        if (protocol === "h2") return true;
        protocolOffset += protocolLength;
      }
      return false;
    }
    cursor = extensionEnd;
  }
  return false;
};

export interface ForwardProxyOptions {
  readonly allowedPaths: readonly string[];
  readonly certificatePem: string;
  readonly gatewayFetch: (request: Request) => Response | Promise<Response>;
  readonly privateKeyPem: string;
  readonly targetHosts: readonly string[];
  readonly token: string;
  readonly onPinningFailure?: () => void;
}

export const startForwardProxy = async (options: ForwardProxyOptions) => {
  const targets = new Set(options.targetHosts.map((host) => host.toLowerCase()));
  const authorised = (header: string | undefined) => {
    if (!header) return false;
    const basic = `Basic ${btoa(`traicer:${options.token}`)}`;
    return constantTimeEqual(header, basic) || constantTimeEqual(header, `Bearer ${options.token}`);
  };

  const handleHttp = async (request: ProxyRequest, response: ProxyResponse) => {
    try {
      const method = request.method ?? "GET";
      const authority = String(request.headers[":authority"] ?? request.headers.host ?? "");
      const host = authority.replace(/:\d+$/, "").toLowerCase();
      if (!targets.has(host)) {
        const absolute = new URL(request.url ?? "/");
        await resolvePublicHost(absolute.hostname);
        const upstream = await fetch(absolute, {
          ...requestBody(await readBody(request)),
          headers: requestHeaders(request),
          method,
          redirect: "manual",
        });
        await writeResponse(response, upstream);
        return;
      }
      const path = request.url?.startsWith("http") ? new URL(request.url).pathname : request.url ?? "/";
      const body = await readBody(request);
      const upstreamRequest = options.allowedPaths.includes(path.split("?")[0] ?? path)
        ? new Request(`http://127.0.0.1/${host.includes("anthropic") ? "anthropic" : "openai"}/${options.token}${path}`, {
            ...requestBody(body),
            headers: requestHeaders(request),
            method,
          })
        : new Request(`https://${host}${path}`, {
            ...requestBody(body),
            headers: requestHeaders(request),
            method,
            redirect: "manual",
          });
      const upstream = options.allowedPaths.includes(path.split("?")[0] ?? path)
        ? await options.gatewayFetch(upstreamRequest)
        : await fetch(upstreamRequest);
      await writeResponse(response, upstream);
    } catch {
      response.statusCode = 502;
      response.end("Traicer proxy transport failed safely");
    }
  };

  const intercepted = Bun.serve({
    error: () => {
      options.onPinningFailure?.();
      return new Response("Traicer selected-host transport failed safely", { status: 502 });
    },
    fetch: async (request) => {
      const host = (request.headers.get("host") ?? new URL(request.url).hostname).replace(/:\d+$/, "").toLowerCase();
      if (!targets.has(host)) return new Response("Selected provider host required", { status: 421 });
      const incomingUrl = new URL(request.url);
      const path = `${incomingUrl.pathname}${incomingUrl.search}`;
      const headers = new Headers(request.headers);
      for (const name of blockedHeaders) headers.delete(name);
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
      const allowed = options.allowedPaths.includes(incomingUrl.pathname);
      const target = allowed
        ? `http://127.0.0.1/${host.includes("anthropic") ? "anthropic" : "openai"}/${options.token}${path}`
        : `https://${host}${path}`;
      const forwarded = new Request(target, {
        ...requestBody(body),
        headers,
        method: request.method,
        redirect: "manual",
      });
      return allowed ? options.gatewayFetch(forwarded) : fetch(forwarded);
    },
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      cert: options.certificatePem,
      key: options.privateKeyPem,
    },
  });
  const interceptedPort = intercepted.port;
  if (!interceptedPort) throw new Error("Selected-host TLS transport did not bind a TCP port");
  const interceptedHttp2 = createSecureServer({
    cert: options.certificatePem,
    key: options.privateKeyPem,
  }, (request, response) => void handleHttp(request, response));
  await new Promise<void>((resolve, reject) => {
    interceptedHttp2.once("error", reject);
    interceptedHttp2.listen(0, "127.0.0.1", () => resolve());
  });
  const http2Address = interceptedHttp2.address();
  if (!http2Address || typeof http2Address === "string") {
    throw new Error("Selected-host HTTP/2 transport did not bind a TCP port");
  }

  const proxy = createServer((request, response) => {
    if (!authorised(request.headers["proxy-authorization"])) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="Traicer loopback proxy"' });
      response.end();
      return;
    }
    void handleHttp(request, response);
  });
  proxy.on("connect", (request, client: Socket, head) => {
    if (!authorised(request.headers["proxy-authorization"])) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Traicer loopback proxy"\r\n\r\n');
      return;
    }
    const authority = request.url ?? "";
    const match = /^\[?([^\]]+?)\]?:([0-9]{1,5})$/.exec(authority);
    if (!match) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = match[1]?.toLowerCase() ?? "";
    const port = Number(match[2]);
    if (!safeTunnelHost(host) || port < 1 || port > 65_535) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (targets.has(host) && port === 443) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let hello = head.byteLength > 0 ? Uint8Array.from(head) : new Uint8Array();
      const routeHello = (chunk: Uint8Array) => {
        const next = new Uint8Array(hello.byteLength + chunk.byteLength);
        next.set(hello);
        next.set(chunk, hello.byteLength);
        hello = next;
        if (hello.byteLength > 65_536) {
          client.destroy();
          return;
        }
        const http2 = clientHelloOffersHttp2(hello);
        if (http2 === undefined) return;
        client.off("data", routeHello);
        const selected = connect(http2 ? http2Address.port : interceptedPort, "127.0.0.1", () => {
          selected.write(hello);
          selected.pipe(client);
          client.pipe(selected);
        });
        selected.once("error", () => client.destroy());
        client.once("error", () => selected.destroy());
      };
      client.on("data", routeHello);
      if (hello.byteLength > 0) routeHello(new Uint8Array());
      return;
    }
    void resolvePublicHost(host).then((address) => {
      const remote = connect({ host: address.address, family: address.family, port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.byteLength > 0) remote.write(Uint8Array.from(head));
        remote.pipe(client);
        client.pipe(remote);
      });
      remote.once("error", () => client.destroy());
      client.once("error", () => remote.destroy());
    }).catch(() => client.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Forward proxy did not bind a TCP port");
  return {
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => interceptedHttp2.close(() => resolve())),
        intercepted.stop(true).then(() => undefined),
      ]);
    },
    port: address.port,
  };
};
