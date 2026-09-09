// Regresja, która kosztowała botom wszystkie narzędzia: proxy trzymało JEDNO
// gniazdo otwarte przy starcie procesu, a broker żyje przez jedną turę. Po
// pierwszej turze połączenie było martwe na zawsze i każda kolejna zgoda
// kończyła się odmową „permission broker unavailable" — bot tracił Bash, Write
// i write_file do końca życia procesu CLI.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "permission-proxy.ts");

let child: ChildProcess | null = null;
let server: Server | null = null;
let home: string | null = null;
const brokerConnections = new WeakMap<Server, Set<Socket>>();

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  await closeBroker(server);
  server = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

/** Broker-atrapa: odpowiada „allow" na każde pytanie, jak człowiek klikający Allow. */
function broker(socketPath: string): Promise<Server> {
  // macOS can leave the pathname of a closed Unix socket behind briefly, or
  // have the proxy's failed reconnect overlap the next bind. Retry only these
  // transient bind failures so the test still exercises the same stable path.
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const listen = () => {
      try { unlinkSync(socketPath); } catch { /* no socket on the first bind */ }
      let s: Server;
      s = createServer((conn: Socket) => {
        brokerConnections.get(s)!.add(conn);
        conn.once("close", () => brokerConnections.get(s)?.delete(conn));
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const ask = JSON.parse(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            conn.write(JSON.stringify({ t: "answer", id: ask.id, behavior: "allow" }) + "\n");
          }
        });
      });
      brokerConnections.set(s, new Set());
      const retry = (error: NodeJS.ErrnoException) => {
        s.removeListener("error", retry);
        s.close(() => {
          if ((error.code === "EACCES" || error.code === "EADDRINUSE") && attempts++ < 20) {
            setTimeout(listen, 25);
          } else {
            reject(error);
          }
        });
      };
      s.once("error", retry);
      s.listen(socketPath, () => {
        s.removeListener("error", retry);
        resolve(s);
      });
    };
    listen();
  });
}

async function closeBroker(value: Server | null): Promise<void> {
  if (!value) return;
  for (const conn of brokerConnections.get(value) ?? []) conn.destroy();
  await new Promise<void>((resolve) => value.close(() => resolve()));
}

/** Jedno `tools/call` do proxy; zwraca tekst wyniku. */
function approve(proc: ChildProcess, id: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === id) {
          proc.stdout!.off("data", onData);
          return resolve(msg.result?.content?.[0]?.text ?? "");
        }
      }
    };
    proc.stdout!.on("data", onData);
    setTimeout(() => reject(new Error("proxy nie odpowiedziało")), 10_000).unref?.();
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } },
      }) + "\n",
    );
  });
}

// Tylko POSIX. Nazwane potoki Windows mają inny cykl życia: nazwa nie zwalnia
// się natychmiast po `close()`, więc drugi broker na tej samej nazwie nie
// wstaje i test mierzyłby zachowanie Windows, nie naprawiany błąd. Produkcja
// stoi na Termuksie, a CI ma runner ubuntu — tam ten test się wykonuje.
const posix = process.platform !== "win32";

describe.skipIf(!posix)("permission-proxy", () => {
  it("reconnects after the broker of a finished turn goes away", async () => {
    home = mkdtempSync(join(tmpdir(), "multibot-proxy-"));
    const socketPath = join(home, "perm-test.sock");

    server = await broker(socketPath);
    child = spawn(process.execPath, [PROXY, socketPath], { stdio: ["pipe", "pipe", "pipe"] });

    // tura 1: zgoda przechodzi
    expect(await approve(child, 1)).toContain('"behavior":"allow"');

    // koniec tury — harness zamyka brokera, proces proxy zostaje przy życiu
    await closeBroker(server);
    await new Promise((r) => setTimeout(r, 100));

    // tura 2: nowy broker na tej samej ścieżce (ścieżka jest stała dla wątku)
    server = await broker(socketPath);
    expect(await approve(child, 2)).toContain('"behavior":"allow"');
  }, 30_000);

  it("denies instead of hanging when no broker is listening at all", async () => {
    home = mkdtempSync(join(tmpdir(), "multibot-proxy-"));
    child = spawn(process.execPath, [PROXY, join(home, "nie-ma.sock")], { stdio: ["pipe", "pipe", "pipe"] });
    expect(await approve(child, 1)).toContain("broker unavailable");
  }, 30_000);
});
