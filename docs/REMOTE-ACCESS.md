# Zdalny dostęp i wspólny serwer MultiBot

Docelowy układ: MultiBot Server działa stale na S10e w Termuxie. Desktopowa i mobilna aplikacja są klientami. Każdy klient wpisuje publiczny adres HTTPS serwera, zakłada profil albo loguje się na istniejący profil.

## Model dostępu

- jeden serwer i jedna baza SQLite;
- konto użytkownika: `username`, hasło profilu, wyświetlana nazwa;
- serwer ma własną nazwę i osobne hasło wejścia;
- hasło serwera potrzebne jest tylko przy tworzeniu serwera i rejestracji nowego profilu;
- logowanie tworzy sesję HTTP oraz krótkotrwały token API;
- token nie jest pokazywany w UI ani logach;
- odzyskiwanie konta używa jednorazowego kodu recovery pokazanego po rejestracji;
- prywatny bot widoczny jest wyłącznie właścicielowi;
- bot teamowy i sekcje teamowe widoczne są wszystkim członkom serwera;
- pamięć prywatnego bota nie jest dostępna innym botom ani użytkownikom;
- pamięć bota teamowego oraz wspólna pamięć workspace są współdzielone zgodnie z ACL.

## Onboarding

### Utwórz serwer

1. Uruchom serwer MultiBot na S10e.
2. Upewnij się, że adres jest osiągalny z internetu przez HTTPS.
3. W aplikacji wybierz `Set up server`.
4. Podaj: adres serwera, nazwę serwera, hasło serwera, nazwę użytkownika i hasło profilu.
5. Instalacja zapisze konfigurację serwera i utworzy pierwszy profil.

Setup serwera jest dozwolony wyłącznie z loopbacka urządzenia hostującego. Jeśli aplikacja łączy się przez publiczny adres, najpierw wykonaj lokalny setup albo użyj instalatora serwera.

### Dołącz do serwera

1. Wybierz `Sign in`, jeśli profil już istnieje.
2. Wybierz `New profile`, jeśli tworzysz własne konto.
3. Podaj publiczny adres HTTPS.
4. Przy rejestracji podaj hasło serwera, nazwę użytkownika, hasło profilu i opcjonalną nazwę wyświetlaną.

Nie ma QR, Tailscale, WireGuard ani ręcznego wklejania tokenu w normalnym flow.

## Publiczny HTTPS

Serwer lokalny nasłuchuje domyślnie na porcie `8799`. Do publicznego dostępu postaw zaufane reverse proxy z poprawnym certyfikatem HTTPS wskazujące na `http://127.0.0.1:8799`.

Przed udostępnieniem adresu sprawdź:

```bash
curl -i https://PUBLIC_HOST/api/public/server
curl -i https://PUBLIC_HOST/api/bots
```

`/api/public/server` jest publiczne. `/api/bots` bez sesji musi zwracać `401`.

## Protokół v2

Nowi klienci wysyłają `x-multibot-protocol: 2`, a WebSocket używa subprotocolu `multibot-v2`. Stare szyny logowania (bearer `auth.token`, Firebase, parowanie QR) są skasowane: każde żądanie bez sesji albo tokenu dostępu identity dostaje `401`, nigdy `426`.

Najważniejsze endpointy:

- `GET /api/public/server` — status konfiguracji serwera;
- `POST /api/setup/server` — lokalna inicjalizacja serwera;
- `POST /api/auth/register` — nowe konto;
- `POST /api/auth/login` — logowanie;
- `POST /api/auth/recover` — odzyskanie konta kodem recovery;
- `POST /api/auth/session` — wymiana tokenu na sesję cookie;
- `POST /api/auth/logout` — unieważnienie bieżącej sesji;
- `GET /api/profile` — własny profil;
- `GET /api/server` — nazwa i publiczne dane serwera;
- `GET /api/server/members` — członkowie serwera;
- `GET /api/workspace` — workspace, członkowie i bieżący użytkownik;
- `GET /api/bots` — boty zgodne z ACL;
- `GET /api/events` — zdarzenia zgodne z ACL.

## Bezpieczeństwo

- hasła są haszowane scryptem, nigdy nie są przechowywane jawnie;
- sesja cookie ma `HttpOnly`, `SameSite=Strict` oraz `Secure` przy HTTPS;
- token API jest krótko ważny i może być odświeżony przez sesję;
- logowanie, rejestracja, recovery i setup mają rate limit;
- prywatne boty są filtrowane na serwerze, nie tylko w UI;
- wiadomości, mail, grupy, pokoje, wyszukiwanie i zdarzenia stosują ACL;
- prywatne boty nie mogą używać trybu automatycznej komunikacji ani Full Access;
- odpowiedzi API nie zawierają haseł, tokenów ani kodów recovery po pierwszym pokazaniu;
- SQLite i sekrety pozostają na serwerze S10e; nie commituj katalogu danych;
- publiczne repo nie może zawierać `.env`, `identity.db`, tokenów Cloudflare, kluczy API ani transcriptów z danymi prywatnymi.

## S10e / Termux

Uruchom usługę serwera przez `runit`/`termux-services`, ustaw autostart i wyłącz agresywne oszczędzanie baterii dla Termuxa. Przechowuj dane w katalogu wskazanym przez `OMB_DATA_DIR`; nie używaj katalogu repo jako magazynu sekretów.

Instalatory:

- `scripts/install-termux.sh` — instalacja na S10e;
- `scripts/install-server-windows.mjs` — przygotowanie serwera na Windows;
- `scripts/selfhost-check.mjs` — sprawdzenie instrukcji i konfiguracji self-hostingu.

## Aktualizacje

Aktualizacja aplikacji desktopowej korzysta z publicznych artefaktów release repo `E4B-labs/multibot-desktop-releases`: `latest.yml`, instalator i blockmap. Feed nie może zawierać `releases.atom`, znaków nowej linii ani komunikatu błędu GitHub.

Przed wydaniem:

```powershell
$env:TEMP='D:\tmp'
$env:TMP='D:\tmp'
$env:ELECTRON_BUILDER_CACHE='D:\electron-builder-cache'
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.server.build.json
pnpm exec vitest run
pnpm vite build
pnpm package:win
```

Nie publikuj release bez ręcznego sprawdzenia artefaktów i numeru wersji.
