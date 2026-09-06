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

1. Uruchom instalator na urządzeniu, które ma być serwerem (`scripts/install-termux.sh`, `scripts/install-linux.sh`, `scripts/install-server-windows.mjs` albo `docker compose -f docker-compose.selfhost.yml up -d --build`).
2. Serwer konfiguruje się sam na pierwszym boocie i drukuje trzy wartości — patrz niżej.
3. W aplikacji wybierz `Sign in to a server`, wpisz te trzy wartości i załóż pierwszy profil. Pierwszy profil jest właścicielem.

### Pierwszy boot drukuje trzy wartości

Serwer, do którego nikt jeszcze nie dołączył, sam sobie nadaje nazwę (slug w rodzaju `brave-otter`) i losuje hasło serwera. Zapisuje je razem z adresem i odciskiem certyfikatu do `DATA_DIR/setup.json` (0600, domyślnie `~/.openmausbot/setup.json`) i pokazuje na konsoli. Hasło leci na stdout **tylko na prawdziwym terminalu**: pod `svlogger`, systemd czy `docker logs` stdout jest plikiem, który zostaje na zawsze, więc harness drukuje tam wyłącznie ścieżkę do pliku.

Dlatego wartości pokazują instalatory, po starcie usługi:

- `install-termux.sh` i `install-linux.sh` czekają na `setup.json` (do 30 s) i drukują blok `Address / Name / Password / Fingerprint` przez `scripts/print-setup-values.sh`;
- kontener NIE dostaje ich do logu (ten zostaje na zawsze): `scripts/docker-entrypoint.sh` wypisuje tylko ścieżkę i komendę `docker compose -f docker-compose.selfhost.yml exec app cat /data/.openmausbot/setup.json`;
- `install-server-windows.mjs` czyta ten sam plik po `waitForServer`; ta usługa stoi na pętli zwrotnej, więc jej adres to `https://127.0.0.1:8799` (do sieci wypuszcza ją dopiero `OMB_HOST=0.0.0.0` albo reverse proxy).

Kończy się to jedną instrukcją: **wpisz te trzy wartości w MultiBot na dowolnym urządzeniu → `Sign in to a server`**. Gdy `setup.json` nie ma, instalator drukuje sam adres i mówi, że albo serwer ma już profil (zaloguj się na niego), albo nie wystartował (sprawdź log usługi) — z zewnątrz jedno od drugiego nie do odróżnienia. Hasło serwera rotuje potem właściciel z panelu.

### Dołącz do serwera

1. Wybierz `Sign in`, jeśli profil już istnieje.
2. Wybierz `New profile`, jeśli tworzysz własne konto.
3. Podaj publiczny adres HTTPS.
4. Przy rejestracji podaj hasło serwera, nazwę użytkownika, hasło profilu i opcjonalną nazwę wyświetlaną.

Nie ma QR, Tailscale, WireGuard ani ręcznego wklejania tokenu w normalnym flow.

## HTTPS

Od 0.4.0 harness słucha **wyłącznie po HTTPS**, na porcie `8799`. Domyślnie nasłuchuje na pętli zwrotnej — wyjście do sieci to świadoma decyzja (`OMB_HOST=0.0.0.0`, tak robią `scripts/install-linux.sh` i `scripts/install-termux.sh`). Certyfikat wystawia sobie sam na pierwszym boocie: klucz P-256 i X.509 na 10 lat w `DATA_DIR/tls.key` (0600, na Windowsie dodatkowo `icacls`) i `DATA_DIR/tls.crt`, z SAN-em obejmującym adresy IP tej maszyny z chwili wystawienia oraz `localhost`. Odcisk SHA-256 idzie do logu startowego, do `setup.json`, do `GET /api/public/server`, `GET /api/setup/values` i `GET /api/server`.

Certyfikat nie ma urzędu, który by go potwierdził, więc zaufanie działa jak w SSH: klient zapamiętuje odcisk przy pierwszym połączeniu i pilnuje go potem (desktop robi to sam, `electron/tls-pin.mjs`; przeglądarka pokazuje ostrzeżenie raz na profil). **Zmiana odcisku to twardy błąd**, nie cicha zgoda.

Dlatego certyfikat jest wystawiany RAZ i nie wymienia się sam. Nowy powstaje tylko wtedy, gdy pliku nie da się wczytać, klucz nie pasuje do certyfikatu albo certyfikat wygasł. Zmiana adresów maszyny (DHCP, VPN, `docker0`, tymczasowe IPv6) NIE jest powodem — przypięty klient patrzy na odcisk, nie na SAN, a wymiana zrywałaby zaufanie u wszystkich naraz. Skutek uboczny: pod adresem spoza SAN-u przeglądarka doda do swojego ostrzeżenia „niezgodna nazwa" — to to samo okno, które i tak pokazuje dla certyfikatu z własnym podpisem. Kto chce certyfikat na nowy adres: skasować `tls.key` i `tls.crt` i zrestartować serwer (wszyscy klienci będą musieli zaufać na nowo).

**Service worker** (tryb offline PWA) rejestruje się dopiero na originie, któremu przeglądarka ufa. Dopóki użytkownik nie zaakceptuje certyfikatu, `navigator.serviceWorker.register` odrzuca — aplikacja działa normalnie, tylko bez cache'u offline (`src/main.tsx` łapie ten błąd i wpisuje go do konsoli jako `info`).

Sprawdzenie z zewnątrz (`-k`, bo certyfikat jest z własnym podpisem — odcisk porównaj z tym z logu):

```bash
curl -k -i https://PUBLIC_HOST:8799/api/public/server
curl -k -i https://PUBLIC_HOST:8799/api/bots
openssl s_client -connect PUBLIC_HOST:8799 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 -text | grep -A1 "Subject Alternative Name"
```

### Relay box, którego jesteś właścicielem

Router bez UPnP, bez NAT-PMP, bez panelu i bez IPv6 nie da się otworzyć — drabina adresów z `server/net-address.ts` nie ma wtedy czego znaleźć. Wyjściem, które NIE oddaje ruchu obcej firmie, jest własna maszyna z publicznym IP: serwer sam dzwoni do niej `ssh -R`, a ona wystawia port `8799` na świat.

TLS zostaje **od końca do końca**. Relay przepuszcza czysty TCP, więc certyfikat, który klient przypina, to nadal certyfikat tego serwera — odcisk się nie zmienia, a relay widzi wyłącznie szyfrogram i nigdy nie trzyma żadnego klucza.

Trzy kroki:

1. **Weź maszynę z publicznym IP.** Dowolny VPS. Za darmo: Oracle Cloud Always Free (ARM Ampere, 4 rdzenie / 24 GB, bez limitu czasu).
2. **Na serwerze MultiBota** uruchom `sh scripts/relay-connect.sh <IP-relaya>`. Skrypt tworzy `~/.openmausbot/relay_key` (ed25519, bez hasła), zapisuje `~/.openmausbot/relay.env`, instaluje usługę (`mb-relay` w runicie na Termuksie, `mb-relay.service` w systemd na Linuksie) i **drukuje klucz publiczny razem z gotową komendą do wklejenia**.
3. **Na relayu**, jako root, wklej komendę wydrukowaną w kroku 2 — `relay-setup.sh` nie musi tam wcześniej być, bo komenda pobiera go prosto z repo:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/E4B-labs/multibot-desktop/main/scripts/relay-setup.sh      | sudo sh -s -- 'ssh-ed25519 AAAA... multibot-relay' 8799
   ```

   Skrypt zakłada użytkownika `mbrelay` bez powłoki, który umie dokładnie jedno: trzymać tunel na tym jednym porcie. W `authorized_keys` idzie `command="echo relay only",restrict,port-forwarding,permitlisten="8799"`. Zakaz przekierowania lokalnego (`-L`, czyli użycie relaya jako jump hosta) siedzi w `/etc/ssh/sshd_config.d/10-mbrelay.conf`, w bloku `Match User mbrelay` — `AllowTcpForwarding remote`, `AllowStreamLocalForwarding no`, `AllowAgentForwarding no`, `PermitTTY no`, `X11Forwarding no`, `GatewayPorts clientspecified`. Nic z tego nie jest globalne, więc żadne inne konto na tej maszynie nic nie zyskuje. `ClientAliveInterval 30` zostaje globalnie, bo w `Match` nie jest legalne. Do tego otwarcie TCP 8799 (ufw / nftables / iptables) i przeładowanie sshd po `sshd -t`.

   Wymaga OpenSSH 7.8+ — na starszym `permitlisten` bywa po cichu ignorowane, więc skrypt odmawia zamiast zbudować coś słabszego, niż wygląda. Port jest parametrem (`$2`), nie stałą.

**Adres serwera to od tej chwili `https://<IP-relaya>:8799`.** Harness stawia go na szczycie drabiny jako rodzaj `relay` i podaje w `GET /api/server/address` (`current`) oraz `GET /api/server` (`publicAddress`). `OMB_PUBLIC_URL` nadal wygrywa, jeśli ktoś je ustawił.

`setup.json` **nie jest przepisywany**: powstaje raz, na pierwszym boocie serwera, i zostaje z adresem z tamtej chwili. Jeśli relay stanął później, plik nadal pokazuje stary adres — aktualny bierz z panelu albo z `GET /api/server`. Nazwa, hasło i odcisk certyfikatu są w obu miejscach te same i **nie zmieniają się**: certyfikat nie jest wymieniany, więc kto już zaufał serwerowi po LAN-ie, nie musi robić nic ponownie.

Adres relaya jako jedyny nie może zostać potwierdzony przez `noteReachedHost` — ruch wychodzi z tunelu jako połączenie z `127.0.0.1`, więc nie ma publicznego rozmówcy, od którego dałoby się czegokolwiek dowiedzieć. Zamiast tego serwer sprawdza się sam przy każdym skanie: łączy się po TLS na publiczny port relaya i patrzy, czy wraca **jego własny certyfikat** (`probeRelay`, 2 s). To rozstrzyga trzy rzeczy naraz — tunel stoi, wychodzi na ten proces i nikt inny nie zajął tego portu — i jest mocniejsze niż porównanie `serverId`, bo tego uścisku dłoni nie dokończy nikt bez naszego klucza prywatnego. Panel pokazuje po tym prawdziwe UP/DOWN, a nie „nie sprawdziliśmy".

Sprawdzenie: `sh scripts/relay-check.sh`. Pobiera `/api/public/server` przez relay i porównuje `serverId` z tym, co ta maszyna odpowiada po pętli zwrotnej — `ss`/`netstat` na serwerze pokazałoby tylko wychodzące ssh, które wstaje długo przed tym, zanim przekierowanie zacznie działać.

Pułapki:

- **Chmura ma drugi firewall.** Na Oracle Cloud (i na AWS, i na GCP) `ufw` to połowa roboty: trzeba jeszcze dopisać regułę wejściową 0.0.0.0/0 TCP 8799 w Security List / Network Security Group VCN-u, inaczej pakiet nie dojdzie do maszyny.
- Nazwa DNS zamiast IP jest opcjonalna i działa tak samo: wskaż rekord A na relay i podaj nazwę zamiast adresu.
- Tunel podnosi się sam z backoffem 5→60 s. Restart: `sv restart mb-relay` (Termux) albo `systemctl --user restart mb-relay` (Linux) — **nigdy `pkill` po nazwie**, na telefonie to zabija serwer tmuksa razem z resztą.

### Reverse proxy przed harnessem

Proxy z certyfikatem od prawdziwego urzędu jest opcją, nie wymogiem. Jeśli je stawiasz, to **ono kończy TLS**, a do harnessa idzie po pętli zwrotnej gołym HTTP:

```
OMB_HOST=127.0.0.1 OMB_TLS=off
```

To JEDYNY wspierany sposób na `OMB_TLS=off`: przy `OMB_HOST` spoza pętli zwrotnej serwer **odmawia startu**, zamiast cicho wystawiać hasła gołym tekstem. Proxy ma dokładać `X-Forwarded-Proto: https` — po tym nagłówku serwer wie, że sesja jedzie po TLS, i dopina ciasteczku `Secure`; nagłówek liczy się wyłącznie od klienta z pętli zwrotnej, czyli od proxy stojącego na tej samej maszynie.

`/api/public/server` jest publiczne. `/api/bots` bez sesji musi zwracać `401`.

## Protokół v2

Nowi klienci wysyłają `x-multibot-protocol: 2`, a WebSocket używa subprotocolu `multibot-v2`. Stare szyny logowania (bearer `auth.token`, Firebase, parowanie QR) są skasowane: każde żądanie bez sesji albo tokenu dostępu identity dostaje `401`, nigdy `426`.

Najważniejsze endpointy:

- `GET /api/public/server` — status konfiguracji serwera;
- `GET /api/setup/values` — trzy wartości z `setup.json`; wymaga nagłówka `x-multibot-setup: <setupToken>` z tego samego pliku (sama pętla zwrotna nie wystarcza, bo na Androidzie nie jest per-aplikacja) i odpowiada tylko dopóki nie ma profilu;
- `POST /api/auth/join` — nazwa + hasło serwera w zamian za `joinGrant`;
- `POST /api/auth/register` — nowe konto;
- `POST /api/auth/login` — logowanie;
- `POST /api/auth/recover` — odzyskanie konta kodem recovery;
- `POST /api/auth/session` — wymiana tokenu dostępu na sesję cookie;
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
- publiczne repo nie może zawierać `.env`, `identity.db`, tokenów, kluczy API ani transcriptów z danymi prywatnymi.

## S10e / Termux

Uruchom usługę serwera przez `runit`/`termux-services`, ustaw autostart i wyłącz agresywne oszczędzanie baterii dla Termuxa. Przechowuj dane w katalogu wskazanym przez `OMB_DATA_DIR`; nie używaj katalogu repo jako magazynu sekretów.

Instalatory:

- `scripts/install-termux.sh` — instalacja na S10e; dopisuje `allow-external-apps=true` do `~/.termux/termux.properties` (bez tego aplikacja nie zrestartuje serwera na tym telefonie) i przypomina o Termux:Boot oraz o wyłączeniu oszczędzania baterii dla Termuxa;
- `scripts/install-linux.sh` — usługa `systemd --user` albo Docker;
- `scripts/install-server-windows.mjs` — przygotowanie serwera na Windows;
- `scripts/print-setup-values.sh` — wspólny wypis trzech wartości z `setup.json`;
- `scripts/relay-connect.sh` — tunel `ssh -R` do własnego relaya; zakłada klucz, `relay.env` i usługę `mb-relay`;
- `scripts/relay-setup.sh` — jednorazowe przygotowanie relaya (użytkownik bez powłoki, `GatewayPorts`, firewall);
- `scripts/relay-check.sh` — czy tunel naprawdę niesie ruch (porównanie `serverId` przez relay i po pętli zwrotnej);
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
