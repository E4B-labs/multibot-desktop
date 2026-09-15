// multibot: killing a CLI *and* everything it started, on every platform.
//
// The drivers spawn their CLI detached so it leads its own process group,
// then kill -pid to reap the whole group — the CLI's MCP servers and
// helper processes included. Process groups are a POSIX concept:
// process.kill(-pid) throws EINVAL on Windows, and the fallback that
// catches it kills the CLI alone, orphaning every server it started.
// Windows tracks the parent/child tree instead, which is what
// `taskkill /T` walks.
//
// multibot: on Termux, `proot` (the ACP CLIs run inside a proot-distro
// rootfs — see attachments.ts prootRoots) ptrace-attaches its child and, on
// some builds, moves it to its own session/process group. `-pid` then only
// ever reaches the proot wrapper: the SIGTERM kills proot, the traced child
// (e.g. `opencode acp`) is silently reparented and keeps running, chewing
// CPU with nobody left tracking it (observed live: two orphaned `opencode`
// processes, 20+ min, 70-84% CPU, no owning wrapper). So on Linux we also
// walk /proc for the whole descendant tree by PID (not just the process
// group) and signal every PID directly, then re-scan and SIGKILL whatever
// is still alive after a grace period — belt-and-braces against a sandbox
// that doesn't propagate group signals.
import { execFile, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const ESCALATE_MS = 3_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours (proot child under another uid); only
    // ESRCH means gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kernel start time of `pid` (jiffies since boot, /proc/<pid>/stat field
 * 22), or null when unreadable. Same pid + same start time = same process,
 * which is what guards the SIGKILL pass against PID reuse. */
function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

/** All PIDs reachable from `rootPid` via /proc's ppid links, root included.
 * Linux/Termux only (proc pseudo-fs) — returns just [rootPid] elsewhere or
 * on any read failure. */
function descendantPids(rootPid: number): number[] {
  if (process.platform !== "linux") return [rootPid];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [rootPid];
  }
  const childrenOf = new Map<number, number[]>();
  for (const name of entries) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) state ppid ..." — comm can contain spaces/parens, so
      // parse from the LAST ")".
      const rest = stat.slice(stat.lastIndexOf(")") + 2);
      const ppid = Number(rest.split(" ")[1]);
      if (!Number.isInteger(ppid)) continue;
      const list = childrenOf.get(ppid);
      if (list) list.push(pid);
      else childrenOf.set(ppid, [pid]);
    } catch {
      /* process exited mid-scan */
    }
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift()!;
    out.push(pid);
    for (const c of childrenOf.get(pid) ?? []) queue.push(c);
  }
  return out;
}

function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

/** Terminate a spawned CLI together with its descendants. Best-effort and
 * synchronous to call: nothing here throws. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, (err) => {
      if (!err) return;
      try {
        child.kill(); // taskkill unavailable or already gone — at least the CLI
      } catch {}
    });
    return;
  }
  const tree = descendantPids(pid);
  // Snapshot identity BEFORE signalling: once proot dies its traced child is
  // reparented to init and no longer shows up under `pid`, so the re-walk
  // alone would miss exactly the orphan this file exists for.
  const identity = new Map(tree.map((p) => [p, startTime(p)] as const));
  try {
    process.kill(-pid, "SIGTERM"); // process group, when the sandbox kept it
  } catch {
    try {
      child.kill("SIGTERM"); // at least the CLI itself
    } catch {}
  }
  signalAll(tree, "SIGTERM"); // + every PID by proc walk, group or not

  const escalate = setTimeout(() => {
    // Survivors = snapshot pids still alive with the same start time (PID
    // reuse guard) + their current descendants (grandchildren spawned since
    // the first scan, e.g. opencode's own MCP proxies).
    const survivors = new Set<number>();
    for (const [p, start] of identity) {
      if (!isAlive(p)) continue;
      if (start !== null && startTime(p) !== start) continue; // reused pid
      for (const d of descendantPids(p)) survivors.add(d);
    }
    if (survivors.size === 0) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    signalAll([...survivors], "SIGKILL");
  }, ESCALATE_MS);
  escalate.unref?.();
}
