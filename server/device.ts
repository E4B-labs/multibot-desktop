// multibot (G3): read-only device scan for onboarding.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, hostname, loadavg, totalmem } from "node:os";

import { augmentedPath, resolveCliSpawn } from "./env-path.ts";

async function version(command: string, args: string[]): Promise<string | null> {
  let cli: ReturnType<typeof resolveCliSpawn>;
  try {
    cli = resolveCliSpawn(command, args);
  } catch {
    return null;
  }
  return new Promise((resolve) =>
    execFile(
      cli.command,
      cli.args,
      {
        timeout: 5_000,
        windowsHide: true,
        windowsVerbatimArguments: cli.windowsVerbatimArguments,
        env: { ...process.env, PATH: augmentedPath() },
      },
      (error, stdout, stderr) => resolve(error ? null : String(stdout || stderr).trim().split(/\r?\n/, 1)[0] || null),
    ),
  );
}

async function firstVersion(candidates: Array<[string, string[]]>): Promise<string | null> {
  for (const [command, args] of candidates) {
    const found = await version(command, args);
    if (found) return found;
  }
  return null;
}

async function property(name: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  return new Promise((resolve) =>
    execFile(
      "getprop",
      [name],
      { timeout: 2_000, windowsHide: true, env: { ...process.env, PATH: augmentedPath() } },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    ),
  );
}

export async function deviceInfo() {
  const [pythonVersion, dockerVersion, manufacturer, model, androidVersion] = await Promise.all([
    firstVersion(process.platform === "win32" ? [["py", ["-3", "--version"]], ["python", ["--version"]]] : [["python3", ["--version"]], ["python", ["--version"]]]),
    version("docker", ["--version"]),
    property("ro.product.manufacturer"),
    property("ro.product.model"),
    property("ro.build.version.release"),
  ]);
  const ramBytes = totalmem();
  const termux = Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"));
  return {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    ramBytes,
    memoryGb: Math.round((ramBytes / 1024 ** 3) * 10) / 10,
    python: Boolean(pythonVersion),
    pythonVersion,
    docker: Boolean(dockerVersion),
    dockerVersion,
    android: Boolean(manufacturer || model || androidVersion),
    termux,
    manufacturer,
    model,
    androidVersion,
  };
}

export function deviceResources() {
  const cpuCount = Math.max(cpus().length, 1);
  let disk: { totalBytes: number; freeBytes: number } | null = null;
  try {
    const stats = statfsSync(process.cwd());
    disk = { totalBytes: Number(stats.blocks) * Number(stats.bsize), freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch {
    // Filesystem statistics are unavailable on a few restricted hosts.
  }
  const temperatures: Array<{ name: string; celsius: number }> = [];
  try {
    for (const entry of readdirSync("/sys/class/thermal")) {
      if (!entry.startsWith("thermal_zone")) continue;
      const raw = Number(readFileSync(`/sys/class/thermal/${entry}/temp`, "utf8").trim());
      if (Number.isFinite(raw)) temperatures.push({ name: entry, celsius: raw / 1000 });
    }
  } catch {
    // Linux thermal files are optional; Windows and containers commonly lack them.
  }
  return {
    ram: { totalBytes: totalmem(), freeBytes: freemem() },
    cpu: { count: cpuCount, load: Math.min(loadavg()[0] / cpuCount, 1) },
    disk,
    temperatures,
  };
}
