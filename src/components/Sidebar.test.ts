import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { clampSidebarWidth, groupMemberAvatarProps, hoverCardPosition, profilePopoverPosition, sidebarAvatarProps } from "./Sidebar";
// Ciągnięcie liczy wspólna mechanika paneli — szyna wnosi tylko swoje domknięcie.
import { panelWidthFromDrag } from "./ResizablePanel";

const sidebarSource = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

describe("sidebar width", () => {
  it("snaps narrow drag to icon rail and clamps custom width", () => {
    expect(clampSidebarWidth(90)).toBe(80);
    const drag = (start: number, dx: number) => panelWidthFromDrag(start, dx, "right", clampSidebarWidth);
    expect(drag(240, -80)).toBe(160);
    expect(drag(240, -180)).toBe(80);
    expect(drag(240, 300)).toBe(420);
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
  const footer = sidebarSource.slice(sidebarSource.indexOf("/* Footer */"));
  const profileButton = sidebarSource.slice(
    sidebarSource.indexOf("function ProfileFooterButton"),
    sidebarSource.indexOf("function preview"),
  );

  it("keeps the profile avatar and label aligned with Plugins", () => {
    expect(footer).toContain('inline-flex size-8 shrink-0 items-center');
    // Slot ikony „Wtyczki" wygląda jak domyślny awatar profilu (InitialsAvatar:
    // rounded-full bg-raised, 32 px) — wypełnione koło, bez szarego obrysu.
    expect(footer).toContain('inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary');
    expect(footer).not.toContain("border-white/10");
    expect(footer).not.toContain("bg-[#151515]");
    expect(footer).toContain("<ProfileFooterButton />");
    expect(profileButton).toContain('<InitialsAvatar initials={profileInitials(profile)} size={32} />');
    expect(profileButton).toContain('truncate text-[14px] font-semibold text-ink');
    // Podświetlenie jak przycisk „Wtyczki" (rounded-xl + hover:bg-raised/50)…
    expect(profileButton).toContain("rounded-xl px-3 py-2 text-left hover:bg-raised/50");
  });

  it("keeps the profile hover area clear of the settings gear", () => {
    // …ale TYLKO na części flex-1: margines od koła zębatego, a sam przycisk
    // ustawień żyje POZA ProfileFooterButton (nadal w stopce) — hover profilu
    // nie może go obejmować.
    expect(profileButton).toContain("mr-1.5");
    expect(profileButton).not.toContain("toggleAppSettings");
    expect(footer).toContain('dispatch({ type: "toggleAppSettings" })');
  });

  it("shows the uploaded photo as a 32px circle and opens the popover", () => {
    expect(profileButton).toContain('className="size-8 shrink-0 rounded-full object-cover"');
    expect(profileButton).toContain('accept="image/*"');
    expect(profileButton).toContain("<AvatarCropper file={pendingFile} onSave={saveAvatar} onCancel={() => setPendingFile(null)} />");
    expect(profileButton).toContain('"/api/profile/avatar", { method: "POST"');
    expect(profileButton).toContain('"/api/profile/avatar", { method: "DELETE"');
    // popover nad stopką, zakotwiczony przy przycisku — nie centralny modal;
    // FIXED (nie absolute), bo `<aside>` ma overflow-hidden i ucinał prawą
    // krawędź panelu — pozycję liczy profilePopoverPosition z clampem
    expect(profileButton).toContain('"fixed z-50 rounded-2xl');
    expect(profileButton).toContain("profilePopoverPosition({ top: a.top }, { left: a.sidebarLeft, width: a.sidebarWidth }, width, window.innerWidth, window.innerHeight)");
    // szerokość sidebara bierze z rect całego `<aside>` — środek liczy się
    // między lewą krawędzią sidebara a uchwytem zmiany szerokości
    expect(profileButton).toContain('rootRef.current?.closest("aside")?.getBoundingClientRect()');
    // kwadrat 216 px (mieści się w domyślnym sidebarze 240 px minus paddingi
    // stopki 2×12 px) w widoku awatara; przy kadrowaniu wraca do w-72, bo
    // podgląd croppera ma 220 px szerokości
    expect(profileButton).toContain('pendingFile ? "w-72" : "w-[216px] aspect-square"');
    expect(sidebarSource).toContain("const PROFILE_POPOVER_SIZE = 216");
    // podgląd zdjęcia 80 px + gap-2 — oba stany (bez zdjęcia i ze zdjęciem
    // + „Usuń zdjęcie") mieszczą się w 216 px bez ucinania
    expect(profileButton).toContain('size-[80px] rounded-full border border-hairline/30 object-cover');
    expect(profileButton).toContain("rounded-2xl border border-hairline/40 bg-card p-3 shadow-xl");
    // treść wyśrodkowana w pionie i poziomie wewnątrz kwadratu
    expect(profileButton).toContain('"flex h-full flex-col items-center justify-center gap-2"');
    expect(profileButton).toContain("w-full text-center text-[12px]");
  });
});

describe("profile popover position", () => {
  const sidebar = { left: 0, width: 240 };

  it("centres the panel between the sidebar edge and the resize handle", () => {
    // sidebar 240, panel 216 → left = (240 − 216) / 2 = 12; 8 px nad przyciskiem
    expect(profilePopoverPosition({ top: 860 }, sidebar, 216, 1280, 900)).toEqual({ left: 12, bottom: 48 });
  });

  it("keeps the panel clear of the resize handle in a wide sidebar", () => {
    // sidebar 420: środek to left = 102 — daleko od uchwytu przy prawej krawędzi
    expect(profilePopoverPosition({ top: 860 }, { left: 0, width: 420 }, 216, 1280, 900).left).toBe(102);
    // panel niemal na całą szerokość: prawa krawędź trzyma 8 px od uchwytu
    expect(profilePopoverPosition({ top: 860 }, { left: 20, width: 230 }, 216, 1280, 900).left).toBe(20 + 230 - 216 - 8);
  });

  it("clamps to the viewport edges so the square is never cut", () => {
    // wąskie okno: 216-pikselowy panel nie mieści się — cofa się do 8 px
    expect(profilePopoverPosition({ top: 860 }, sidebar, 216, 200, 900).left).toBe(8);
    expect(profilePopoverPosition({ top: 860 }, { left: 100, width: 240 }, 216, 300, 900).left).toBe(300 - 216 - 8);
  });

  it("lets the wider cropper overflow the sidebar but not the window", () => {
    // cropper 288 > sidebar 240: środkowanie dałoby −24, clamp do okna → 8;
    // uchwytu nie wymuszamy, bo panel i tak się w sidebarze nie mieści
    expect(profilePopoverPosition({ top: 860 }, sidebar, 288, 240, 900).left).toBe(8);
    expect(profilePopoverPosition({ top: 860 }, sidebar, 288, 1280, 900).left).toBe(8);
    // szeroki sidebar 420: cropper mieści się, więc stoi wyśrodkowany z clampem uchwytu
    expect(profilePopoverPosition({ top: 860 }, { left: 0, width: 420 }, 288, 1280, 900).left).toBe(66);
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

  // multibot: buźka podąża po CAŁYM podświetlanym wierszu — wiersz bota,
  // kafelek przypiętego bota i wiersz grupy (tylko z jednym awatarem) niosą
  // scope śledzenia z Avatar.tsx. Nigdzie indziej w sidebarze.
  it("marks each highlighted row as the gaze scope", () => {
    const item = sidebarSource.slice(sidebarSource.indexOf("function BotListItem"), sidebarSource.indexOf("export function Sidebar"));
    const pinned = sidebarSource.slice(sidebarSource.indexOf("const pinnedBots ="), sidebarSource.indexOf("Unified conversation list"));
    const groupRow = sidebarSource.slice(sidebarSource.indexOf("function GroupRow"), sidebarSource.indexOf("function GroupCreateForm"));
    expect(item).toContain("data-mb-avatar-scope");
    expect(pinned).toContain("data-mb-avatar-scope");
    // Stos awatarów grupy NIE dostaje scope'a — tylko układ solo.
    expect(groupRow).toContain('data-mb-avatar-scope={layout === "solo" ? "" : undefined}');
    expect((sidebarSource.match(/data-mb-avatar-scope/g) ?? []).length).toBe(3);
  });
});

describe("group row avatar cluster", () => {
  const groupRow = sidebarSource.slice(sidebarSource.indexOf("function GroupRow"), sidebarSource.indexOf("function GroupCreateForm"));

  const botRow = sidebarSource.slice(sidebarSource.indexOf("function BotListItem"), sidebarSource.indexOf("export function Sidebar"));

  // Wymaganie Kacpra: wiersz grupy ma to samo pudełko awatara (48 px) i te same
  // odstępy co wiersz bota, więc oba wiersze są dokładnie tej samej wysokości.
  // Zmierzone headless: obie wysokości 68 px (D:\tmp\mb-grp-shots\rows.json).
  it("keeps the 48px avatar box and the bot row padding", () => {
    expect(groupRow).toContain('<span className="relative size-12 shrink-0">');
    expect(groupRow).toContain('size={layout === "solo" ? 48 : 24}');
    expect(botRow).toContain("gap-3 px-3 py-2.5");
    expect(groupRow).toContain("gap-3 px-3 py-2.5");
    // Awatary siedzą w pudełku przez tabelę slotów, nie przez własne marginesy.
    // `flex` na slocie jest obowiązkowe: inline slot łapie 6 px zejścia linii,
    // więc awatar 24 px zajmował 24×30 i rozjeżdżał się z plakietką.
    expect(groupRow).toContain('cn("absolute flex", GROUP_AVATAR_SLOTS[layout][index])');
  });

  // Klaster ma się nakładać: sąsiednie sloty stoją co 18 px przy elemencie 24 px,
  // czyli części wspólne po 6 px (25%). Zmierzone headless w after-rows.json.
  it("overlaps the cluster slots by a quarter and centres them in the box", () => {
    const slots = sidebarSource.slice(
      sidebarSource.indexOf("const GROUP_AVATAR_SLOTS"),
      sidebarSource.indexOf("function GroupRow"),
    );
    expect(slots).toContain('pair: ["left-[3px] top-[12px]", "left-[21px] top-[12px]"]');
    expect(slots).toContain('trio: ["left-[3px] top-[3px]", "left-[21px] top-[3px]", "left-[12px] top-[21px]"]');
    // Układ „stack" zniknął — 4+ używa tych samych trzech slotów co trójka.
    expect(slots).not.toContain("stack:");
  });

  it("renders the overflow badge and keeps selected and hover states", () => {
    expect(groupRow).toContain("const { layout, shown, hiddenCount } = groupAvatarLayout(members, g.bot_ids.length)");
    expect(groupRow).toContain("hiddenCount > 0");
    expect(groupRow).toContain("+{hiddenCount}");
    expect(groupRow).toContain("aria-label={`${hiddenCount} more group members`}");
    expect(groupRow).toContain('state.groupOpen?.id === g.id ? "bg-raised" : "hover:bg-raised/50"');
    // Plakietka to kolejny element klastra: ten sam rozmiar 24 px co awatar,
    // slot za ostatnim awatarem i żadnego `ring-2`, który rysował się na
    // zewnątrz i robił z niej kółko 28 px z obwódką.
    expect(groupRow).toContain("GROUP_AVATAR_SLOTS[layout][shown.length]");
    expect(groupRow).toContain("size-6 items-center justify-center rounded-full border border-hairline bg-raised");
    expect(groupRow).not.toContain("ring-2 ring-panel");
  });

  // Limit 12 nie ma testu renderującego (repo nie ma jsdom), więc pilnujemy, że
  // formularz w ogóle sięga po stałą i pokazuje licznik.
  it("caps the create form at twelve picks", () => {
    const form = sidebarSource.slice(sidebarSource.indexOf("function GroupCreateForm"));
    expect(form).toContain("else if (next.size < MAX_GROUP_MEMBERS) next.add(engineBotId)");
    expect(form).toContain("disabled={!picked.has(engineBotId) && picked.size >= MAX_GROUP_MEMBERS}");
    expect(form).toContain("{picked.size}/{MAX_GROUP_MEMBERS}");
  });
});

describe("bot hover card position", () => {
  const row = (top: number, right: number) => ({ top, right });

  it("stawia kafelek po prawej stronie wiersza w szerokim oknie", () => {
    expect(hoverCardPosition(row(100, 240), 1280, 900)).toEqual({ top: 96, left: 250 });
  });

  it("nie wychodzi poza prawą krawędź", () => {
    // wiersz na całą szerokość okna telefonu: kafelek cofa się pod prawą krawędź
    expect(hoverCardPosition(row(120, 382), 390, 844).left).toBe(390 - 288 - 8);
  });

  // Regresja: `left` nie miał dolnej granicy, więc przy oknie 280 px wychodziło
  // -16 px i kafelek uciekał za LEWĄ krawędź (zmierzone Playwrightem).
  it("nie wychodzi poza lewą krawędź w wąskim oknie", () => {
    expect(hoverCardPosition(row(120, 272), 280, 700).left).toBe(8);
    expect(hoverCardPosition(row(120, 190), 200, 700).left).toBe(8);
  });

  it("nie wychodzi poza dolną krawędź", () => {
    expect(hoverCardPosition(row(800, 240), 1280, 900).top).toBe(900 - 120 - 8);
    expect(hoverCardPosition(row(10, 240), 1280, 100).top).toBe(8);
  });
});
