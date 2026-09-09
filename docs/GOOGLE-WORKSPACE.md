# Google Workspace (Gmail / Drive / Calendar / Docs / Sheets / …)

MultiBot używa samohostowanego serwera MCP [`workspace-mcp`]
(https://github.com/taylorwilsdon/google_workspace_mcp, MIT) — pakietu z PyPI,
instalowanego na hoście. Jeden serwer daje 120+ narzędzi Google całej flocie
botów, bo rozprowadzanie idzie istniejącym mechanizmem konektorów
(`mcpConnectors` w `config.json`): harness montuje go jako serwer stdio.

Dane nie przechodzą przez żaden SaaS: serwer gada tylko z API Google, na
poziomie konta właściciela, na jego własnym kliencie OAuth.

## Instalacja

1. **Serwer** (raz, na hoście, na którym chodzi MultiBot):

   ```
   pipx install workspace-mcp
   ```

   `workspace-mcp` to pakiet Pythona. Mieszkał w venvie silnika Hermesa; po
   jego usunięciu MultiBot szuka go po prostu na PATH — tej samej ścieżce,
   którą widzą pozostałe CLI (`augmentedPath()`). Liczy się więc każda
   instalacja, która wystawia skrypt na PATH: `pipx`, `uv tool install`,
   `pip install --user`, własny venv dodany do PATH. Kod:
   `server/google-workspace.ts` (`workspaceMcpBin()`, `installHint()`).

   Panel Wtyczki → Google Workspace pokazuje status i gotową komendę, gdy
   serwera brakuje.

   Termux/Android: budowanie zależności Rusta wymaga `rust-std-aarch64-linux-android`
   (`pkg install rust rust-std-aarch64-linux-android`) oraz `ANDROID_API_LEVEL`
   ustawionego na `getprop ro.build.version.sdk` przy `pip install`.

2. **Klient OAuth w Google Cloud** (raz):
   - console.cloud.google.com → nowy projekt (lub istniejący),
   - APIs & Services → Library → włącz **Gmail API**, **Google Drive API**,
     **Google Calendar API** (+ Docs/Sheets/Slides, jeśli używane),
   - APIs & Services → Credentials → **Create credentials → OAuth client ID** →
     typ **Desktop app** (redirect na localhost jest dozwolony z dowolnym
     portem),
   - skopiuj **Client ID** i **Client Secret**.

3. **Konektor**: Wtyczki → Google Workspace → wklej Client ID + Secret →
   „Zainstaluj konektor".

## Logowanie (raz, w czacie)

OAuth jest prowadzony przez bota. Pierwsze wywołanie narzędzia Google bez
tokena zwraca tekst **„ACTION REQUIRED: Google Authentication Needed"** z URL-em
autoryzacji — bot pokazuje link w czacie. Klikasz, zgadzasz się na uprawnienia,
Google wraca na `localhost:8000` (serwer callbacku wstaje tylko na czas logowania)
i prosisz bota o ponowną próbę.

Token ląduje we wspólnym katalogu (`~/.multibot/google-workspace-credentials`,
nadpisywalny `WORKSPACE_MCP_CREDENTIALS_DIR`) i **wszystkie boty na hoście
dzielą to samo logowanie** — bez re-login. Wiele kont Google = duplikat
konektora z osobnym katalogiem credentials.

## Zakres narzędzi

Domyślnie `--tool-tier complete` (wszystkie usługi). Zawężenie per bot przez
Tool rules w ustawieniach bota; zawężenie globalne — edycja argumentów
konektora (`--tools gmail drive calendar`, `--read-only`).

⚠️ Prompt injection: e-maile/dokumenty mogą zawierać wrogie instrukcje.
Tryb complete daje botowi też narzędzia zapisu (wysyłka maila, udostępnianie
plików) — trzymaj boty z Google na trybie approval (pytaj o zgodę), nie
autonomicznym, i rozważ `--read-only` dla botów pracujących na wrogich danych.

## Ekonomia RAM (Telefon)

Każdy bot spawnuje własny proces stdio serwera. 121 narzędzi ≈ ~150–250 MB
na proces. Na telefonie z wieloma botami rozważ tier `core`
albo `--tools gmail drive calendar` w argumencie konektora.

## Trasy

- `GET /api/connectors/google-workspace` — status (installed/configured/connected)
- `PUT /api/connectors/google-workspace` — zapis (`{clientId, clientSecret}`)
- `DELETE /api/connectors/google-workspace/credentials` — wylogowanie (kasuje tokeny)
