// A fake SOCKS5 proxy is ten lines and answers the only question worth asking
// about a hand-written protocol: does it put the right bytes on the wire, and
// does every way of being refused end as a rejected promise instead of a hang.
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { socksConnect } from "./socks5.ts";

const servers: Server[] = [];

/** `reply` decides how the proxy behaves once the CONNECT request arrives. */
function fakeProxy(handler: (socket: Socket, request: Buffer) => void, methodByte = 0x00): Promise<number> {
  const server = createServer((socket) => {
    let greeted = false;
    socket.on("data", (chunk: Buffer) => {
      if (!greeted) {
        greeted = true;
        socket.write(Buffer.from([0x05, methodByte]));
        return;
      }
      handler(socket, chunk);
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** A proxy that accepts, echoes back what the client asked for, then pipes. */
const accepting = (onRequest: (request: Buffer) => void) => fakeProxy((socket, request) => {
  onRequest(request);
  socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x00]));
  socket.write("hello");
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("socksConnect", () => {
  it("sends a DOMAIN request so the name is never resolved here, and keeps bytes that follow the reply", async () => {
    const requests: Buffer[] = [];
    const port = await accepting((value) => void requests.push(value));
    const socket = await socksConnect(port, "abc.onion", 8799, 2_000);
    const request = requests[0];
    expect([...request.subarray(0, 5)]).toEqual([0x05, 0x01, 0x00, 0x03, 9]);
    expect(request.subarray(5, 14).toString()).toBe("abc.onion");
    // 8799 = 0x225f, big-endian, right after the name.
    expect([...request.subarray(14, 16)]).toEqual([0x22, 0x5f]);
    // The socket comes back paused so nothing that arrived glued to the reply
    // can be dropped before the caller is listening; `tls.connect({ socket })`
    // resumes it, a plain reader has to say so.
    const first = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket.resume();
    });
    expect(first).toBe("hello");
    socket.destroy();
  });

  it("rejects when the proxy refuses the no-auth method", async () => {
    const port = await fakeProxy(() => {}, 0xff);
    await expect(socksConnect(port, "abc.onion", 8799, 2_000)).rejects.toThrow(/no-auth/);
  });

  it("rejects on a CONNECT failure byte, naming the reason", async () => {
    const port = await fakeProxy((socket) => socket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
    await expect(socksConnect(port, "abc.onion", 8799, 2_000)).rejects.toThrow(/host unreachable/);
  });

  it("rejects a host that cannot fit the one-byte length, before opening anything", async () => {
    await expect(socksConnect(1, "a".repeat(256), 8799)).rejects.toThrow(/1-255/);
    await expect(socksConnect(1, "", 8799)).rejects.toThrow(/1-255/);
  });

  it("rejects a port the wire format cannot carry", async () => {
    for (const port of [0, 65_536, 1.5, Number.NaN]) {
      await expect(socksConnect(1, "abc.onion", port)).rejects.toThrow(/out of range/);
    }
  });

  it("rejects rather than hangs when the proxy goes away mid-handshake", async () => {
    const port = await fakeProxy((socket) => socket.destroy());
    await expect(socksConnect(port, "abc.onion", 8799, 2_000)).rejects.toThrow(/socks5:/);
  });

  it("rejects when nothing is listening on the proxy port", async () => {
    await expect(socksConnect(1, "abc.onion", 8799, 2_000)).rejects.toThrow(/socks5:/);
  });

  it("gives up inside its timeout when the proxy answers the greeting and then stalls", async () => {
    const started = Date.now();
    const port = await fakeProxy(() => {});
    await expect(socksConnect(port, "abc.onion", 8799, 300)).rejects.toThrow(/in time/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
