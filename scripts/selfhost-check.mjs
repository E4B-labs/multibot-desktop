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
must(linux.includes("trusted reverse proxy in front of port 8799"), "Linux HTTPS guidance missing");
must(termux.includes("trusted reverse proxy in front of port 8799"), "Termux HTTPS guidance missing");
console.log("self-host install paths: OK (no services started)");
