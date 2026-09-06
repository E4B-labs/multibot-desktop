import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows one-command server installer", () => {
  it("dry-run plans loopback + per-user ONLOGON without writing or elevation", () => {
    const home = "D:\\tmp\\g6-windows-home";
    const localAppData = "D:\\tmp\\g6-windows-localappdata";
    rmSync(home, { recursive: true, force: true });
    rmSync(localAppData, { recursive: true, force: true });
    const packagedExe = join(localAppData, "Programs", "MultiBot", "MultiBot.exe");
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "install-server-windows.mjs"), "--dry-run", "--json", "--app", packagedExe], {
      encoding: "utf8",
      env: { ...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: localAppData, TMP: "D:\\tmp", TEMP: "D:\\tmp" },
    });

    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({
      host: "127.0.0.1",
      port: 8799,
      installDir: join(localAppData, "Multibot Server"),
      packagedExe,
      task: { command: "schtasks.exe" },
      publicHttps: "a trusted HTTPS reverse proxy",
    });
    expect(plan.task.createArgs).toEqual(expect.arrayContaining(["/SC", "ONLOGON", "/RL", "LIMITED"]));
    expect(plan.task.createArgs.join(" ")).not.toMatch(/HIGHEST|\/RU\s+SYSTEM/i);
    expect(plan.task.createArgs.at(-1)).toBe(`"${packagedExe}" --server-only`);
    expect(plan.task.sourceCreateArgs.at(-1)).toContain("-WindowStyle Hidden");
    expect(plan.tempDir.startsWith("D:\\tmp\\")).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(localAppData)).toBe(false);
  });

  it("packages a no-window server mode with loopback harness resources", () => {
    const main = readFileSync(join(process.cwd(), "electron", "main.mjs"), "utf8");
    const auth = readFileSync(join(process.cwd(), "src", "lib", "auth.ts"), "utf8");
    const builder = readFileSync(join(process.cwd(), "electron-builder.yml"), "utf8");
    expect(main).toContain('process.argv.includes("--server-only")');
    expect(main).toContain('OMB_HOST: "127.0.0.1"');
    expect(main).toContain('OMB_SERVER_SERVICE: SERVER_ONLY ? "1" : ""');
    expect(main).toContain("body?.service === true");
    // Fragment z tokenem powstaje teraz ze sklejki (obok jedzie `join=<grant>`
    // powłoki), więc literału „#access_token=" już w kodzie nie ma.
    expect(main).toContain("access_token=${encodeURIComponent(token)}");
    expect(auth).toContain('history.replaceState(null, ""');
    expect(main).toMatch(/if \(SERVER_ONLY\)[\s\S]+startServerPackaged\(\)[\s\S]+return;/);
    expect(builder).toContain("from: dist-server");
  });
});
