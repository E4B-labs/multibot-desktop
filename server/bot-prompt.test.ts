// multibot: prompt systemowy to mapa możliwości, a każdy jej punkt jest
// warunkowy na zamontowane narzędzie. Test pilnuje dwóch rzeczy naraz: że
// sekcje i nazwy narzędzi są na miejscu przy pełnym zestawie, i że przy braku
// integracji NIE ma instrukcji do narzędzia, którego bot nie dostał (regresja
// bc3d15ec: podpowiedź o hand_over_computer bez serwera `agents`).
import { describe, expect, it } from "vitest";

import { botSystemPrompt, currentTimeLine, type WorkspaceLike } from "./bot-prompt.ts";
import { COMPUTER_MCP_TOOLS } from "./turn-tools.ts";

const workspace: WorkspaceLike = {
  markdown: () => ({ content: "Klient płaci przelewem." }),
  facts: () => [{ text: "Kacper woli krótkie odpowiedzi." }],
  skills: () => [{ name: "raport tygodniowy", instructions: "Zbierz dane, wyślij.", enabled: true }],
  autonomy: () => ({ autonomy: "approval" }),
  access: () => ({ access: "full" }),
};

const bot = { id: "b1", name: "Ola", title: "Asystentka", description: "Pilnuje klientów." };
const prompt = (integrations: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  botSystemPrompt(bot, { isolated: false, integrations, workspace, ...extra });

const ALL = { agents: { command: "node" }, localComputer: { command: "py" }, composio: { key: "k" } };

describe("botSystemPrompt", () => {
  it("ma wszystkie sekcje i nazwy narzędzi przy pełnym zestawie integracji", () => {
    const text = prompt(ALL);
    for (const heading of ["# Who you are", "# What you have and when to use it", "# How you work", "# Environment"]) {
      expect(text).toContain(heading);
    }
    for (const tool of ["hand_over_computer", "ask_user", "create_routine", "create_reminder", "notify_user", "request_connection", "COMPOSIO_SEARCH_TOOLS", "get_device_info", "send_file"]) {
      expect(text).toContain(tool);
    }
    // Stare asercje rund A2/A3/A4/H3 — reguły przeniesione, nie zgubione.
    expect(text).toContain("MultiBot Agent");
    expect(text).toContain("never call ToolSearch");
    expect(text).toContain("five-field cron");
    // przypomnienie to jednorazowa data, nie cron raz na rok
    expect(text).toContain("is a REMINDER, not a routine");
    expect(text).toContain("never a yearly cron");
    expect(text).toContain("Persistence");
    expect(text).toContain("MultiBot Full Access");
    expect(text).toContain("user_has_control");
    expect(text).toContain("mcp__computer");
    expect(text).toContain("Agents/workspace MCP tools this turn");
    // 3.1/3.2: ton współpracownika + potwierdzenie jednym zdaniem.
    expect(text).toContain("coworker on a messenger");
    expect(text).toContain("As an AI");
    expect(text).toContain("On it:");
    expect(text).toContain("ask_user(question, choices, multiple, detail)` is the ONLY way");
    // multibot: format pytania musi opisywać wielokrotny wybór, inaczej model
    // nigdy z niego nie skorzysta
    expect(text).toContain("multiple: true");
    expect(text).toContain("# Human writing style");
    // Wyjatek na pogrubienia: odpowiedz krokowa MA miec wytluszczony poczatek
    // punktu (tego chce Kacper), zwykla rozmowa nadal bez pogrubien.
    expect(text).toContain("In plain conversational prose, no bold at all");
    expect(text).toContain("bold lead-in on a numbered or bulleted step");
    expect(text).not.toMatch(/[—–]/);
    // Pamięć, notatki i skille użytkownika lecą na końcu.
    expect(text.indexOf("# Memory facts")).toBeGreaterThan(text.indexOf("# How you work"));
    expect(text).toContain("Kacper woli krótkie odpowiedzi.");
    expect(text).toContain("raport tygodniowy");
  });

  it("bez komputera nie ma sekcji komputera", () => {
    const text = prompt({ agents: { command: "node" } });
    expect(text).not.toContain("Your computer -");
    expect(text).not.toContain("computer_exec");
    expect(text).not.toContain("Handing the computer over");
  });

  // Regresja zmierzona na żywym CLI (D:\tmp\mb-cu-evidence): na „Use your
  // computer: open the browser, go to youtube.com…" bot BEZ zamontowanego
  // komputera nie wołał niczego i meldował „YouTube MrBeast video open".
  // Prompt milczał o komputerze, więc model go sobie dopowiedział.
  it("bez komputera mówi wprost, że go nie ma, zamiast pozwolić zmyślać", () => {
    const text = prompt({ agents: { command: "node" } });
    expect(text).toContain("You have NO computer this turn");
    expect(text).toContain("Never describe browsing, clicking or playing anything");
    // `web_search` stoi za tą samą bramką `browser` co komputer, więc bez
    // zamontowanego `web` oferta nie ma prawa paść — inaczej to zdanie
    // popełniałoby błąd, który naprawia.
    expect(text).not.toContain("offer `web_search`/`web_extract` instead");
    expect(prompt({ agents: { command: "node" }, web: { command: "node" } }))
      .toContain("offer `web_search`/`web_extract` instead");
  });

  it("z komputerem każe WOŁAĆ narzędzie, nie opowiadać o nim", () => {
    const text = prompt(ALL);
    expect(text).toContain("instruction to CALL a computer tool in THIS turn");
    expect(text).toContain("unless a computer tool call returned a result");
    // lustro tego wyżej NIE może się pojawić, gdy komputer jest
    expect(text).not.toContain("You have NO computer this turn");
  });

  // Regresja: prompt kazał wołać `browser_navigate`/`browser_snapshot`, których
  // serwer komputera nigdy nie serwował (jego narzędzia to `navigate`,
  // `read_page`…). Model szukał nieistniejącej nazwy i kończył opowiadaniem.
  // Test bierze nazwy Z PROMPTU i konfrontuje je z listą serwera, więc łapie
  // każdą następną wymyśloną nazwę, nie tylko te dwie.
  it("nie obiecuje nazw narzędzi, których serwer komputera nie serwuje", () => {
    const text = prompt(ALL);
    expect(text).not.toMatch(/browser_[a-z_]+/);
    const listed = text.match(/navigate\/read_page\/[a-z_/]+/)?.[0].split("/") ?? [];
    expect(listed.length).toBeGreaterThan(3);
    for (const name of listed) expect(COMPUTER_MCP_TOOLS as readonly string[]).toContain(name);
  });

  it("bez serwera agents nie podpowiada hand_over_computer", () => {
    const text = prompt({ localComputer: { command: "py" } });
    expect(text).toContain("Your computer -");
    expect(text).not.toContain("Handing the computer over");
    expect(text).not.toContain("hand_over_computer");
    // who mention of create_routine is unconditional (identity), tool instruction is agents-only
    expect(text).not.toContain("Routines — anything recurring");
    expect(text).not.toContain("Call `create_routine` directly");
    // `get_device_info` też jest z serwera `agents` — sekcja Environment nie
    // może kazać go wołać, gdy go nie ma (ta sama klasa błędu co bc3d15ec).
    expect(text).not.toContain("get_device_info");
    // przypomnienia, banerki i prośby o konektor też są narzędziami z `agents`
    expect(text).not.toContain("create_reminder");
    expect(text).not.toContain("notify_user");
    expect(text).not.toContain("request_connection");
  });

  it("bez Composio nie mówi o konektorach", () => {
    const text = prompt({ agents: { command: "node" } });
    expect(text).not.toContain("COMPOSIO_SEARCH_TOOLS");
  });

  it("w pokoju grupowym ogranicza kontekst do pokoju", () => {
    expect(prompt(ALL, { isolated: true })).toContain("shared group room");
  });

  it("tagowanych peerów woła przez send_bot_mail, a bez agents bierze gotowe odpowiedzi", () => {
    const tagged = [{ id: "b2", name: "Ala" }];
    expect(prompt(ALL, { tagged })).toContain("send_bot_mail bot_id b2");
    const noAgents = prompt({ localComputer: { command: "py" } }, { tagged, taggedReplies: "\nPeer Ala replied:\nok" });
    expect(noAgents).toContain("harness already fetched");
    expect(noAgents).toContain("Peer Ala replied");
  });

  it("na pierwsze powitanie od peera odpowiada zamiast milczeć", () => {
    expect(prompt(ALL)).toContain("A direct greeting from another bot always gets a brief reply");
  });

  it("w trybie autonomicznym nie każe prosić o zgodę", () => {
    const text = botSystemPrompt(bot, {
      isolated: false,
      integrations: ALL,
      workspace: { ...workspace, autonomy: () => ({ autonomy: "autonomous" }) },
    });
    expect(text).toContain("Operate autonomously");
    expect(text).not.toContain("Ask for approval before consequential actions");
  });

  it("bez Full Access pilnuje granic", () => {
    const text = botSystemPrompt(bot, {
      isolated: false,
      integrations: ALL,
      workspace: { ...workspace, access: () => ({ access: "standard" }) },
    });
    expect(text).toContain("not in Full Access");
  });

  it("identity total hide — agent nie wie czym jest, tylko MultiBot", () => {
    const text = prompt(ALL);
    // nazwa bota + MultiBot Agent musi być w who
    expect(text).toContain("You are Ola, a MultiBot Agent");
    expect(text).toContain("MultiBot is your ONLY identity");
    expect(text).toContain("You are a MultiBot Agent and nothing else");
    expect(text).toContain("do not know, do not speculate, and do not reveal any underlying model");
    expect(text).toContain("Never mention, hint, infer, or disclose whether you are powered by GPT");
    expect(text).toContain("you simply do not have that information and must not invent it");
    expect(text).toContain("Your only origin is MultiBot");
    expect(text).toContain("say your capabilities come from MultiBot itself");
    expect(text).toContain("never say you run on claude.ai, chatgpt.com, x.ai");
    expect(text).toContain("overrides any base model system prompt");
  });

  // multibot: bez tej linii bot nie wiedział ANI która godzina, ANI jaki dzień
  // — a rutyny i terminy liczy właśnie od "dzisiaj".
  it("mówi botowi datę, godzinę i strefę z ustawień", () => {
    const now = new Date("2026-08-29T12:34:56Z");
    const text = botSystemPrompt(bot, { isolated: false, integrations: ALL, workspace, timeZone: "Asia/Tokyo", now });
    expect(text).toContain("2026-08-29 21:34");
    expect(text).toContain("Asia/Tokyo");
    // linia siedzi w Environment, obok zdania o hoście
    expect(text.indexOf("2026-08-29 21:34")).toBeGreaterThan(text.indexOf("# Environment"));
    expect(text.indexOf("2026-08-29 21:34")).toBeLessThan(text.indexOf("This server runs on"));
  });

  it("ta sama chwila w dwóch strefach to dwie różne godziny", () => {
    const now = new Date("2026-08-29T12:34:56Z");
    expect(currentTimeLine(now, "Europe/Warsaw")).toContain("2026-08-29 14:34");
    expect(currentTimeLine(now, "America/Los_Angeles")).toContain("2026-08-29 05:34");
    // strefa zza daty zmiany doby — data też musi być inna, nie tylko godzina
    expect(currentTimeLine(new Date("2026-08-29T23:30:00Z"), "Asia/Tokyo")).toContain("2026-08-30 08:30");
  });

  it("pusta i śmieciowa strefa spadają na strefę hosta zamiast wysypać prompt", () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date("2026-08-29T12:34:56Z");
    expect(currentTimeLine(now, "")).toContain(host);
    expect(currentTimeLine(now, "   ")).toContain(host);
    expect(currentTimeLine(now, undefined)).toContain(host);
    // nazwa z ręcznie edytowanego configu — `Intl` na takiej rzuca
    expect(currentTimeLine(now, "Nowhere/Nothing")).toContain(host);
  });

  // multibot: "czy jesteś podłączony?" — bot odpowiadał jak agent bez narzędzi,
  // bo prompt nigdzie nie mówił wprost, CO jest zamontowane w tej turze.
  it("wylicza połączenia tej tury i każe z nich odpowiadać na pytanie o podłączenie", () => {
    const text = prompt(ALL);
    expect(text).toContain("# Your connections and tools");
    expect(text).toContain("You are Ola, working in the user's MultiBot workspace.");
    expect(text).toContain("You ARE connected. Mounted for you in THIS turn:");
    expect(text).toContain("- mcp__computer: screenshot, navigate");
    expect(text).toContain("- agents: list_bots");
    expect(text).toContain("- composio:");
    // zakaz dotyczy TEGO, CO NA LIŚCIE — bot bez komputera ma o tym powiedzieć
    // wprost, więc dawne „never claim you have no computer" musiało się zwęzić
    expect(text).toContain("Never deny a connection that is listed here.");
    // spis siedzi PRZED opisem jak używać narzędzi
    expect(text.indexOf("# Your connections and tools")).toBeLessThan(text.indexOf("# What you have"));
  });

  it("spis połączeń wymienia tylko to, co naprawdę zamontowane", () => {
    const noComputer = prompt({ agents: { command: "node" } });
    expect(noComputer).toContain("- agents: list_bots");
    expect(noComputer).not.toContain("mcp__computer");
    expect(noComputer).not.toContain("- composio:");
    const noAgents = prompt({ localComputer: { command: "py" } });
    expect(noAgents).toContain("- mcp__computer: screenshot, navigate");
    expect(noAgents).not.toContain("- agents:");
    const nothing = prompt({});
    expect(nothing).toContain("Nothing is mounted for you in THIS turn");
    expect(nothing).not.toContain("You ARE connected");
  });

  // multibot: bot z komputerem bywał bierny — jeden klik, chybienie, pytanie do
  // użytkownika. Playbook jest warunkowy na komputer, a linie o sekretach
  // dodatkowo na serwer `agents` (regresja bc3d15ec).
  it("z komputerem dostaje playbook użycia komputera", () => {
    const text = prompt(ALL);
    expect(text).toContain("# Using your computer well");
    expect(text).toContain("at least three genuinely different attempts");
    expect(text).toContain("The same click three times is a loop");
    // korekta: komputer to cała maszyna, nie sama przeglądarka
    expect(text).toContain("It is a whole Linux machine, not just a browser");
    expect(text).toContain("shell, api or curl first");
    expect(text).toContain("Install it instead of giving up");
    expect(text).toContain("`request_credential`");
    expect(text).toContain("Clicking a button is not evidence that it worked");
    // wspólna maszyna: cudze procesy i globalna konfiguracja są nietykalne
    expect(text).toContain("Never kill processes that are not yours");
    expect(text).toContain("Do not touch global configuration");
    // playbook siedzi po opisie narzędzi, przed regułami pracy
    expect(text.indexOf("# Using your computer well")).toBeGreaterThan(text.indexOf("# What you have"));
    expect(text.indexOf("# Using your computer well")).toBeLessThan(text.indexOf("# How you work"));
  });

  // Narzędzia komputera dostały refy (`read_page` zwraca drzewo elementów z
  // numerami), `find` i `actions` (kilka kroków jednym wywołaniem). Playbook,
  // który dalej każe otwierać stronę zrzutem, płaci ~40× więcej tokenów za to
  // samo kliknięcie i celuje w piksele zamiast w element.
  it("playbook prowadzi przez drzewo elementów i refy, nie przez zrzut", () => {
    const text = prompt(ALL);
    const playbook = text.slice(text.indexOf("# Using your computer well"), text.indexOf("# How you work"));
    expect(playbook).toContain("Start any browser task with `read_page`");
    expect(playbook).toContain("`find`");
    expect(playbook).toContain("Act by ref");
    expect(playbook).toContain("`actions`");
    expect(playbook).toContain("Refs die when the document changes");
    // zrzut zostaje — ale jako ostateczność (canvas, pdf, wygląd), nie jako wejście
    expect(playbook).toContain("`screenshot` is the expensive tool and the last resort");
    expect(playbook).not.toContain("Start any browser task with `screenshot`");
    expect(playbook).not.toContain("screenshotting as you go");
  });

  // Spis narzędzi generuje `connectionsBlock` z tego, co harness zamontował.
  // Druga, wpisana ręcznie lista rozjeżdża się z nim po cichu (find/actions).
  it("prompt nie wylicza narzędzi komputera drugi raz z ręki", () => {
    const text = prompt(ALL);
    expect(text).not.toContain("navigate, screenshot, read_page, click, move, type_text, key, scroll, status");
    expect(text).not.toContain("Take a screenshot or read_page first");
    // lista z rzeczywistych narzędzi tury zostaje
    expect(text).toContain("- mcp__computer: screenshot, navigate");
  });

  // Produkcja to Termux na Androidzie bez roota, dev bywa Debianem w kontenerze
  // (`hosted-computer.ts::BACKEND`). Playbook NIE MOŻE wybrać jednej z nich za
  // bota — wpisana na sztywno dystrybucja kłamie połowie floty.
  it("playbook nie zgaduje dystrybucji i podaje obie postacie maszyny", () => {
    const text = prompt(ALL);
    expect(text).toContain("Do not assume which Linux it is");
    expect(text).toContain("Termux on Android");
    expect(text).toContain("no `sudo` and no root at all");
    expect(text).toContain("`pkg`");
  });

  // Sygnatury narzędzi żyją w engine/server/computer_mcp.py i zmieniają się
  // osobno. Prompt powtarzający parametry rozjeżdża się z nimi po cichu.
  it("playbook nie powtarza parametrów narzędzi komputera", () => {
    const text = prompt(ALL);
    const playbook = text.slice(text.indexOf("# Using your computer well"), text.indexOf("# How you work"));
    // tylko jednoznaczne kawałki sygnatur — krótkie nazwy parametrów (`dy`,
    // `dx`) trafiają w zwykłe słowa ("already"), więc ich tu nie ma.
    for (const signature of ["(x, y", "x/y", "[[x", "(reason)", "CSS pixel", "deltaY"]) {
      expect(playbook).not.toContain(signature);
    }
  });

  it("bez komputera nie ma playbooka komputera", () => {
    const text = prompt({ agents: { command: "node" } });
    expect(text).not.toContain("# Using your computer well");
    expect(text).not.toContain("at least three genuinely different attempts");
  });

  it("playbook bez serwera agents nie każe wołać request_credential", () => {
    const text = prompt({ localComputer: { command: "py" } });
    expect(text).toContain("# Using your computer well");
    expect(text).not.toContain("request_credential");
    expect(text).toContain("say exactly which credential is missing");
  });

  it("routine halucynacja zablokowana — tylko create_routine, zero cloud", () => {
    const text = prompt(ALL);
    expect(text).toContain("create_routine");
    expect(text).toContain("never call ToolSearch, /schedule");
    expect(text).toContain("Routines are local MultiBot routines and persist on this server");
    expect(text).toContain("Do not use provider-private memory, external cloud schedules");
    // multibot: zmiana zdania = update/delete istniejącej rutyny, nie druga obok
    expect(text).toContain("do NOT create a second routine");
    expect(text).toContain("`update_routine`");
    expect(text).toContain("`delete_routine`");
  });

  // multibot: blok grupowy dokleja sie WYLACZNIE na turze grupowej — bez niego
  // kazdy czlonek odpowiada na wszystko i user dostaje N kopii tej samej
  // odpowiedzi.
  it("blok grupowy jest tylko na turze grupowej i niesie regule wyboru", () => {
    expect(prompt(ALL)).not.toContain("# This turn is a group chat");
    const text = prompt(ALL, {
      group: { name: "Ekipa", members: [{ name: "Atlas", description: "koordynacja" }, { name: "Researcher", description: "research" }] },
    });
    expect(text).toContain("# This turn is a group chat");
    expect(text).toContain("You are in group Ekipa with Atlas (koordynacja), Researcher (research).");
    expect(text).toContain("The user writes to the whole group.");
    expect(text).toContain("write one line handing it over with @Name and stop");
    expect(text).toContain("reply exactly [NO REPLY]");
    // multibot: hamulec na pętlę „confirmed / potwierdzone" — grzeczność nie
    // jest odpowiedzią, więc protokół każe na nią milczeć.
    expect(text).toContain("An acknowledgement, a thanks or restating an agreement");
    expect(text).toContain("Reply only with new information, a question you cannot proceed without, a result, or a handoff.");
    // A bot↔bot conversation has no length limit: it ends by silence, and the
    // protocol has to say so, or the bots keep each other talking forever.
    expect(text).toContain("It ENDS BY SILENCE.");
    expect(text).toContain("Do not ask a follow-up question unless you genuinely cannot proceed without the answer.");
    expect(text).not.toContain("keep asking back");
    expect(text).toContain("Write in the language the envelope asks for");
    expect(text).toContain("One owner per task; do not repeat what others said.");
  });

  // multibot: boty odmawiały zwykłej roboty (scrape publicznej strony, eksport
  // WŁASNYCH danych usera, ponowienia z backoffem) jednym zdaniem odmowy. Blok
  // stanowiska jest BEZWARUNKOWY — każdy sterownik dostaje ten sam prompt, więc
  // test przechodzi po tych samych zestawach integracji, co reszta pliku.
  it("stanowisko operacyjne jest w promptcie na każdej ścieżce sterownika", () => {
    const paths: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["pełny zestaw", ALL, {}],
      ["sam agents", { agents: { command: "node" } }, {}],
      ["sam komputer", { localComputer: { command: "py" } }, {}],
      ["agents + web", { agents: { command: "node" }, web: { command: "node" } }, {}],
      ["bez integracji", {}, {}],
      ["tura izolowana", ALL, { isolated: true }],
      ["tura grupowa", ALL, { group: { name: "Ekipa", members: [{ name: "Atlas" }] } }],
    ];
    for (const [name, integrations, extra] of paths) {
      const text = prompt(integrations, extra);
      expect(text, name).toContain("# Operating stance");
      expect(text, name).toContain("Be helpful by default.");
      expect(text, name).toContain("Ordinary automation is normal engineering");
      expect(text, name).toContain("Never answer with a bare refusal.");
      expect(text, name).toContain("say in ONE line what blocks it");
      expect(text, name).toContain("None of this asks you to deceive anyone or to act against other people");
      // blok NIE może rozluźniać potwierdzeń nieodwracalnych ani obiecywać pytania poza `ask_user`
      expect(text, name).toContain("the confirmation rules below still apply to irreversible actions");
      expect(text, name).toContain("ask one precise question through `ask_user` when you have it");
      // stanowisko stoi PRZED \"How you work\", żeby nie wygrywać świeżością z regułami zgody
      expect(text.indexOf("# Operating stance"), name).toBeLessThan(text.indexOf("# How you work"));
    }
    // tryb autonomiczny i standardowy dostęp zmieniają sekcję "How you work" — stanowisko zostaje
    for (const workspaceOverride of [{ autonomy: () => ({ autonomy: "autonomous" as const }) }, { access: () => ({ access: "standard" as const }) }]) {
      const text = prompt(ALL, { workspace: { ...workspace, ...workspaceOverride } });
      expect(text).toContain("# Operating stance");
      expect(text).toContain("Never answer with a bare refusal.");
    }
  });
});
