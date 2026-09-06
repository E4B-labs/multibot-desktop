# Architektura MultiBot

Mapa dla kogoś, kto ma zaraz coś tu zmienić: co z czym gada, gdzie leżą dane,
czego nie wolno ruszyć bez decyzji właściciela i gdzie dwie gałęzie zderzą się
najszybciej.

## 1. Dwa procesy

Dwa osobne procesy ustawione w linię:

1. **Harness (Node)** — słucha na `:8799` (`OMB_PORT`, historycznie `OGB_PORT`).
   To jedyna granica sieciowa całego produktu: wszystko za nią chodzi po
   loopbacku. Wszystko przed nią wymaga tokenu Bearer.
2. **UI (React + Vite, PWA)** — gada wyłącznie z `/api` harnessu. Klient nie ma
   własnych transportów do dostawców; wszystkie procesy providerów należą do
   harnessu.

Aplikacja desktopowa (Electron) pakuje harness razem z UI: spakowany serwer
serwuje też zbudowany frontend, a okno wchodzi na `:8799`.

## 2. Katalogi

### `src/` — UI

React 19, Vite 7, Tailwind 4. Stan trzyma jeden `src/state/store.tsx`:
`useReducer` plus Context, bez zewnętrznej biblioteki. Jeden kanał zdarzeń:
`/api/events` — WebSocket jako transport pierwszego wyboru, a przy pośredniku,
który go nie przepuszcza (albo w środowisku bez WebSocketa), kanał schodzi na
SSE i działa dalej (`src/lib/auth.ts`).

Interfejs jest dwujęzyczny PL/EN i robi to wprost w JSX, wzorcem
`{polish ? … : …}`. Nie ma plików tłumaczeń ani biblioteki i18n — nowy tekst
dopisuje się w obu językach w tym samym miejscu.

### `server/` — harness

Czysty `node:http`, bez frameworka. Cały routing HTTP siedzi w jednym
`server/index.ts`. Sterowniki dostawców w `server/drivers/`: `claude`, `codex`,
`grok`, `openaiCompatible` oraz sterowniki ACP w `server/drivers/acp/`
(`gemini`, `grok`, `kimi`, `opencode`, `qwen`). Obok tego `server/harness/` —
rejestr instancji (`registry.ts`) i magistrala zdarzeń (`bus.ts`).

### `electron/`, `scripts/`, `docs/`

Powłoka desktopowa i aktualizator; narzędzia budowania i pakowania;
dokumentacja, w tym ten plik.

## 3. Dane

Nie ma bazy danych, nie ma ORM, nie ma migracji. Stan leży w plikach JSON w
katalogu danych wyznaczanym przez `server/config.ts`: `OMB_DATA_DIR`, a w braku
zmiennej `~/.openmausbot` (ze ścieżką migracyjną ze starego `~/.opengrokbot`).
Katalog i `config.json` dostają zawężone uprawnienia.

Konsekwencja dla pracy: **nie ma bramki migracyjnej do przejścia** — nie ma
czego uruchomić przed wdrożeniem. Ale działa to też w drugą stronę: zmiana
kształtu zapisanych danych jest zmianą łamiącą dla każdego istniejącego
użytkownika, bo nikt tych plików nie przepisze automatycznie. Stąd reguła z
sekcji 5.

## 4. Uwierzytelnianie

Jedna szyna: identity v2 w `server/identity.ts` (SQLite `identity.db`, hasła
scryptem, role owner/member). Poświadczeniem jest cookie sesji `mb_v2_session`
albo krótko żyjący token dostępu — w nagłówku `Authorization: Bearer`, w
subprotokole WebSocketa `multibot-v2` lub, wyłącznie dla ekranu komputera, w
`?token=`. `server/auth.ts` to jedna bramka: publiczna allowlista → aktor z
identity → 401. Nie ma tokenu instalacyjnego, logowania Google ani parowania
QR — niezalogowany dostaje 401, nigdy 426.

**Nie ma żadnej warstwy płatności ani rozliczeń.** Słowo `billing` w kodzie
dotyczy wyłącznie rozliczeń cudzych usług: pauzowania sandboxa u zewnętrznego
dostawcy (`server/box.ts`), przełączania subskrypcji CLI na pay-as-you-go
(`server/drivers/codex.ts`, `server/drivers/acp/grok.ts`) i wpisu Stripe w
katalogu konektorów Composio (`server/composio.ts`). Nie szukaj checkoutu,
planów ani limitów — ich tu nie ma.

## 5. `server/contracts.ts` — nietykalny

218 linii z kanonicznymi kształtami danych i SPI sterowników:
`InstanceConfig`, `ModelSelection`, identyfikatory instancji/wątków/tur,
znormalizowane zdarzenia runtime.

**Bez wyraźnej decyzji właściciela tego pliku się nie zmienia.** Powód jest
podwójny. Po pierwsze, na tych kształtach zgadza się każdy sterownik i UI —
jedna zmiana pola rozjeżdża wszystkie naraz. Po drugie, w tych samych
kształtach zapisane są dane użytkowników na dysku (sekcja 3), więc zmiana
typu to nie refaktor, tylko zmiana formatu zapisu bez ścieżki migracji.

Konfiguracja instancji jest celowo tolerancyjna: `driver` to dowolny slug,
niewalidowany przeciw liście znanych sterowników — konfiguracja z nowszego
builda przechodzi tam i z powrotem i degraduje się bezpiecznie.

## 6. Punkty kolizji

Pliki, na których dwie równoległe gałęzie najszybciej się zderzą:

| Plik | Linie | Co to jest |
| --- | --- | --- |
| `server/index.ts` | 4735 | Cały routing HTTP harnessu w jednym pliku |
| `src/components/BlobAvatar.tsx` | 2709 | Duży komponent UI |
| `src/components/Sidebar.tsx` | 1354 | Nawigacja |
| `src/state/store.tsx` | 1119 | Jeden reducer na cały stan aplikacji |

Wprost: **dwie gałęzie edytujące naraz `server/index.ts` to najbardziej
prawdopodobny konflikt w tym repo.** Nowa trasa HTTP prawie zawsze ląduje w tym
pliku, więc równoległe zadania trafiają w te same okolice. Ustalcie kolejność,
zanim ktokolwiek zacznie — zasady w [BRANCHING.md](BRANCHING.md).

## 7. Testy

`pnpm test` (`vitest run`) to jedyny runner testów w repo: **~114 plików
testowych**. Liczba 109 z wcześniejszego audytu brała się z policzenia plików
`*.test.*` w drzewie — pięć z nich to martwe testy Electrona pod `node:test`,
których vitest w ogóle nie wciąga (niżej).

Suita vitest chodzi bez równoległości plików (`fileParallelism: false`), bo
odpala udawane CLI providerów i prawdziwy serwer harnessu.

**Znany dług: pięciu testów Electrona nie odpala nikt.** `vite.config.ts`
wciąga z katalogu `electron/` tylko trzy pliki: `single-instance`,
`window-state`, `diagnostics`. Pozostałe pięć — `gpu`,
`hardware-acceleration`, `host-resolve`, `remote-ui`, `updater` — jest
napisanych pod runner `node:test` i nie ma ani w vitest, ani w żadnym zadaniu
CI. Są w repo, wyglądają na pokrycie, a nie chronią przed niczym. Szczegóły i
reszta długu: [REPO_STATE.md](REPO_STATE.md).
