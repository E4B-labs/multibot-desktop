# MultiBot — developer handbook

MultiBot is an MIT-licensed self-hosted product.
Product-facing name is **MultiBot**. `openmausbot` and `.openmausbot` remain
internal compatibility identifiers so existing installs migrate safely.

The product combines: BYOK and local/custom models, CLI providers, bot
computers, routines, groups, memory, skills, MCP/Composio tools,
self-hosted Google Workspace (see [`docs/GOOGLE-WORKSPACE.md`](docs/GOOGLE-WORKSPACE.md)),
voice, PWA remote access, and Windows/Linux/Termux installers.
See [`docs/FEATURES.md`](docs/FEATURES.md) for the complete capability map and
[`docs/COMPARISON.md`](docs/COMPARISON.md) for the sourced comparison table.

Plan scalenia is historical local context only; repository docs are the source
of truth for current behavior.

## Dev (Windows / macOS / Linux)

```sh
pnpm install

# dwa procesy:
pnpm dev:server    # harness → https://127.0.0.1:8799 (self-signed, curl -k)
pnpm dev           # app     → http://127.0.0.1:5199
```

## Instalacja (Windows)

```sh
pnpm package:win     # → release/MultiBot-<wersja>-x64-setup.exe (NSIS, x64)
```

Instalator per-user (bez UAC, bez podpisu — SmartScreen pokaże ostrzeżenie).
Wozi UI i harness.

Po wybraniu w onboardingu serwera 24/7 aplikacja rejestruje per-user zadanie
`ONLOGON /RL LIMITED`. Zadanie uruchamia spakowaną aplikację z `--server-only`,
bez okna.

## VPS / Docker (self-host)

```sh
docker compose -f docker-compose.selfhost.yml up -d --build
# opcjonalnie: docker compose -f docker-compose.selfhost.yml logs -f app
```

Jedyny publikowany port to `127.0.0.1:8799` (uwierzytelniony harness + zbudowany
PWA), po HTTPS z certyfikatem z własnym podpisem — sprawdzenie:
`curl -k https://127.0.0.1:8799/api/health`. Odcisk certyfikatu jest w logu
startowym i w `GET /api/public/server`; szczegóły w `docs/REMOTE-ACCESS.md`.

Skrócona ścieżka bez Dockera (Linux/VPS, usługa użytkownika, bez sudo):

```sh
bash scripts/install-linux.sh
# plan bez zmian: bash scripts/install-linux.sh --dry-run
```

Usługa `systemd --user` ma `Restart=always`; instalator próbuje `loginctl
enable-linger`, aby start przeżył wylogowanie/restart. Po starcie instalator
czeka na `~/.openmausbot/setup.json` i drukuje trzy wartości (adres, nazwa
serwera, hasło serwera) — wpisz je w MultiBot na dowolnym urządzeniu →
`Sign in to a server`. W trybie Docker te same wartości są w
`docker compose -f docker-compose.selfhost.yml logs app`.

## Termux / Android

Instalacja bieżącego repozytorium uruchamia harness i PWA:

```sh
bash scripts/install-termux.sh
# plan bez zmian: bash scripts/install-termux.sh --dry-run
```

`termux-services` utrzymuje usługę, a skrypt Termux:Boot źródłuje
`$PREFIX/etc/profile.d/start-services.sh`, włącza `sv-enable multibot` i wykonuje
`termux-wake-lock`. Termux:Boot trzeba raz OTWORZYĆ, a Termuxowi wyłączyć
oszczędzanie baterii — o obu instalator przypomina na końcu, razem z trzema
wartościami z `~/.openmausbot/setup.json`. Instalator dopisuje też
`allow-external-apps=true` do `~/.termux/termux.properties`. Komputer bota na
Androidzie jest niedostępny; czat, memory, routines i skills działają.
HTTPS jest wbudowany (certyfikat z własnym podpisem, `docs/REMOTE-ACCESS.md`).

## G1–G5: funkcje aplikacji

- Harness MultiBota jest warstwą wspólną nad providerami.
- Provider picker pokazuje flotę CLI oraz nazwane modele `custom` (endpointy
  zgodne z OpenAI: Ollama, LM Studio, OpenRouter — driver `openaiCompatible`).
  Klucze modeli nigdy nie wracają w API. Własny model dodaje się w App Settings.
- Z poziomu czatu działa `/model`: `/model` pokazuje bieżący katalog,
  `/model claude/opus`, `/model codex/gpt-5.1-codex` albo `/model <model>
  --provider <provider>` przełącza parę provider + model dla bota.
- Memory, Skills, Routines, autonomia, permissions, usage i bot-to-bot są
  przechowywane przez harness per bot i wstrzykiwane do każdej tury niezależnie
  od wybranego providera. Computer pozostaje wspólnym narzędziem MCP/native.
- `/goal <cel>` gna bota w pętli wielu tur zamiast jednej odpowiedzi. Domyślnie
  dziesięć tur, a pozostałe budżety (250 kroków narzędziowych, 90 minut) są
  bezpiecznikiem przed urwaną pętlą, nie smyczą — mają tych dziesięciu tur nie
  uciąć. Zmieniane flagami (`--steps`, `--turns`, `--time`, `--resume` i reszta
  w `server/goals.ts`). Po drodze bot wspina się po drabinie: narzędzia, własny
  komputer, inni boci, podagenci — sięgnięcie po kolegę jest jego decyzją, nie
  wymaganym krokiem. Cel żyje w
  osobnym wątku `goal-<id>-<bot>`, stan trwały w `goals.json`, postęp widać
  pigułką w czacie, koniec markerem `[GOAL COMPLETE]`. Karty zgód na tym wątku
  nie są widoczne w głównym czacie — `--ask` działa na poziomie promptu, nie
  jako twarda blokada.
- Pokoje współpracy (`server/rooms.ts`) to chwilowe rozmowy bot-do-bota. Bot
  otwiera je sam narzędziem `start_collab`, albo powstają, gdy użytkownik
  wspomni drugiego bota (`@nazwa`) w zadaniu. Pokój jest tylko do odczytu, żyje
  w pamięci, gaśnie 5 minut po ostatniej wiadomości (twardy limit 20 minut),
  a podsumowanie wraca do czatu bota, który go założył.
- App Settings ma modele custom, przełączniki `allow` dla CLI,
  token dostępu i rotację tokena. Dostęp HTTP/WS wymaga Bearer tokena (poza
  health i statycznym ekranem logowania).
- Onboarding skanuje urządzenie, pyta o serwer 24/7, pokazuje postęp instalacji,
  wykrywa/instaluje CLI (Claude Code, Codex, Gemini, Kimi Code, Qwen Code),
  zbiera profil i opcjonalny model custom.
- PWA (`public/manifest.webmanifest`, `public/sw.js`) cache’uje tylko shell i
  fingerprinted assets. `/api`, SSE i dane są zawsze pobierane z sieci. Po
  zwykłym HTTP w LAN dyktowanie i instalacja PWA są ograniczone; użyj localhost
  albo HTTPS/Tailscale.

## Testy

```sh
pnpm test                       # vitest harnessa
pnpm typecheck && pnpm build    # harness + frontend
node scripts/selfhost-check.mjs # offline check installerów, bez usług
```

## Higiena upstream

`git fetch upstream && git merge upstream/main`. Zmiany w plikach upstreamu
wyłącznie małymi addytywnymi blokami znaczonymi `// multibot:`; nowe pliki bez
kolizji.
