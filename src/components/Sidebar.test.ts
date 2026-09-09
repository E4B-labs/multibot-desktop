import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { clampSidebarWidth, groupMemberAvatarProps, sidebarAvatarProps, sidebarWidthFromDrag } from "./Sidebar";

const sidebarSource = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

describe("sidebar width", () => {
  it("snaps narrow drag to icon rail and clamps custom width", () => {
    expect(clampSidebarWidth(90)).toBe(80);
    expect(sidebarWidthFromDrag(240, -80)).toBe(160);
    expect(sidebarWidthFromDrag(240, -180)).toBe(80);
    expect(sidebarWidthFromDrag(240, 300)).toBe(420);
  });
});

describe("sidebar avatar", () => {
  const bot = (over: Partial<Bot>): Bot =>
    ({ id: "b1", name: "Bot", color: "#fff", messages: [], ...over }) as Bot;

  // Jeden animowany bot na cala aplikacje stoi na pasku nad composerem, wiec
  // pasek boczny nie rusza sie NIGDY — takze pod bota w trakcie tury.
  it("freezes every bot, busy or not", () => {
    const still = { state: "idle", motion: "none", animated: false, motionKey: 0 };
    expect(sidebarAvatarProps(bot({ busy: false }))).toEqual(still);
    expect(sidebarAvatarProps(bot({ busy: true }))).toEqual(still);
  });

  // Stos skladu na wierszu grupy szedl wlasna sciezka (stateForBot + motion
  // "none", bez `animated`), wiec bezczynny czlonek dalej mrugal i oddychal.
  it("freezes group members too", () => {
    const idle = groupMemberAvatarProps(bot({ busy: false }));
    expect(idle.animated).toBe(false);
    expect(idle.state).toBe("happy");
    expect(idle.motion).toBe("none");

    const busy = groupMemberAvatarProps(bot({ id: "b2", busy: true }));
    expect(busy.animated).toBe(false);
    expect(busy.motion).toBe("none");
  });
});

describe("sidebar footer alignment", () => {
  it("keeps the profile avatar and label aligned with Plugins", () => {
    const footer = sidebarSource.slice(sidebarSource.indexOf("/* Footer */"));
    expect(footer).toContain('inline-flex size-8 shrink-0 items-center');
    expect(footer).toContain('<InitialsAvatar initials={profileInitials(state.config?.profile)} size={32} />');
    expect(footer).toContain('truncate text-[14px] font-semibold text-ink');
    expect(footer).toContain('flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left');
  });
});

describe("bot picker avatar follow", () => {
  it("follows only in BotListItem and pinned bot picker", () => {
    const itemStart = sidebarSource.indexOf("function BotListItem");
    const itemEnd = sidebarSource.indexOf("export function Sidebar", itemStart);
    const item = sidebarSource.slice(itemStart, itemEnd);
    const pinnedStart = sidebarSource.indexOf("const pinnedBots =");
    const pinnedEnd = sidebarSource.indexOf("Unified conversation list", pinnedStart);
    const pinned = sidebarSource.slice(pinnedStart, pinnedEnd);
    const hoverCard = sidebarSource.slice(sidebarSource.indexOf("function BotHoverCard"), itemStart);
    const groupRow = sidebarSource.slice(sidebarSource.indexOf("function GroupRow"), sidebarSource.indexOf("function GroupCreateForm"));

    expect(item).toContain("trackPointerWhenPaused");
    expect(item).toContain("onMouseEnter");
    expect(item).toContain("onMouseLeave");
    expect(pinned).toContain("trackPointerWhenPaused");
    expect(hoverCard).not.toContain("trackPointerWhenPaused");
    expect(groupRow).not.toContain("trackPointerWhenPaused");
    expect((sidebarSource.match(/trackPointerWhenPaused/g) ?? []).length).toBe(2);
  });
});
