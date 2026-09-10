import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: odchudzenie prawego panelu i kolumny czatu (Kacper 29.08) — panel
// zabierał ponad połowę okna, a to, co zostawało, było na tyle wąskie, że tekst
// łamał się po trzech słowach. Wszystkie warunki są wymiarami w źródle, więc
// nie trzeba do tego renderować drzewa Reacta.
const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./ModelPicker.tsx", import.meta.url), "utf8");
const providerIcons = readFileSync(new URL("./ProviderIcons.tsx", import.meta.url), "utf8");
const computerPanel = readFileSync(new URL("./ComputerPanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("skala prawego panelu i czatu", () => {
  it("panel jest węższy niż był, a jego szerokość startowa jest jedna", () => {
    // Od 10.09 szerokość ciągnie się myszą (ResizablePanel), więc sztywnej
    // klasy `w-[…px]` już nie ma — pilnujemy wartości, od której panel startuje.
    const widths = [...panel.matchAll(/defaultWidth=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(widths.length).toBe(1);
    for (const width of widths) expect(width).toBeLessThanOrEqual(340);
    // Sztywne piksele w środku panelu nadal obowiązuje ten sam sufit.
    const hard = [...panel.matchAll(/w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
    for (const width of hard) expect(width).toBeLessThanOrEqual(340);
  });

  it("awatar otwiera zakładki Bot i Prześlij bez generatora", () => {
    expect(panel).toContain("setAppearanceMode");
    expect(panel).toContain("aria-expanded={appearanceMode !== \"closed\"}");
    expect(panel).toContain('type AppearanceMode = "closed" | "bot" | "photo"');
    expect(panel).toContain("MASCOT_SHAPES.map");
    expect(panel).toContain("BOT_COLOR_NAMES.map");
    expect(panel).toContain("Prześlij");
    expect(panel).not.toContain("Generate");
    expect(panel).not.toContain("Generuj");
    expect(panel).toContain('animated={false} trackPointer={false} showFace={false}');
    expect(panel).not.toContain("Photo will be cropped to a circle like Facebook/GrokBot");
    expect(panel).not.toContain("Zdjęcie zostanie przycięte do koła jak na Facebooku/GrokBot");
  });

  it("filtr szukajki wie o rozwijanej karcie wyglądu", () => {
    // Bez `appearanceMode` w zależnościach karta rozwinięta przy aktywnym
    // szukaniu ominęłaby filtr i została na ekranie.
    expect(panel).toContain("[query, appearanceMode]");
  });

  it("nic w panelu nie jest już większe niż 14 px", () => {
    const sizes = [...panel.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(14);
  });

  it("dymki czatu mają 14 px i ciaśniejszą interlinię", () => {
    expect(chat).toContain("text-[14px] leading-[1.45]");
    expect(chat).not.toContain("text-[15px] leading-relaxed");
  });

  it("pigułka modelu w nagłówku czatu to sama ikona", () => {
    expect(chat).toContain("<ModelPicker bot={bot} compact />");
    // nazwa modelu musi zostać w dymku, inaczej nie da się sprawdzić,
    // na czym bot pracuje, bez otwierania listy
    expect(picker).toContain("{!compact && <span");
    expect(picker).toContain("aria-label={activeLabel || selection.model}");
  });

  it("OpenCode ma jedną ikonę, grupy Go/Zen i formularz klucza", () => {
    expect(providerIcons).toContain("export function OpenCodeMark");
    expect(providerIcons).toContain('case "opencode":');
    expect(picker).toContain("groupOpenCodeModels");
    expect(picker).toContain('section="opencode"');
    expect(picker).toContain("railInstance.models.updatedAt");
  });

  it("wiersz modelu ma czytelną nazwę, odznaki i bramkę klucza", () => {
    // nazwa zamiast surowego `opencode-go/…` — i w wierszu, i w pigułce nagłówka
    expect(picker).toContain("modelLabel(option.id, option.label)");
    expect(picker).toContain("instanceModelLabel(active, selection.model)");
    expect(picker).toContain("isFreeModel(option.id)");
    // klucz przygasza wiersz, ale go nie blokuje — klik otwiera pole klucza
    expect(picker).toContain("wymaga wspólnego klucza OpenCode Go");
    expect(picker).toContain("<KeyRound size={12}");
    // brakujący klucz ORAZ niezalogowany CLI przygaszają ten sam wiersz
    expect(picker).toContain('!disabled && dimmed && "opacity-60"');
    expect(picker).toContain('const dimmed = gate === "signin" || Boolean(opts.needsKey);');
    // powód siedzi na całym wierszu: niedostępność, brak logowania albo brakujący klucz
    expect(picker).toContain("title={disabled ? (instance.snapshot.reason ?? undefined) : hint}");
    expect(picker).toContain('role="img" aria-label={hint}');
    // licznik grupy z jednostką, nie goła liczba
    expect(picker).toContain('{group.options.length} {polish ? "modeli" : "models"}');
  });

  it("podpis poziomu rozumowania znika przy otwartym panelu", () => {
    // warunek przeniósł się z samych ustawień bota na KAŻDY panel boczny —
    // resztę pilnuje Composer.test.ts („zwijanie pigułek composera")
    expect(composer).toContain("const pillsCollapsed = sidePanelOpen(state);");
    expect(composer).toContain("{!pillsCollapsed && <span>{reasoningLabel}</span>}");
    expect(composer).not.toContain("{!state.settingsOpen && (");
  });

  it("przycisk ustawień ma symetryczny obszar podświetlenia", () => {
    expect(computerPanel).toContain("inline-flex size-8 items-center justify-center rounded-md p-0");
  });

  it("pole pisania nie pokazuje własnego paska przewijania", () => {
    expect(composer).toContain("data-composer-input");
    expect(css).toContain("[data-composer-input]");
    expect(css).toContain("scrollbar-width: none");
    // samo przewijanie zostaje — inaczej długa wiadomość znów wypchnęłaby czat
    expect(composer).toContain("overflow-y-auto");
  });
});
