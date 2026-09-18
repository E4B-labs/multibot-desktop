// Kimi CLI potrzebuje osobno zainstalowanego interpretera Python 3.13.
// Rozdzielenie kroków zamienia nieczytelny błąd uv w pierwszy konkretny etap.
import { spawnSync } from "node:child_process";

const run = (args) => {
  process.stdout.write(`[kimi-install] $ uv ${args.join(" ")}\n`);
  const result = spawnSync("uv", args, { stdio: "inherit", shell: false, windowsHide: true });
  return result.error ? 1 : result.status ?? 1;
};

for (const args of [["python", "install", "3.13"], ["tool", "install", "--python", "3.13", "kimi-cli"]]) {
  const code = run(args);
  if (code !== 0) {
    process.stderr.write("Nie udało się przygotować Python 3.13 lub Kimi CLI.\n");
    process.exitCode = code;
    break;
  }
}
