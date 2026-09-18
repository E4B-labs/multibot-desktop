#!/usr/bin/env node
// Official Codex installer with the same verification and Termux fallback as
// MultiBot's Claude Code installer.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const isTermux = process.platform === "android" || Boolean(process.env.TERMUX_VERSION) || /com\.termux\//.test(process.env.PREFIX ?? "");
const prefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
const say = (text) => process.stdout.write(`[codex-install] ${text}\n`);

function run(command, args, options = {}) {
  say(`$ ${[command, ...args].join(" ")}`);
  if (dryRun) return Promise.resolve(0);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, windowsHide: true, ...options });
    child.once("error", (error) => { say(error.message); resolve(1); });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
    env: { ...process.env, PATH: [join(homedir(), ".local", "bin"), process.env.PATH ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":") },
  });
  return { code: result.error ? 1 : result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function verify() {
  if (dryRun) { say("verify: codex --version"); return true; }
  const candidates = [
    process.env.CODEX_BIN,
    isTermux ? join(prefix, "bin", "codex") : null,
    join(homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex"),
    "codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = capture(candidate, ["--version"]);
    if (result.code === 0 && result.output) { say(`verified: ${result.output.split(/\r?\n/, 1)[0]}`); return true; }
  }
  return false;
}

async function installNative() {
  if (process.platform === "win32") {
    return run("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "& ([scriptblock]::Create((irm https://chatgpt.com/codex/install.ps1)))"]);
  }
  return run("bash", ["-lc", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"]);
}

async function installTermux() {
  const proot = join(prefix, "bin", "proot-distro");
  say("Android detected: installing Linux Codex in Debian via proot.");
  let code = await run("pkg", ["install", "-y", "proot", "proot-distro", "python"]);
  if (code !== 0) return code;
  code = await run("pkg", ["reinstall", "-y", "proot-distro"]);
  if (code !== 0 || !existsSync(proot)) return 1;
  if (capture(proot, ["login", "debian", "--", "/bin/true"]).code !== 0) {
    code = await run(proot, ["install", "debian"]);
    if (code !== 0) return code;
  }
  code = await run(proot, ["login", "debian", "--", "bash", "-lc", "export PATH=/root/.local/bin:$PATH; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y bash curl ca-certificates && curl -fsSL https://chatgpt.com/codex/install.sh | sh"]);
  if (code !== 0) return code;
  const wrapper = join(prefix, "bin", "codex");
  writeFileSync(wrapper, `#!${prefix}/bin/sh\nexec ${proot} login debian -- /root/.local/bin/codex "$@"\n`);
  chmodSync(wrapper, 0o755);
  return 0;
}

say(`platform=${process.platform} arch=${process.arch}${dryRun ? " dry-run" : ""}`);
if (!dryRun && verify()) {
  say("Codex already ready.");
} else {
  const code = isTermux ? await installTermux() : await installNative();
  if (code !== 0) process.exitCode = code;
  else if (!verify()) { say("Codex still unavailable after install. No false success reported."); process.exitCode = 1; }
  else say("Codex ready for MultiBot.");
}
