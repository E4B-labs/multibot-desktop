// multibot: offline structural check for G6 install paths; never starts services.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const read = (name) => readFileSync(join(root, name), "utf8");
const must = (condition, message) => { if (!condition) throw new Error(message); };

const dockerfile = read("Dockerfile.selfhost");
const compose = read("docker-compose.selfhost.yml");
const entrypoint = read("scripts/docker-entrypoint.sh");
const start = read("scripts/start-multibot.sh");
const linux = read("scripts/install-linux.sh");
const termux = read("scripts/install-termux.sh");

must(existsSync(join(root, "public", "manifest.webmanifest")), "PWA manifest missing");
must(compose.includes('"127.0.0.1:8799:8799"'), "compose must publish the harness on loopback only");
must(entrypoint.includes("start-multibot.sh"), "docker entrypoint bypasses common launcher");
must(start.includes("dist-server/index.js"), "common launcher missing built harness");
must(dockerfile.includes("pnpm build:server"), "container omits server build");
must(linux.includes("--dry-run") && linux.includes("--self-test"), "linux dry-run/self-test missing");
must(linux.includes('run docker compose -f "$ROOT/docker-compose.selfhost.yml" up -d --build'), "Docker installer only prints command");
must(linux.includes('pnpm --dir "$ROOT" build:server'), "Linux installer omits server build");
must(termux.includes("termux-services") && termux.includes(".termux/boot"), "Termux reboot persistence missing");
must(termux.includes("termux-services/svlogger"), "Termux service logger missing");
must(termux.includes('pnpm --dir "$ROOT" build:server'), "Termux installer omits server build");
must(linux.includes("self-signed certificate") && linux.includes("OMB_TLS=off"), "Linux HTTPS guidance missing");
must(termux.includes("self-signed certificate") && termux.includes("OMB_TLS=off"), "Termux HTTPS guidance missing");
// TLS jest ZAWSZE: harness wystawia sobie certyfikat na pierwszym boocie i
// słucha po HTTPS. Instalacja, która by o tym zapomniała, wypuszcza serwer na
// świat gołym tekstem — stąd sprawdzenie strukturalne, nie tylko dokumentacja.
const indexTs = read("server/index.ts");
must(existsSync(join(root, "server", "tls-cert.ts")), "self-signed certificate module missing");
must(indexTs.includes("createHttpsServer({ key: TLS.keyPem, cert: TLS.certPem }"), "harness does not serve HTTPS");
// Domyślny nasłuch to pętla zwrotna; wyjście do sieci wybiera instalator.
must(indexTs.includes('const HOST = process.env.OMB_HOST?.trim() || "127.0.0.1"'), "harness default bind is no longer loopback");
must(linux.includes("OMB_HOST=0.0.0.0") && termux.includes("OMB_HOST=0.0.0.0"), "installers no longer expose the server on the network");
// Bez TLS-a wolno stać tylko za reverse proxy na loopbacku — i to ma być
// odmowa startu, nie ostrzeżenie ginące w logu.
must(indexTs.includes("if (TLS_OFF && !LOOPBACK_HOST)") && indexTs.includes("process.exit(1)"), "OMB_TLS=off is not restricted to loopback");
console.log("self-host install paths: OK (no services started)");
