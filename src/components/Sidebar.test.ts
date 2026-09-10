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

  it("uses the same paused animation state for group members", () => {
    const idle = groupMemberAvatarProps(bot({ busy: false }));
    expect(idle.animated).toBe(false);
    expect(idle.state).toBe("idle");
    expect(idle.motion).toBe("none");

    const busy = groupMemberAvatarProps(bot({ id: "b2", busy: true }));
    expect(busy.animated).toBe(false);
    expect(busy.motion).toBe("none");
  });

  it("uses the same state and motion contract as a single bot avatar", () => {
    const member = bot({ id: "b3", avatarUrl: "data:image/png;base64,a" });
    expect(groupMemberAvatarProps(member)).toEqual(sidebarAvatarProps(member));
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
    expect(groupRow).toContain("trackPointerWhenPaused");
    expect(groupRow).toContain("avatarUrl={member.avatarUrl}");
    expect(groupRow).toContain("shape={member.mascotShape}");
    expect((sidebarSource.match(/trackPointerWhenPaused/g) ?? []).length).toBe(3);
  });
});

describe("group row avatar cluster", () => {
  const groupRow = sidebarSource.slice(sidebarSource.indexOf("function GroupRow"), sidebarSource.indexOf("function GroupCreateForm"));

  // Wymaganie Kacpra: wiersz grupy ma to samo pudełko awatara (48 px) i te same
  // odstępy co wiersz bota, więc oba wiersze są dokładnie tej samej wysokości.
  it("keeps the 48px avatar box and the bot row padding", () => {
    expect(groupRow).toContain('<span className="relative size-12 shrink-0">');
    expect(groupRow).toContain('collapsed ? "justify-center px-0 py-1.5" : "gap-3 px-3 py-2.5"');
    expect(groupRow).toContain('size={layout === "solo" ? 48 : 24}');
    // Każdy slot jest pozycjonowany wewnątrz pudełka — nic nie wystaje poza 48 px.
    expect(sidebarSource).toContain('solo: ["inset-0"]');
    expect(sidebarSource).toContain('pair: ["left-0 top-3", "right-0 top-3"]');
    expect(sidebarSource).toContain('trio: ["left-0 top-0", "right-0 top-0", "bottom-0 left-3"]');
    expect(sidebarSource).toContain('stack: ["left-0 top-0", "bottom-0 left-0"]');
    expect(groupRow).toContain('cn("absolute", GROUP_AVATAR_SLOTS[layout][index])');
  });

  it("renders the overflow badge and keeps selected and hover states", () => {
    expect(groupRow).toContain("const { layout, shown, hiddenCount } = groupAvatarLayout(members, g.bot_ids.length)");
    expect(groupRow).toContain('layout === "stack" && hiddenCount > 0');
    expect(groupRow).toContain("+{hiddenCount}");
    expect(groupRow).toContain("aria-label={`${hiddenCount} more group members`}");
    expect(groupRow).toContain('state.groupOpen?.id === g.id ? "bg-raised" : "hover:bg-raised/50"');
  });
});
