#!/usr/bin/env node
// multibot: install Claude Code using Anthropic's native installer. Termux is
// Android, not a supported npm target, so run the Linux ARM64 build in Debian
// through proot-distro and expose one stable `claude` wrapper to the harness.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const isTermux = process.platform === "android" || Boolean(process.env.TERMUX_VERSION) || /com\.termux\//.test(process.env.PREFIX ?? "");
const prefix = process.env.PREFIX || "/data/data/com.termux/files/usr";

const say = (text) => process.stdout.write(`[claude-install] ${text}\n`);
const commandText = (command, args) => [command, ...args].join(" ");

function run(command, args, options = {}) {
  const line = commandText(command, args);
  say(`$ ${line}`);
  if (dryRun) return Promise.resolve(0);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, windowsHide: true, ...options });
    child.once("error", (error) => {
      say(`${line}: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    ...options,
  });
  return {
    code: result.error ? 1 : result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function claudeCandidates() {
  const home = homedir();
  return [
    process.env.CLAUDE_CODE_BIN,
    isTermux ? join(prefix, "bin", "claude") : null,
    join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
    join(home, ".claude", "local", process.platform === "win32" ? "claude.exe" : "claude"),
    "claude",
  ].filter(Boolean);
}

function verify() {
  if (dryRun) {
    say("verify: claude --version");
    return true;
  }
  for (const candidate of claudeCandidates()) {
    const result = capture(candidate, ["--version"], {
      env: { ...process.env, PATH: [join(homedir(), ".local", "bin"), process.env.PATH ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":") },
    });
    if (result.code === 0 && result.output) {
      say(`verified: ${result.output.split(/\r?\n/, 1)[0]}`);
      return true;
    }
  }
  return false;
}

async function installNative() {
  if (process.platform === "win32") {
    return run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "& ([scriptblock]::Create((irm https://claude.ai/install.ps1)))",
    ]);
  }
  return run("bash", ["-lc", "curl -fsSL https://claude.ai/install.sh | bash"]);
}

async function installTermux() {
  const proot = join(prefix, "bin", "proot-distro");
  say("Android detected: npm package has no Android native binary; using Debian ARM64 via proot.");
  let code = await run("pkg", ["install", "-y", "proot", "proot-distro", "python"]);
  if (code !== 0) return code;
  // Termux upgrades can leave proot-distro's Python shebang one version behind.
  code = await run("pkg", ["reinstall", "-y", "proot-distro"]);
  if (code !== 0) return code;
  if (!existsSync(proot)) {
    say(`missing ${proot} after package install`);
    return 1;
  }
  const present = capture(proot, ["login", "debian", "--", "/bin/true"]);
  if (present.code !== 0) {
    code = await run(proot, ["install", "debian"]);
    if (code !== 0) return code;
  }
  code = await run(proot, [
    "login", "debian", "--", "bash", "-lc",
    "export PATH=/root/.local/bin:$PATH; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y bash curl ca-certificates && curl -fsSL https://claude.ai/install.sh | bash",
  ]);
  if (code !== 0) return code;

  const wrapper = join(prefix, "bin", "claude");
  if (existsSync(wrapper) && statSync(wrapper).size < 4096) {
    const backup = `${wrapper}.npm-wrapper`;
    if (!existsSync(backup)) copyFileSync(wrapper, backup);
  }
  writeFileSync(wrapper, `#!${prefix}/bin/sh\nexec ${proot} login debian -- /root/.local/bin/claude "$@"\n`);
  chmodSync(wrapper, 0o755);
  return 0;
}

async function main() {
  say(`platform=${process.platform} arch=${process.arch}${dryRun ? " dry-run" : ""}`);
  if (!dryRun && verify()) {
    say("Claude Code already ready.");
    return;
  }
  const code = isTermux ? await installTermux() : await installNative();
  if (code !== 0) {
    say(`installer exited with code ${code}`);
    process.exitCode = code;
    return;
  }
  if (!verify()) {
    say("Claude Code still unavailable after install. Check output above; no false success reported.");
    process.exitCode = 1;
    return;
  }
  say("Claude Code ready for Multibot.");
}

await main();
