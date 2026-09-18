import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceStore } from "./workspace.ts";

const roots: string[] = [];
const make = () => {
  const root = mkdtempSync(join(tmpdir(), "multibot-workspace-"));
  roots.push(root);
  const file = join(root, "workspace.json");
  return { file, store: new WorkspaceStore(file) };
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("driver-neutral workspace", () => {
  it("persists memory, skills and policy per bot", () => {
    const { file, store } = make();
    const fact = store.addFact("cli", { text: "Prefers local models", source: "user" });
    const tagged = store.addFact("cli", { text: "Ask @researcher about #deploy" });
    store.putMarkdown("cli", "# Durable memory");
    store.addSkill("cli", { name: "review", description: "Review code", instructions: "Check tests." });
    store.setAutonomy("cli", "autonomous");
    store.setPermissions("cli", { terminal: false });

    const restored = new WorkspaceStore(file);
    expect(restored.facts("cli")).toContainEqual(fact);
    expect(restored.facts("cli", "local")).toEqual([fact]);
    expect(restored.facts("cli")).toContainEqual(expect.objectContaining({ id: tagged.id, entities: ["@researcher", "#deploy"] }));
    expect(restored.graph("cli")).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: `f${tagged.id}`, type: "fact" }),
        expect.objectContaining({ id: "e@researcher", type: "entity" }),
      ]),
      edges: expect.arrayContaining([{ source: `f${tagged.id}`, target: "e@researcher" }]),
    });
    expect(restored.markdown("cli")).toEqual({ content: "# Durable memory" });
    expect(restored.skills("cli")[0]).toMatchObject({ name: "review", enabled: true });
    expect(restored.autonomy("cli")).toEqual({ autonomy: "autonomous" });
    expect(restored.permissions("cli").terminal).toBe(false);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("maps every bot to one of three access profiles", () => {
    const { store } = make();
    expect(store.access("bot")).toEqual({ access: "approval" });
    expect(store.setAccess("bot", "read-only")).toEqual({ access: "read-only" });
    expect(store.permissions("bot").terminal).toBe(false);
    expect(store.setAccess("bot", "full")).toEqual({ access: "full" });
    expect(store.permissions("bot").terminal).toBe(true);
    expect(store.autonomy("bot")).toEqual({ autonomy: "autonomous" });
    expect(store.setAccess("private", "full")).toEqual({ access: "full" });
    expect(store.access("private")).toEqual({ access: "full" });
    expect(store.autonomy("private")).toEqual({ autonomy: "autonomous" });
  });

  it("keeps team memory separate from each bot memory", () => {
    const { store } = make();
    const botFact = store.addFact("bot-a", { text: "private note" });
    const teamFact = store.addTeamFact({ text: "shared decision" });
    store.putTeamMarkdown("# Team rules");
    expect(store.facts("bot-a")).toContainEqual(botFact);
    expect(store.facts("bot-a")).not.toContainEqual(teamFact);
    expect(store.teamFacts()).toContainEqual(teamFact);
    expect(store.teamMarkdown()).toEqual({ content: "# Team rules" });
  });

  it("normalizes usage and deletes scoped records", () => {
    const { store } = make();
    store.recordTokens("bot", 12, 5);
    store.recordTokens("bot", -1, 3);
    store.recordTurn("bot");
    expect(store.usage("bot")).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, turns: 1 });

    const fact = store.addFact("bot", { text: "temporary" });
    expect(store.patchFact("bot", fact.id, { text: "updated" })?.text).toBe("updated");
    expect(store.deleteFact("bot", fact.id)).toBe(true);
    const skill = store.addSkill("bot", { name: "one", instructions: "Do one." });
    expect(store.patchSkill("bot", skill.name, { enabled: false })?.enabled).toBe(false);
    expect(store.deleteSkill("bot", skill.name)).toBe(true);
  });

  it("persists and revokes remembered approval rules", () => {
    const { file, store } = make();
    const rule = store.addApprovalRule("bot", { provider: "codex", key: "prefix:git status", label: "git status …" });
    expect(store.addApprovalRule("bot", { provider: "codex", key: rule.key, label: rule.label }).id).toBe(rule.id);
    expect(new WorkspaceStore(file).approvalRules("bot")).toEqual([rule]);
    expect(store.removeApprovalRule("bot", rule.id)).toBe(true);
    expect(store.approvalRules("bot")).toEqual([]);
  });
});
