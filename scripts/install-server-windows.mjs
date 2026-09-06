// multibot (G6): one-command, per-user Windows server install.
// No elevation: Task Scheduler ONLOGON + LIMITED runs hidden PowerShell.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TASK_NAME = "Multibot Server";
const PORT = 8799;

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function windowsServerPlan(env = process.env, packagedExe) {
  const home = env.USERPROFILE || homedir();
  const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const installDir = join(localAppData, "Multibot Server");
  const tempDir = join(installDir, "tmp");
  const runner = join(installDir, "start-server.ps1");
  const entry = join(ROOT, "dist-server", "index.js");
  const staticDir = join(ROOT, "dist");
  const appCandidates = [
    join(localAppData, "Programs", "MultiBot", "MultiBot.exe"),
    join(localAppData, "Programs", "MultiBot", "MultiBot.exe"), // legacy install
  ];
  const installedApp = packagedExe || appCandidates.find((candidate) => existsSync(candidate)) || appCandidates[0];
  const packagedAction = `"${installedApp}" --server-only`;
  const sourceAction = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runner}"`;
  return {
    root: ROOT,
    installDir,
    tempDir,
    runner,
    entry,
    staticDir,
    packagedExe: installedApp,
    host: "127.0.0.1",
    port: PORT,
    task: {
      command: "schtasks.exe",
      createArgs: ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", TASK_NAME, "/TR", packagedAction],
      sourceCreateArgs: ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", TASK_NAME, "/TR", sourceAction],
      runArgs: ["/Run", "/TN", TASK_NAME],
    },
    publicHttps: "a trusted HTTPS reverse proxy",
  };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, windowsHide: true, ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

async function waitForServer(port, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const body = response.ok ? await response.json() : null;
      if (body?.app === "multibot" && body.static === true) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`server did not become ready on 127.0.0.1:${port}`);
}

function pnpmArgs(args) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error("run through pnpm: pnpm install:server:windows");
  return [process.execPath, [cli, ...args]];
}

function runnerText(plan) {
  const vars = {
    OMB_HOST: plan.host,
    OMB_PORT: String(plan.port),
    OMB_STATIC_DIR: plan.staticDir,
    TMP: plan.tempDir,
    TEMP: plan.tempDir,
  };
  return [
    "$ErrorActionPreference = 'Stop'",
    ...Object.entries(vars).map(([key, value]) => `$env:${key} = ${psQuote(value)}`),
    `Set-Location ${psQuote(plan.root)}`,
    `& ${psQuote(process.execPath)} ${psQuote(plan.entry)}`,
    "",
  ].join("\r\n");
}

async function install() {
  const dryRun = process.argv.includes("--dry-run");
  const json = process.argv.includes("--json");
  const appIndex = process.argv.indexOf("--app");
  const plan = windowsServerPlan(process.env, appIndex >= 0 ? process.argv[appIndex + 1] : undefined);
  if (dryRun) {
    console.log(json ? JSON.stringify(plan) : JSON.stringify(plan, null, 2));
    return;
  }
  if (process.platform !== "win32") throw new Error("Windows installer requires Windows");

  // Clean-machine path: existing NSIS ships Electron/Node, compiled harness,
  // UI and provisioner. No development toolchain is installed system-wide.
  if (existsSync(plan.packagedExe)) {
    await run(plan.task.command, plan.task.createArgs);
    await run(plan.task.command, plan.task.runArgs);
    await waitForServer(plan.port);
    console.log(`\nMultibot server: http://127.0.0.1:${plan.port}`);
    console.log(`Public HTTPS: ${plan.publicHttps}`);
    console.log("Next: open MultiBot, choose Set up server, then share host + server password.");
    return;
  }

  // Source-tree fallback for maintainers; clean users use packaged NSIS above.
  const [pnpm, base] = pnpmArgs([]);
  await run(pnpm, [...base, "install", "--frozen-lockfile"], { cwd: plan.root });
  await run(pnpm, [...base, "build"], { cwd: plan.root });
  await run(pnpm, [...base, "build:server"], { cwd: plan.root });
  if (!existsSync(plan.entry) || !existsSync(join(plan.staticDir, "index.html"))) {
    throw new Error("build did not produce dist-server/index.js and dist/index.html");
  }

  mkdirSync(plan.tempDir, { recursive: true });

  writeFileSync(plan.runner, runnerText(plan));
  try {
    await run(plan.task.command, plan.task.sourceCreateArgs);
    await run(plan.task.command, plan.task.runArgs);
    await waitForServer(plan.port);
  } catch (error) {
    throw new Error(`could not register per-user startup task. Run manually:\n${plan.task.command} ${plan.task.sourceCreateArgs.join(" ")}\n${error}`);
  }

  console.log(`\nMultibot server: http://127.0.0.1:${plan.port}`);
  console.log(`Public HTTPS: ${plan.publicHttps}`);
  console.log("Next: open MultiBot, choose Set up server, then share host + server password.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch((error) => {
    console.error(`[install-server-windows] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
