import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { jobProgress, SetupJobs, type SetupJob } from "./setup-jobs.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "multibot-setup-jobs-"));
  scratch.push(dir);
  return join(dir, "jobs.json");
}

function terminal(jobs: SetupJobs, id: string): Promise<SetupJob> {
  const current = jobs.get(id)!;
  if (current.status !== "running") return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = jobs.subscribe(id, (job) => {
      if (job.status === "running") return;
      unsubscribe();
      resolve(job);
    });
  });
}

describe("SetupJobs", () => {
  it("streams output and persists a completed background job", async () => {
    const file = tempFile();
    const jobs = new SetupJobs(file);
    const started = jobs.start({
      key: "test",
      kind: "cli-install",
      title: "Test setup",
      command: process.execPath,
      args: ["-e", "console.log('phase one')"],
    });

    const done = await terminal(jobs, started.id);
    expect(done).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(done.output).toContain("phase one");
    expect(jobProgress(done)).toMatchObject({ id: started.id, step: "Test setup", message: "phase one", done: true });
    expect(new SetupJobs(file).get(started.id)).toMatchObject({ status: "succeeded" });
  });

  it("marks an interrupted persisted job failed after restart", () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "interrupted",
          key: "cli-install",
          kind: "provision",
          title: "Install bot server",
          command: "node install-claude.mjs",
          status: "running",
          output: [],
          createdAt: 1,
        },
      ]),
    );

    const recovered = new SetupJobs(file).get("interrupted")!;
    expect(recovered.status).toBe("failed");
    expect(jobProgress(recovered)).toMatchObject({ done: false, error: "server restarted before the job finished" });
    expect(JSON.parse(readFileSync(file, "utf8"))[0].status).toBe("failed");
  });

  it("keeps interactive login output in progress events", () => {
    const job: SetupJob = {
      id: "login",
      key: "cli-login:claude",
      kind: "cli-login",
      title: "Sign in Claude Code",
      command: "claude",
      status: "running",
      output: ["$ claude", "Open browser to continue"],
      createdAt: 1,
    };
    expect(jobProgress(job)).toMatchObject({ done: false, output: ["$ claude", "Open browser to continue"] });
  });
});
