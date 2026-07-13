import { describe, expect, test } from "bun:test";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectHttp2 } from "node:http2";
import { connect as connectTls } from "node:tls";
import { generate } from "selfsigned";

import { startForwardProxy } from "../src/forward-proxy";

const connected = (port: number): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = connectTcp(port, "127.0.0.1", () => resolve(socket));
  socket.once("error", reject);
});

const connectTunnel = async (socket: Socket, token: string) => {
  const auth = btoa(`traicer:${token}`);
  socket.write(`CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  await new Promise<void>((resolve, reject) => {
    let received = new Uint8Array();
    const onData = (chunk: Uint8Array) => {
      const next = new Uint8Array(received.byteLength + chunk.byteLength);
      next.set(received);
      next.set(chunk, received.byteLength);
      received = next;
      const marker = new TextDecoder().decode(received).indexOf("\r\n\r\n");
      if (marker < 0) return;
      socket.off("data", onData);
      const remainder = received.slice(marker + 4);
      if (remainder.byteLength > 0) socket.unshift(remainder);
      expect(new TextDecoder().decode(received.slice(0, marker))).toContain("200 Connection Established");
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
};

describe("authenticated selective forward proxy", () => {
  test("terminates selected TLS for HTTP/1.1 and HTTP/2 and routes only allowlisted paths into capture", async () => {
    const pems = await generate([{ name: "commonName", value: "api.openai.com" }], {
      extensions: [{
        altNames: [{ type: 2, value: "api.openai.com" }],
        name: "subjectAltName",
      }],
    });
    const token = "proxy-capability-000000000000";
    const captured: string[] = [];
    const proxy = await startForwardProxy({
      allowedPaths: ["/v1/responses"],
      certificatePem: pems.cert,
      gatewayFetch: (request) => {
        captured.push(new URL(request.url).pathname);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
      privateKeyPem: pems.private,
      targetHosts: ["api.openai.com"],
      token,
    });
    try {
      const raw = await connected(proxy.port);
      await connectTunnel(raw, token);
      const tls = connectTls({
        ALPNProtocols: ["http/1.1"],
        rejectUnauthorized: false,
        servername: "api.openai.com",
        socket: raw,
      });
      await new Promise<void>((resolve, reject) => {
        tls.once("secureConnect", resolve);
        tls.once("error", reject);
      });
      tls.write("POST /v1/responses HTTP/1.1\r\nHost: api.openai.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
      const response = await new Promise<string>((resolve, reject) => {
        let body = "";
        tls.on("data", (chunk: Uint8Array) => {
          body += chunk.toString();
          if (body.includes('{"ok":true}')) resolve(body);
        });
        tls.once("error", reject);
      });
      expect(captured).toEqual([`/openai/${token}/v1/responses`]);
      expect(response).toContain("200 OK");
      expect(response).toContain('{"ok":true}');
      tls.destroy();

      const rawHttp2 = await connected(proxy.port);
      await connectTunnel(rawHttp2, token);
      const tlsHttp2 = connectTls({
        ALPNProtocols: ["h2"],
        rejectUnauthorized: false,
        servername: "api.openai.com",
        socket: rawHttp2,
      });
      await new Promise<void>((resolve, reject) => {
        tlsHttp2.once("secureConnect", resolve);
        tlsHttp2.once("error", reject);
      });
      expect(tlsHttp2.alpnProtocol).toBe("h2");
      const session = connectHttp2("https://api.openai.com", {
        createConnection: () => tlsHttp2,
      });
      const stream = session.request({
        ":method": "POST",
        ":path": "/v1/responses",
        "content-type": "application/json",
      });
      stream.end("{}");
      const http2Body = await new Promise<string>((resolve, reject) => {
        let body = "";
        stream.on("data", (chunk: Uint8Array) => body += new TextDecoder().decode(chunk));
        stream.once("end", () => resolve(body));
        stream.once("error", reject);
      });
      expect(http2Body).toBe('{"ok":true}');
      session.close();
      expect(captured).toEqual([
        `/openai/${token}/v1/responses`,
        `/openai/${token}/v1/responses`,
      ]);
    } finally {
      await proxy.close();
    }
  });

  test("rejects clients without the loopback proxy capability", async () => {
    const pems = await generate();
    const proxy = await startForwardProxy({
      allowedPaths: [],
      certificatePem: pems.cert,
      gatewayFetch: () => new Response(),
      privateKeyPem: pems.private,
      targetHosts: ["api.openai.com"],
      token: "proxy-capability-000000000000",
    });
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/`);
      expect(response.status).toBe(407);
      const socket = await connected(proxy.port);
      const auth = btoa("traicer:proxy-capability-000000000000");
      socket.write(`CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      const tunnelResponse = await new Promise<string>((resolve, reject) => {
        socket.once("data", (chunk) => resolve(chunk.toString()));
        socket.once("error", reject);
      });
      expect(tunnelResponse).toContain("403 Forbidden");
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });
});
