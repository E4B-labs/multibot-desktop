# CLAUDE.md

MultiBot — self-hostowany workspace floty agentów AI. To repo (publiczne) trzyma
serwer (harness Node), interfejs webowy/PWA i aplikację desktopową Electron.
Aplikacja mobilna to osobne repo `E4B-labs/multibot-mobile`.

## Reguły

**Kanonem jest [`AGENTS.md`](AGENTS.md) — przeczytaj go w całości, zanim
dotkniesz kodu.** Ten plik jest adapterem dla Claude Code: dodaje mapę repo i
komendy deweloperskie, nie dodaje ani nie zmienia żadnej reguły. Jeśli
kiedykolwiek znajdziesz tu regułę sprzeczną z `AGENTS.md`, obowiązuje
`AGENTS.md`, a ta jest błędem do usunięcia.

Dokumentacja inżynierska: [`docs/engineering/`](docs/engineering/).

## Mapa repo

| Katalog | Co tam jest |
|---|---|
| `src/` | Interfejs: React 19 + Vite 7 + Tailwind v4 (motyw ciemny na sztywno), stan w useReducer+Context (`src/state/store.tsx`), jeden kanał zdarzeń `/api/events` (WebSocket → SSE fallback). UI dwujęzyczne PL/EN przez `{polish ? … : …}`. |
| `server/` | Harness Node: surowy `node:http` bez frameworka, cała obsługa HTTP w `server/index.ts`. Auth: identity v2 (`server/identity.ts`, SQLite `identity.db`, scrypt, role owner/member) — cookie sesji albo krótko żyjący token dostępu, jedna bramka w `server/auth.ts`. Drivery dostawców w `drivers/` (claude, codex, grok, agenty ACP, `openaiCompatible` = własne endpointy zgodne z OpenAI). Goals, rooms, routines, approvals, memory, skills, grupy, komputer bota, TTS. |
| `electron/` | Powłoka desktopowa: proces główny `main.mjs`, preload, IPC przez `window.ogb`, auto-update na vendored `vendor/electron-updater.cjs` (po budowaniu `git checkout --`). |
| `scripts/` | Instalatory linux/termux/windows, skrypty komputera bota. |
| `docs/` | `engineering/` (protokół), FEATURES, COMPARISON, REMOTE-ACCESS, GOOGLE-WORKSPACE. |

Kluczowe pliki: `server/index.ts` (endpointy HTTP), `server/contracts.ts`
(**kanoniczne kształty danych — zakaz zmian bez decyzji właściciela**),
`server/config.ts`, `src/App.tsx`, `src/state/store.tsx`.

## Architektura w pigułce

Dwa procesy: harness Node (:8799, jedyna granica sieciowa, wszystko za tokenem
Bearer) ← UI React/PWA. Desktop Electron wozi harness + UI w paczce. Bez
Pythona — cała logika botów (memory, skills, routines, grupy, komputer, TTS)
żyje w harnessie.

Prompt systemowy ma JEDNĄ ścieżkę: drivery dostają pole `system` z `sendTurn`.

Więcej: [`docs/engineering/ARCHITECTURE.md`](docs/engineering/ARCHITECTURE.md).

## Dev

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm dev:server    # harness → https://127.0.0.1:8799 (self-signed, curl -k)
pnpm dev           # app     → http://127.0.0.1:5199
```

Bramki przed pushem — dokładnie to, co uruchamia CI (`AGENTS.md` §5):

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm exec vite build
```

## Wydanie

Kanały, numeracja wersji i procedura paczkowania:
[`docs/engineering/RELEASE.md`](docs/engineering/RELEASE.md). Wydajesz wyłącznie
ten kanał, o który poprosił właściciel, i wyłącznie z `main` po merge'u PR-a.
