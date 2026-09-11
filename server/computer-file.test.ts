import { describe, expect, it } from "vitest";

import { readComputerFile, type ComputerCommandRunner } from "./hosted-computer.ts";

/** Fake container: answers the exact two commands `readComputerFile` runs. */
const fakeContainer = (files: Record<string, Buffer>): ComputerCommandRunner => async (argv) => {
  expect(argv.slice(0, 4)).toEqual(["exec", "multibot-computer", "bash", "-lc"]);
  const cmd = argv[4];
  const m = cmd.match(/^(stat -c %s|base64 -w0) -- '([\s\S]*)'$/);
  if (!m) throw new Error(`unexpected command: ${cmd}`);
  const path = m[2].replace(/'\\''/g, "'");
  const file = files[path];
  if (!file) throw new Error("stat: cannot statx: No such file or directory");
  return m[1].startsWith("stat") ? `${file.length}\n` : file.toString("base64");
};

describe("readComputerFile (container fallback for bot attachments)", () => {
  it("reads a file's bytes out of the container via base64", async () => {
    const bytes = Buffer.from("hello from the sandbox \u{1F44B}");
    const buf = await readComputerFile("/home/cua/report.txt", 1024, fakeContainer({ "/home/cua/report.txt": bytes }), "docker");
    expect(buf.equals(bytes)).toBe(true);
  });

  it("handles single quotes in the path", async () => {
    const bytes = Buffer.from("quoted");
    const buf = await readComputerFile("/tmp/it's.txt", 1024, fakeContainer({ "/tmp/it's.txt": bytes }), "docker");
    expect(buf.equals(bytes)).toBe(true);
  });

  it("404s when the file is missing in the container too", async () => {
    await expect(readComputerFile("/tmp/nope.txt", 1024, fakeContainer({}), "docker"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("413s a file over the caller's byte limit before reading it", async () => {
    const big = Buffer.alloc(2048);
    let base64Ran = false;
    const runner: ComputerCommandRunner = async (argv) => {
      if (argv[4].startsWith("base64")) { base64Ran = true; return big.toString("base64"); }
      return String(big.length);
    };
    await expect(readComputerFile("/tmp/big.bin", 1024, runner, "docker")).rejects.toMatchObject({ status: 413 });
    expect(base64Ran, "the oversized file must never be transferred").toBe(false);
  });

  it("refuses the fallback outside the docker backend (the native computer IS the host)", async () => {
    const runner: ComputerCommandRunner = async () => { throw new Error("must not run"); };
    await expect(readComputerFile("/etc/passwd", 1024, runner, "native")).rejects.toMatchObject({ status: 404 });
  });

  it("422s a path that would break out of the quoted shell command", async () => {
    const runner: ComputerCommandRunner = async () => { throw new Error("must not run"); };
    await expect(readComputerFile("/tmp/a\nrm -rf /", 1024, runner, "docker")).rejects.toMatchObject({ status: 422 });
    await expect(readComputerFile("", 1024, runner, "docker")).rejects.toMatchObject({ status: 422 });
  });
});
