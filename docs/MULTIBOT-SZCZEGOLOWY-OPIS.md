# MultiBot — szczegółowy opis produktu

**Stan dokumentu:** 28 sierpnia 2026

**Wersja opisywana:** `0.2.1` + protokół tożsamości v2

**Repozytorium:** `E4B-labs/multibot-desktop`

**Licencja produktu:** MIT

**Status:** opis bieżącego kodu gałęzi wydaniowej. Kod aplikacji, aktualne
testy i konfiguracja builda są źródłem prawdy. Starsze notatki, plany i
historyczne opisy mogą opisywać zachowanie, które później zostało zmienione.

Ten dokument opisuje MultiBot na poziomie użytkownika, administratora serwera
i developera. Zawiera także ograniczenia, żeby nie przedstawiać funkcji
planowanych jako gotowych.

---

## 1. Czym jest MultiBot

MultiBot to samohostowany workspace dla floty nazwanych botów AI. Użytkownik
tworzy wiele botów, a dla każdego może ustawić osobny model, profil, pamięć,
umiejętności, narzędzia, harmonogram, poziom autonomii i uprawnienia.

Boty mogą działać osobno albo współpracować przez:

- delegowanie zadania do innego bota;
- trwały agent mail między konkretnymi botami;
- pokoje współpracy bot-do-bota;
- grupy z wieloma botami;
- mapę zespołu pokazującą sekcje, chiefs i stan pracy.

MultiBot nie jest hostowaną usługą z własnymi modelami. Operator uruchamia
serwer u siebie, dostarcza klucze lub logowania do providerów i sam kontroluje
dane, urządzenia, dostęp sieciowy oraz koszty providerów.

Najważniejsze elementy produktu:

- frontend React 19 + TypeScript + Vite;
- desktop Electron;
- uwierzytelniony Node.js harness w `server/`;
- PWA do używania z telefonu i przeglądarki;
- instalatory Windows, Linux/Docker i Android/Termux.

Harness jest granicą sieciową. Cały stan workspace przechodzi przez niego i to
on decyduje, co jest wystawione na zewnątrz.

---

## 2. Model mentalny aplikacji

W MultiBocie występują cztery poziomy:

### 2.1. Instalacja

Instalacja to konkretne urządzenie i jego lokalny katalog danych. Na instalacji
znajdują się konfiguracja, token dostępu, profile botów, transcript, pamięć,
połączenia i zadania runtime.

### 2.2. Workspace

Workspace to wspólna przestrzeń serwera. Ma członków, nazwę, wspólną pamięć,
wspólne boty i sekcje. Każda osoba korzysta z własnego profilu użytkownika.

### 2.3. Bot

Bot jest nazwanym agentem z własną tożsamością i ustawieniami. Bot ma osobny:

- profil/personę;
- model lub provider;
- transcript rozmów;
- pamięć indywidualną;
- zestaw skills;
- rutyny;
- uprawnienia i poziom autonomii;
- statystyki usage;
- dostęp do narzędzi i kont integracji;
- widoczność `public`, `team` albo `private`.

### 2.4. Rozmowa

Rozmowa jest transcript przypisanym do bota, grupy albo pokoju współpracy.
Wiadomości są trwale zapisywane przez harness. Streaming odpowiedzi, eventy
narzędzi i pytania oczekujące są osobnymi elementami stanu, ale użytkownik
widzi je w jednym widoku.

---

## 3. Architektura i przepływ danych

~~~
React / PWA / Electron UI
            |
            v
Node.js harness :8799
  auth, workspace, transcripts, drivers, rooms, groups,
  mail, routines, connectors, updates, SSE/WebSocket
            |
            +--> provider drivers / CLI / API models
~~~

MultiBot uruchamia dwa procesy: powłokę Electron i harness Node/TypeScript.
Nie ma osobnego procesu runtime ani sidecara.

### 3.1. Frontend

Frontend znajduje się w `src/`. Odpowiada za:

- layout aplikacji;
- sidebar i sekcje botów;
- chat i composer;
- panele ustawień;
- onboarding;
- statusy runtime i animacje maskotek;
- PWA/mobile layout;
- komunikację z API przez `authFetch` lub warstwę `api`.

### 3.2. Harness

Harness znajduje się w `server/`. Odpowiada za:

- uwierzytelnianie HTTP, SSE i WebSocket;
- przechowywanie konfiguracji i transcriptów;
- filtrowanie botów według ACL;
- sterowanie turami providerów;
- kolejkę wiadomości bot-do-bota;
- trwałe pokoje i grupy;
- rutyny i webhooki;
- profile, workspace i zaproszenia;
- pamięć, skills, approvals, uprawnienia i usage;
- logowanie profili na wspólnym serwerze;
- provisioning urządzenia i narzędzi CLI;
- katalog providerów, CLI i konektorów;
- eventy live dla kilku urządzeń.

### 3.3. Provider-neutral workspace

Pamięć, skills, routines, autonomia, permissions, usage i komunikacja botów są
przechowywane przez harness w sposób niezależny od providera. Dzięki temu
zmiana modelu z Claude na Codex, Gemini, Grok, Kimi, Qwen albo custom endpoint
nie tworzy nowego bota i nie gubi jego workspace.

Provider nadal zachowuje własny natywny runtime. Dla części providerów CLI
MultiBot używa shadow profile po stronie harnessu, aby wspólne funkcje
workspace były dostępne pod tym samym botem.

---

## 4. Wygląd aplikacji

### 4.1. Ogólny styl

Interfejs jest ciemny, płaski i narzędziowy. Główne powierzchnie mają różne
poziomy ciemnego tła:

- `bg-app` dla obszaru aplikacji i rozmowy;
- `bg-panel` dla sidebara i paneli;
- `bg-card` dla kart, dymków i sekcji;
- `bg-raised` dla przycisków, menu i elementów hover;
- `bg-inset` dla pól wejściowych i obszarów zagnieżdżonych;
- cienkie obramowania `border-hairline`;
- jasny tekst główny `text-ink`;
- przygaszony tekst pomocniczy `text-ink-secondary`;
- akcent używany do aktywnych elementów, statusu i przycisków głównych.

Typografia jest mała i gęsta w panelach narzędziowych, większa w nazwach
botów i wiadomościach. Karty mają zaokrąglone rogi, ale layout pozostaje
kompaktowy i nastawiony na długie sesje pracy.

### 4.2. Układ desktopu

Desktop dzieli się na:

1. lewy sidebar botów;
2. główny obszar rozmowy;
3. opcjonalny panel boczny otwierany dla ustawień lub narzędzia.

Sidebar ma domyślną szerokość `240px`. Szerokość jest zapisywana lokalnie i
wraca po ponownym uruchomieniu aplikacji. Można ją przeciągać w zakresie
`160px–420px`. Panel można zwinąć do około `80px`, gdzie widoczne są głównie
ikony i statusy.

W Electronie nagłówki używają obszaru drag dla frameless shell. Kontrolki
okna nie mieszają się z treścią rozmowy.

### 4.3. Układ telefonu/PWA

PWA używa tego samego API i danych, lecz ma layout dostosowany do wąskiego
ekranu:

- sidebar może być schowany;
- panele otwierają się jako pełny widok lub drawer;
- composer pozostaje przyklejony do dołu;
- duże elementy dotykowe zastępują małe kontrolki desktopowe;
- nagłówek ogranicza liczbę jednoczesnych akcji;
- pulpit/computer może być oglądany zdalnie, gdy host działa na innym
  urządzeniu.

Instalacja PWA nie przenosi danych offline. Service worker cache’uje shell i
fingerprinted assets, natomiast API, SSE, transcript i stan workspace zawsze
idą do serwera.

### 4.4. Skórki

Skórka jest wybierana lokalnie przez atrybut `data-skin` oraz zapisywana w
`localStorage`. Dostępne skórki:

- **Midnight** — oryginalna, chłodna i ciemna;
- **Atelier** — jasna, papierowa i ciepła;
- **Foundry** — ciemna, ciepła, z mosiężnym akcentem;
- **Lagoon** — chłodna, jasna, porcelanowa i tealowa.

Domyślna skórka to **Midnight**. Skórka nie przenosi sekretów ani konfiguracji
serwera między urządzeniami.

---

## 5. Onboarding — pierwsze uruchomienie

Onboarding ma dwie główne ścieżki:

- **Postaw serwer / Set up a server** — urządzenie staje się serwerem;
- **Zaloguj się do serwera / Sign in to a server** — urządzenie łączy się
  z serwerem uruchomionym gdzie indziej.

Każdy ekran poza wyborem początkowym ma przycisk strzałki **Wstecz**. Powrót
z pierwszego ekranu serwera prowadzi do wyboru dwóch ścieżek. Nie ma już sytuacji,
w której wejście w `Set up a server` blokuje użytkownika bez możliwości cofnięcia.

### 5.1. Ekran wyboru

Ekran pokazuje mascot MultiBot, nazwę aplikacji i dwie karty:

- uruchomienie serwera na tym urządzeniu;
- połączenie z istniejącym serwerem.

### 5.2. Setup urządzenia

Ścieżka serwera pokazuje:

- hostname urządzenia;
- platformę i architekturę;
- RAM, jeśli system go udostępnia;
- Docker i jego wersję;
- producenta, model i wersję Androida, jeśli dotyczy;
- informację o Termuxie;
- opcję uruchomienia serwera 24/7.

Przycisk **Tak, skonfiguruj** uruchamia provisioning. Postęp jest czytany
przez SSE. Jeśli provisioning trwa, można przejść dalej przyciskiem
**Kontynuuj w tle**. Kroki provisioning są idempotentne, więc nieudany proces
można ponowić.

Przycisk **Nie teraz** przechodzi dalej bez włączania serwera 24/7.

### 5.3. Profil użytkownika

Użytkownik może podać:

- imię/nazwę wyświetlaną w workspace;
- adres e-mail.

Profil podpisuje wiadomości użytkownika i pozwala botom oraz innym członkom
rozpoznać, kto pracuje w workspace. Zapis trafia do `/api/config`.

Można wybrać **Może później**, ale pełne konto workspace powinno mieć
ustawione dane profilu.

### 5.4. Narzędzia CLI

Onboarding sprawdza dostępność narzędzi CLI, pokazuje wersję lub powód braku
i pozwala zaznaczyć brakujące narzędzia do instalacji. Instalacja ma osobny
postęp dla każdego narzędzia.

Obsługiwane pozycje katalogu CLI:

- Claude Code;
- Codex;
- Gemini;
- Kimi Code;
- Qwen Code;
- Grok agent.

Jeżeli narzędzie ma wymagane logowanie, onboarding może pokazać jego komendę
logowania. Sam MultiBot nie przejmuje sekretów logowania do CLI.

### 5.5. Własny model

Opcjonalny formularz przyjmuje:

- nazwę wyświetlaną;
- `Base URL` endpointu zgodnego z OpenAI;
- identyfikator modelu;
- opcjonalny klucz API.

Przykładowe zastosowania:

- lokalny endpoint;
- firmowy gateway;
- kompatybilny endpoint chmurowy;
- prywatny model operatora.

Klucz nie wraca w odpowiedziach API. Po zapisie pole klucza jest czyszczone.

### 5.6. Uprawnienia Electron

W desktopie onboarding może poprosić o mikrofon. Uprawnienie służy do
dyktowania wiadomości i jest opcjonalne. Stan może być odczytywany okresowo,
a użytkownik może pominąć krok.

W przeglądarce ten krok Electron nie występuje; przejście wstecz pomija go,
żeby numeracja ekranów nie prowadziła do nieistniejącego widoku.

### 5.7. Shared workspace

Onboarding opisuje docelowy model zespołowy:

- każda osoba ma własne konto;
- boty i sekcje są wspólne dla workspace;
- bot prywatny jest chroniony własnym ACL;
- każdy bot ma własną pamięć;
- workspace ma pamięć zespołu wspólną dla botów i członków.

W tym kroku można zobaczyć aktualnego użytkownika i członków workspace. Owner
może utworzyć zaproszenie dla kolejnej osoby.

### 5.8. Połączenie z istniejącym serwerem

Ścieżka **Zaloguj się do serwera** przyjmuje adres serwera — bezpośredni albo
przez zaufane reverse proxy z HTTPS przed portem 8799 (tak jak mówią
instalatory). Żadnych usług trzecich. W Electronie host jest zapisywany przez
bridge, a w zwykłej przeglądarce następuje nawigacja pod podany adres.

Po stronie serwera logowanie odbywa się przez konto lokalne i hasło profilu.
Rejestracja nowego użytkownika wymaga hasła serwera. Serwer wydaje sesję HTTP
oraz krótkotrwały token API.

---

## 6. Sidebar: boty, sekcje i grupy

### 6.1. Górny pasek sidebara

Górny pasek zawiera:

- przycisk zwinięcia sidebara;
- przycisk `+`;
- wyszukiwarkę z obsługą `Ctrl+K`.

Menu `+` ma trzy operacje:

- **Nowy bot**;
- **Nowa grupa**;
- **Zespół z folderu / Scout from folder**.

### 6.2. Przypięte boty

Przypięte boty są prezentowane wyżej, z większymi avatarami. Przy większej
liczbie botów układają się maksymalnie po trzy w wierszu. Kliknięcie wybiera
rozmowę.

### 6.3. Zwykła lista botów

Każdy wiersz może pokazać:

- animated mascot/avatar;
- nazwę bota;
- tytuł lub ostatni fragment wiadomości;
- czas ostatniej aktywności;
- kropkę unread;
- oznaczenie attention;
- crown dla chiefs sekcji.

W trybie zwiniętym pozostają ikona, kropki statusu i tooltip/popup.

### 6.4. Hover card

Po opóźnieniu około `350 ms` pojawia się własny panel z:

- nazwą bota;
- tytułem;
- opisem;
- jego mascot/avatar.

Natywny windowsowy tooltip nie powinien dublować tego panelu. Opis jest
renderowany przez customowy hover card.

### 6.5. Sekcje

Bot może być nieprzypisany albo należeć do nazwanej sekcji. Sekcje:

- mają własny divider;
- można rozwijać i zwijać;
- pokazują liczbę lub listę botów;
- są częścią wspólnego workspace;
- mogą mieć section chief.

Na sekcji dostępna jest opcja zwijania. W menu kontekstowym bota dostępne są:

- **Change section / Zmień sekcję**;
- **Move to section / Przenieś do sekcji**;
- **Add to section / Dodaj do sekcji**;
- **Remove from section / Usuń z sekcji**;
- utworzenie nowej sekcji;
- ustawienie lub zdjęcie section chief.

Przypisanie sekcji zapisuje się na rekordzie bota i może być synchronizowane z
innymi klientami workspace.

### 6.6. Menu kontekstowe bota

Prawy przycisk myszy na bocie otwiera menu z opcjami:

- oznacz jako przeczytane;
- oznacz jako nieprzeczytane;
- edytuj profil;
- ustaw/zdejmij section chief;
- przenieś lub dodaj do sekcji;
- duplikuj bota;
- ukryj bota;
- usuń bota.

Operacje usuwania i ukrywania są rozdzielone. Usunięcie bota kasuje powiązane
workspace data zgodnie z trasą serwera; przed operacją powinien pojawić się
dialog potwierdzenia.

### 6.7. Grupy

Grupa jest innym obiektem niż sekcja. Sekcja organizuje roster, grupa tworzy
wspólny pokój rozmowy wielu botów.

Grupę można utworzyć z `+`, nadać jej nazwę i wybrać boty. Grupa pojawia się w
sidebarze ponad zwykłymi botami. Kliknięcie otwiera pokój grupowy.

W grupie użytkownik może wysłać wiadomość do całego pokoju. Wybrane boty
przetwarzają turę równolegle, a transcript zostaje zapisany.

---

## 7. Chat i wiadomości

### 7.1. Nagłówek rozmowy

Nagłówek rozmowy zawiera:

- animated mascot i nazwę bota po lewej;
- picker modelu;
- akcje narzędziowe;
- menu `⋮` w Electronie;
- przyciski kontroli okna shell, gdy używa ich desktop.

Kliknięcie mascot/nazwy otwiera ustawienia profilu bota.

### 7.2. Menu trzech kropek

W Electronie menu `⋮` grupuje:

- **Bot computer**;
- **Routines**;
- **Skills**;
- **Find in chat**;
- **Runtime Inspector**;
- **Agent mail**;
- **Team map**.

Agent mail i Team map są dostępne w tym menu, a nie jako osobne pozycje
zajmujące miejsce w stopce sidebara. Menu animuje się przy otwarciu, a przy
włączonym `prefers-reduced-motion` otwiera się bez ruchu.

### 7.3. Dymki

Wiadomości użytkownika są wyrównane do prawej, wiadomości bota do lewej.
Na desktopie dymki są celowo zwężone, aby transcript przypominał rozmowę, a
nie pełną kolumnę tekstu.

Wiadomość może zawierać:

- tekst plain text;
- Markdown i GitHub-Flavored Markdown;
- kod z syntax highlighting;
- obraz;
- plik;
- wynik narzędzia;
- kartę approval/question;
- cytowaną wiadomość;
- badge użytego modelu;
- przycisk TTS przy odpowiedzi bota.

### 7.4. Czas i sesje

Godzina nie jest wyświetlana jako osobna etykieta przy każdej wiadomości.
Transcript używa separatora sesji na środku, np. `Dzisiaj 14:03` albo
`Wczoraj 16:59`. Nowa sesja pojawia się, gdy wiadomości są od siebie
dostatecznie oddalone czasowo.

### 7.5. Automatyczne przewijanie

Po wejściu w rozmowę widok jest ustawiany na dół. Nowe odpowiedzi utrzymują
widok przy końcu, dopóki użytkownik nie przewinie ręcznie do góry.

Po ręcznym odjechaniu pojawia się możliwość powrotu do najnowszych wiadomości.
Ten sam model follow/unfollow działa w transcriptach pokoi współpracy.

### 7.6. Długie wiadomości użytkownika

Wiadomość użytkownika dłuższa niż `600` znaków albo mająca więcej niż `8`
wierszy jest początkowo zwinięta. Przycisk **Pokaż całą wiadomość** rozwija
pełną treść.

Odpowiedzi botów nie są w ten sposób obcinane; są renderowane jako pełny
Markdown.

### 7.7. Composer

Composer zawiera:

- przycisk dodawania załącznika;
- pole tekstowe;
- sugestie slash commands;
- sugestie `@mentions` botów;
- wybór poziomu dostępu;
- wybór reasoning effort, jeśli model go udostępnia;
- dyktowanie przez mikrofon;
- przycisk wysyłania.

Poziomy dostępu w pigułce:

- **Read Only / Tylko odczyt** — odczyt danych, bez browsera, delegowania,
  plików, integracji i terminala;
- **Ask for approval / Pytaj o zgodę** — narzędzia mogą działać, ale akcje
  wymagające zgody pokazują kartę approval;
- **Full Access / Pełny dostęp** — pełna konfiguracja narzędzi zgodna z
  uprawnieniami bota.

Zmiana poziomu jest zapisywana per bot. W razie błędu UI przywraca poprzednią
wartość.

### 7.8. Slash commands i mentions

Slash picker może wyszukiwać akcje oraz skills. Skill wpisany jako slash
command jest wysyłany jako zwykła wiadomość, a gateway rozwiązuje go po stronie
runtime.

`@Bot` może:

- zasugerować konkretnego bota;
- utworzyć delegowanie;
- uruchomić komunikację bot-do-bot;
- wskazać uczestnika grupy albo pokoju.

### 7.9. Załączniki

Użytkownik może przeciągnąć plik do composera albo wybrać go przyciskiem.
Załącznik jest uploadowany przez harness, a wiadomość przechowuje metadane.

Dla obrazów:

- UI pobiera blob przez chronioną trasę;
- obraz pokazuje się jako miniatura;
- kliknięcie otwiera lightbox;
- URL object jest zwalniany po zamknięciu/odmontowaniu.

Dla pozostałych plików:

- pokazuje się nazwa i rozmiar;
- dostępne jest pobieranie;
- HTML można otworzyć w nowej karcie;
- załącznik `skill.md` może być użyty jako materiał skilla zamiast zwykłej
  karty wiadomości.

### 7.10. Wyszukiwanie rozmowy

`Ctrl+F` lub akcja **Find in chat** otwiera pasek wyszukiwania transcriptu.
Wyniki są podświetlane i można przeskakiwać między wiadomościami.

Globalne `Ctrl+K` przeszukuje:

- boty;
- skills;
- routines;
- grupy;
- wiadomości;
- linki;
- pliki;
- akcje aplikacji.

### 7.11. Cytowanie i TTS

Wiadomość może odpowiadać na inną przez flat reply. Cytat wskazuje wiadomość
źródłową i pozwala do niej przeskoczyć.

Odpowiedzi botów mają przycisk Speak/TTS. Czytanie na głos obsługuje harness
przez `/api/bots/:id/speak` i wymaga skonfigurowanego klucza głosu. Przycisk
nie jest pokazywany przy wiadomościach użytkownika.

---

## 8. Modele i providery

### 8.1. Wbudowane providery

Katalog instancji rozpoznaje między innymi:

- Claude Code;
- Codex;
- Grok;
- Gemini;
- Kimi Code;
- Qwen Code;
- custom modele.

Własne endpointy zgodne z OpenAI (Ollama, LM Studio, OpenRouter) obsługuje
driver `openaiCompatible`, zbudowany na tym samym mechanizmie
chat-completions co pozostałe providery API.

### 8.2. Model picker

Picker pokazuje flotę dostępnych providerów oraz nazwane custom models. Po
wybraniu modelu bot używa tej konfiguracji dla kolejnych tur.

W transcriptach wiadomości bota może pojawić się badge wskazujący użyty model.
Badge używa przyjaznej etykiety z katalogu, a jako fallback pokazuje surowy ID.

### 8.3. Komenda `/model`

W rozmowie można użyć:

- `/model` — pokaż bieżący katalog;
- `/model claude/opus` — wybierz parę provider/model;
- `/model codex/gpt-5.1-codex` — wybierz model Codex;
- `/model <model> --provider <provider>` — ustaw jawnie provider i model.

### 8.4. Custom model

Custom model w App Settings lub onboardingu ma:

- display name;
- base URL;
- model ID;
- opcjonalny API key.

API key jest write-only. Odczyt konfiguracji zwraca status/obecność, nie
wartość sekretu. Dodanie custom modelu nie usuwa wbudowanych wpisów CLI.

### 8.5. Różnice driverów

Nie każdy driver ma identyczne możliwości. Przykładowo:

- MCP-capable providers mogą dostać live peer tools;
- provider API/Codex może używać jawnego `@bot` delegation;
- CLI może wymagać osobnego loginu;
- custom model wymaga działającego endpointu;
- lokalny model wymaga działającego serwera modeli, na przykład Ollama albo
  LM Studio.

MultiBot zachowuje wspólne memory/skills/routines niezależnie od tych różnic,
ale konkretne narzędzie może być niedostępne dla danego drivera lub platformy.

---

## 9. Profil bota i ustawienia bota

Panel profilu otwiera się przez kliknięcie bota, jego mascot albo menu
kontekstowe **Edit Profile**.

Panel ma szerokość około `400px`. Nagłówek używa strzałki po lewej stronie.
W panelu ustawień bota nie ma osobnego `X` po prawej stronie; wyjście odbywa
się przez back.

### 9.1. Tożsamość

Profil może zawierać:

- nazwę;
- tytuł;
- opis;
- model;
- ustawienie powiadomień;
- ustawienia dostępu;
- ustawienia autonomii;
- uprawnienia narzędzi;
- approval rules;
- visibility i ACL.

### 9.2. Mascot i ikona

Bot używa systemu mascotów zamiast zwykłego statycznego kursora. Picker
pozwala wybrać kształt, kolor i ekspresję. Domyślny mascot jest blobem
MultiBot.

Avatar jest używany w:

- sidebarze;
- nagłówku rozmowy;
- hover card;
- room chip;
- mail/team map;
- statusach pracy;
- onboarding;
- ustawieniach profilu.

### 9.3. Stany lifecycle

Dostępne stany lifecycle mascotów:

- `sleeping`;
- `waking`;
- `idle`;
- `listening`;
- `thinking`;
- `searching`;
- `working`.

### 9.4. Reakcje

System ma reakcje:

- `excited`;
- `surprised`;
- `suspicious`;
- `angry`;
- `drowsy`;
- `happy`;
- `curious`;
- `confused`;
- `bored`;
- `proud`;
- `shy`;
- `sad`;
- `laughing`;
- `scared`;
- `playful`;
- `celebrate`.

### 9.5. Morphs i animacje

Morphy agentów:

- `orbit`;
- `radar`;
- `progress`;
- `thinking-dots`.

Animacje cyklu produktu:

- `spawning`;
- `humming`;
- `loading`;
- `dictating`;
- `writing`;
- `sending`;
- `receiving`;
- `uploading`;
- `notifying`;
- `alerting`;
- `dragging`;
- `bouncing`;
- `powering-down`.

Podczas pracy bot może animować się jednocześnie w sidebarze i nad composerem.
Stan jest wyliczany z runtime/eventów, a nie tylko z dekoracyjnego CSS.

### 9.6. Autonomia i permissions

Autonomia ma dwa poziomy:

- `approval` — bot pyta o akcje wymagające zgody;
- `autonomous` — bot może działać bez pytania w zakresie przyznanych
  permissions.

Zestaw permissions obejmuje:

- `browser`;
- `delegation`;
- `file`;
- `integrations`;
- `memory`;
- `skills`;
- `terminal`.

Pigułka composer access jest skrótem do bezpiecznej konfiguracji tych ustawień.
`read-only` wyłącza browser, delegation, file, integrations i terminal.

### 9.7. Approval rules

Bot może mieć reguły pozwalające zapamiętać zgodę dla konkretnej kombinacji
provider/key/label. Reguły są per bot i można je usuwać.

Karta approval może pokazać:

- prośbę o pozwolenie;
- akcję, która ma się wydarzyć;
- przyciski allow/deny;
- pytanie wymagające odpowiedzi;
- attention state dla loginu, CAPTCHA lub brakującego sekretu.

---

## 10. Pamięć

MultiBot ma dwa poziomy pamięci, zgodnie z modelem wspólnego serwera.

### 10.1. Pamięć indywidualna bota

Każdy bot ma osobną pamięć. Nie jest ona automatycznie mieszana z pamięcią
innego bota.

Pamięć zawiera:

- fakty;
- tekst źródłowy/opis faktu;
- wyciągnięte encje `@` i `#`;
- datę utworzenia;
- markdownowy dokument pamięci;
- graf faktów i encji.

Fakty można:

- listować;
- wyszukiwać tekstowo;
- dodawać;
- edytować;
- usuwać.

Markdown można:

- odczytać;
- zastąpić treścią;
- używać jako dłuższych notatek profilu.

Graf tworzy węzły faktów i encji oraz krawędzie fakt → encja. Waga encji
odpowiada liczbie faktów, które ją zawierają.

Limit pojedynczego faktu to `20 000` znaków. Limit markdownowej pamięci bota
to `500 000` znaków.

### 10.2. Pamięć zespołu

Workspace ma osobny magazyn `__team__`. Jest wspólny dla:

- wszystkich botów;
- wszystkich autoryzowanych członków workspace;
- agentów działających w imieniu workspace.

Pamięć zespołu ma te same podstawowe operacje:

- listowanie faktów;
- wyszukiwanie;
- dodawanie;
- edycja;
- usuwanie;
- markdown;
- graf/relacje.

Pamięć zespołu nie zastępuje pamięci bota. Pamięć bota służy do jego własnej
tożsamości, preferencji i historii; team memory służy do wspólnych ustaleń,
projektu i faktów znanych całemu zespołowi.

### 10.3. Izolacja

Pamięć jest filtrowana po bot ID i workspace. Agent może czytać tylko zakres,
który wynika z jego uprawnień. Zmiany pamięci są publikowane jako eventy live,
więc drugi klient może odświeżyć workspace bez ręcznego restartu.

---

## 11. Współpraca botów

### 11.1. Delegowanie

Bot może uznać, że zadanie wymaga specjalisty. Może wtedy:

- użyć peer tool, jeśli provider go wspiera;
- odwołać się do bota przez `@mention`;
- przesłać zadanie do innego bota;
- zebrać odpowiedź i kontynuować własną turę.

Komunikacja jest kontrolowana przez harness. Bot nie otwiera samodzielnie
nieautoryzowanego połączenia sieciowego do innego procesu.

### 11.2. Wiadomości bot-do-bota

Wiadomość od bota do bota to tura w pokoju, nie osobna skrzynka. Każde
`send_bot_mail`, `ask_bot`, `start_collab`, wiadomość grupowa i `@mention`
przechodzi przez `deliverPeerMessage`, dopisuje się do transkryptu pokoju i
trafia na główny wątek adresata. Pojedynczy tekst ma limit `8 000` znaków.

Doręczenie jest asynchroniczne. Jeśli odbiorca jest zajęty w turze
użytkownika, wiadomość jest wsterowana w trwającą turę albo kolejkowana.
Odpowiedź może obudzić odbiorcę w nowej turze.

`read_bot_mail` (nazwa została dla starszych promptów) czyta wiadomości,
które inne boty napisały w pokojach tego bota od jego ostatniego odczytu.
Kursor odczytu żyje w procesie harness; historia jest w `rooms.json`.

### 11.3. Pokoje współpracy

Room jest projekcją zadania bot-do-bota. Powstaje, gdy:

- bot uruchomi `start_collab`;
- użytkownik wspomni drugiego bota w zadaniu;
- harness rozpocznie wielobotową współpracę.

Pokój zawiera:

- task;
- listę botów;
- transcript;
- status `running`, `done` albo `failed`;
- bota inicjującego;
- thread, w którym pokazuje się chip.

Pokój jest tylko do odczytu dla użytkownika. Nie ma w nim drugiego composera.
Użytkownik może:

- otworzyć pokój z chipa `X napisał do Y`;
- obserwować streaming pracy botów;
- przewijać historię;
- kliknąć avatar/nazwę i przejść do czatu konkretnego bota;
- zamknąć widok i wrócić do rozmowy.

Pokoje są trwałe w `rooms.json` i można je ponownie otworzyć po czasie oraz po
restarcie. Jeśli serwer zrestartuje się podczas aktywnej tury, nie wznawia
workera automatycznie; pokój zostaje oznaczony jako `failed`, ale transcript
pozostaje do odczytu.

### 11.4. Grupy

Grupa jest użytkownikowym pokojem wielu botów. Użytkownik może pisać do grupy,
a harness uruchamia uczestników równolegle. Historia grupy jest utrwalana.

Grupa różni się od roomu:

- room jest obserwacyjną współpracą uruchomioną przez bota/zadanie;
- group jest stałym obiektem z rosterem botów i composerem użytkownika.

### 11.5. Team map

Team map odpytywana jest co około `3 s` przez `/api/team-map`.

Panel pokazuje:

- sekcje workspace;
- boty w sekcjach;
- chiefs sekcji;
- status pracy botów;
- edge/chip aktualnej komunikacji;
- animowane mascoty uczestników.

Team map jest panelem obserwacyjnym. Zarządzanie rosterem wykonuje się w
sidebarze i ustawieniach, nie przez dekoracyjną mapę.

---

## 12. Goals

Komenda `/goal <cel>` uruchamia pętlę wieloturową zamiast pojedynczej
odpowiedzi.

Domyślne bezpieczniki:

- `10` tur;
- `250` kroków narzędziowych;
- `90` minut.

Parametry można zmieniać przez flagi z `server/goals.ts`, w szczególności:

- `--steps`;
- `--turns`;
- `--time`;
- `--resume`;
- opcje związane z pytaniem/zgodą.

Goal ma osobny wątek `goal-<id>-<bot>`, trwały zapis w `goals.json`, pigułkę
postępu w czacie i marker `[GOAL COMPLETE]` po zakończeniu.

Bot sam decyduje, czy użyć narzędzi, własnego komputera, innego bota albo
podagenta. Delegowanie nie jest sztucznie wymaganym etapem każdej pętli.

Approval w goal jest rozpatrywany na poziomie promptu. Karta z głównego czatu
nie musi pojawić się w wątku goal.

---

## 13. Computer use

### 13.1. ComputerPanel

Panel komputera może pokazywać:

- live preview pulpitu;
- adres lub aktualną stronę;
- input takeover;
- nawigację;
- screenshot;
- fullscreen;
- stan busy/lease;
- przycisk przerwania.

Dostęp otwiera się przez menu `⋮` → **Bot computer**.

### 13.2. Approval granicy komputera

Computer-use respektuje permission i approval mode bota. Akcje zewnętrzne,
logowanie i wrażliwe interakcje mogą wymagać zgody albo przejęcia przez
użytkownika.

### 13.3. Android/Termux

Na Androidzie pełny pulpit wymaga Termux:X11. Bez niego panel komputera nie ma
czego pokazać, natomiast czat, pamięć, skills i rutyny działają normalnie.

---

## 14. Skills

Skills są powtarzalnymi instrukcjami, które bot może stosować w odpowiednim
kontekście.

Panel Skills pozwala:

- listować skille;
- tworzyć skill;
- edytować opis i instrukcje;
- włączać/wyłączać skill;
- usuwać skill;
- używać skilla przez slash command.

Skill ma:

- nazwę;
- opis;
- instrukcje;
- enabled flag;
- plik `SKILL.md` w katalogu workspace.

Shared skills są dostępne przez shadow workspace dla różnych providerów tego
samego bota.

Wiadomość z załączonym `skill.md` może zostać potraktowana jako materiał do
skilla, a nie zwykły plik transcriptu.

---

## 15. Routines i webhooki

Routine to zapisane zadanie wykonywane według harmonogramu.

Każda routine ma:

- nazwę;
- prompt;
- harmonogram;
- enabled/disabled;
- next run;
- historię ostatnich uruchomień;
- opcjonalny webhook.

Harmonogram obsługuje:

- skróty `every Nm`;
- skróty `every Nh`;
- skróty `every Nd`;
- 5-polowy cron.

Panel pozwala:

- utworzyć routine;
- edytować routine;
- włączyć/wyłączyć;
- uruchomić teraz;
- usunąć;
- włączyć webhook;
- skopiować URL;
- skopiować HMAC secret.

Ograniczenia:

- prompt routine: maksymalnie `20 000` znaków;
- payload webhooka: maksymalnie `20 000` znaków;
- panel pokazuje do `20` ostatnich uruchomień;
- webhook traktuje dane wejściowe jako dane, nie instrukcje.

Webhook jest publicznie wystawionym wejściem tylko w zakresie własnej trasy i
powinien być chroniony przez wygenerowany sekret/HMAC oraz HTTPS/reverse proxy.

---

## 16. Integracje, plugins, MCP i Composio

### 16.1. Plugins panel

Plugins panel pokazuje katalog połączeń. Katalog może pochodzić z Composio albo
z własnych custom MCP connectors.

Karta konektora może pokazać:

- logo;
- favicon domeny jako fallback;
- monogram, jeśli brak grafiki;
- nazwę;
- opis;
- status konta.

### 16.2. Composio Connect

App Settings pozwalają skonfigurować:

- Composio Connect key `ck_…`;
- opcjonalny Composio API key `ak_…`.

Composio API key odblokowuje pełniejszy katalog aplikacji. OAuth i status kont
są obsługiwane po stronie serwera; frontend nie powinien przechowywać sekretu
w stanie trwałym.

### 16.3. Custom MCP connectors

Custom connector ma:

- ID lowercase z literami, cyframi, `-` lub `_`;
- nazwę;
- transport `stdio`, `http` albo `sse`;
- command + args dla `stdio` albo URL dla HTTP/SSE;
- env dla `stdio` albo headers dla HTTP/SSE.

ID zaczyna się od litery/cyfry, ma maksymalnie `61` znaków. Zarezerwowane ID:

- `composio`;
- `computer`;
- `agents`;
- `ogb`.

Edycja custom konektora nadpisuje cały wpis. Sekrety trzeba podać ponownie,
ponieważ API nie zwraca ich do prefillingu.

### 16.4. Google Workspace

Samohostowany preset Google Workspace działa jako connector workspace-mcp.
Operator może skonfigurować client ID i client secret. Dane logowania pozostają
po stronie serwera.

### 16.5. Konta per bot

Profil bota może mieć selektor konta Gmail/Composio. Konto jest osobnym
zasobem od samej definicji bota; dostęp do niego wynika z konfiguracji
connectora i uprawnień.

---

## 17. Runtime Inspector

Runtime Inspector otwiera się z menu `⋮`.

Panel pokazuje do `100` ostatnich eventów bota, odświeżanych co około `2 s`.
Event może zawierać:

- ID;
- czas;
- typ;
- provider;
- item type;
- summary;
- wynik `ok`.

Dostępne akcje:

- ręczne odświeżenie;
- zaznaczenie wybranych eventów;
- skopiowanie eventu jako JSON;
- replay zaznaczonych eventów albo całej listy;
- zamknięcie panelu.

Inspector służy do diagnozowania runtime, providerów i narzędzi. Nie jest
pełnym debuggerem ani terminalem administratora.

---

## 18. App Settings

App Settings to pełny ekran, nie mały wysuwany fragment. Nagłówek ma:

- strzałkę back po lewej stronie;
- tytuł **App Settings**;
- opis `Settings shared across your MultiBot workspace.`;
- pionową szynę ikon po lewej.

Kolejność szyny:

1. **General / Ogólne**;
2. **Tools / Narzędzia**;
3. **Updates / Aktualizacje**.

### 18.1. General

General obejmuje:

- język PL/EN;
- profil użytkownika;
- wygląd/skórkę;
- przełącznik animacji interfejsu;
- ustawienia połączeń;
- Composio Connect key;
- opcjonalny Composio API key.

Przełącznik animacji obejmuje ruch mascotów, ikon ustawień i menu. Wyłączenie
animacji powinno respektować preferencje użytkownika i reduced motion.

### 18.2. Tools

Tools obejmuje elementy administracyjne:

- **Server & devices**;
- workspace access;
- custom models;
- CLI tools i ich przełączniki allow;
- status lokalnej usługi;
- zasoby urządzenia;
- diagnostykę/export.

### 18.3. Updates

Updates obejmuje:

- sprawdzanie aktualizacji;
- wyświetlenie aktualnej wersji;
- błąd sprawdzania, jeśli feed jest niedostępny;
- pobranie/instalację, jeśli kanał desktopowy udostępnia asset.

Feed update musi być poprawnym URL-em release feed. Do sprawdzania nie należy
doklejać tekstu błędu, `\\n` ani `\\nPlease` do URL-a.

### 18.4. Server & devices

Panel **Server & devices** przenosi w jedno miejsce funkcje związane z
serwerem, kontem i urządzeniami:

- Shared server/workspace;
- aktualny użytkownik;
- lista członków;
- nazwa i hasło serwera dla ownera;
- wylogowanie i zarządzanie sesjami;
- instalacja PWA.

### 18.5. Install app/PWA

Panel rozpoznaje przeglądarkę:

- iPhone/iPad Safari: Share → Add to Home Screen;
- Android Chrome: menu → Install app/Add to Home screen;
- Firefox: użycie Chrome/Edge;
- Chrome/Edge desktop: ikona instalacji w pasku adresu.

Jeżeli przeglądarka dostarczy `beforeinstallprompt`, UI uruchamia natywny prompt.

---

## 19. Wspólny serwer, konta i ACL

### 19.1. Konto użytkownika

Każda osoba ma własną tożsamość. Serwer może użyć:

- lokalnej sesji HTTP;
- krótkotrwałego tokena API wydanego po logowaniu.

Profil użytkownika zawiera UID oraz opcjonalnie name/email. Te pola są używane
do podpisu wiadomości i listy członków.

### 19.2. Owner i member

Workspace ma role:

- `owner` — może zmieniać ustawienia serwera i wykonywać operacje właścicielskie;
- `member` — może pracować w workspace zgodnie z ACL botów.

Pierwszy zarejestrowany użytkownik zostaje ownerem. Kolejni użytkownicy
dołączają hasłem serwera i tworzą własne profile.

### 19.3. Zaproszenie

Osobny mechanizm invite nie jest potrzebny: owner przekazuje publiczny adres
i hasło serwera. Hasło serwera nie jest hasłem profilu.

Kolejność użycia:

1. właściciel uruchamia serwer;
2. właściciel przekazuje adres i hasło serwera;
3. druga osoba instaluje MultiBot lub otwiera PWA;
4. druga osoba łączy się z adresem serwera;
5. loguje się lub tworzy własną tożsamość;
6. wybiera `New profile` i podaje hasło serwera;
7. pojawia się jako nowy member;
8. widzi wspólne boty i sekcje zgodnie z ACL.

### 19.4. Widoczność bota

Bot ma jedną z wartości:

- `team` — dostępny członkom workspace;
- `private` — widoczny wyłącznie właścicielowi bota.

Serwer filtruje boty, eventy, grupy i operacje zanim zwróci je klientowi.

### 19.5. Wspólne sekcje

Sekcje należą do workspace, nie do lokalnego widoku jednego użytkownika.
Przypisanie bota do sekcji powinno być widoczne na innych klientach po eventach
workspace. Prywatny bot nadal nie pojawia się użytkownikowi bez dostępu,
nawet jeśli zna nazwę sekcji.

### 19.6. Pamięć a konta

Pamięć indywidualna bota pozostaje pamięcią tego bota. Team memory jest wspólna
dla workspace. ACL chroni prywatne boty, ale sama wspólna pamięć powinna być
traktowana jako dane widoczne dla członków workspace.

---

## 20. Uwierzytelnianie i granica sieci

### 20.1. HTTP

Chronione trasy przyjmują krótkotrwały `Authorization: Bearer <token>` albo
sesję `mb_v2_session` w cookie.

Publiczne pozostają tylko trasy wymagane do health, logowania, statycznego
shella i setupu lokalnego. Dane workspace nie są publiczne.

### 20.2. WebSocket/SSE

WebSocket nie może ustawić zwykłego Authorization w każdej przeglądarce, więc
frontend używa subprotocol marker + token. Proxy wybiera marker i nie przekazuje
sekretu dalej jako protokołu.

NoVNC/websockify ma ograniczoną obsługę `?token=` wyłącznie na trasie VNC, bo
mobile WebView może mieć rozdzielone cookie jar. Inne trasy nie używają tego
mechanizmu.

### 20.3. Token rotation

Tokeny są losowe, porównywane bez ujawniania wartości i sprawdzane bez
niebezpiecznego porównania zwykłych stringów. Rotacja zamyka istniejące
połączenia, aby stary token nie utrzymywał dostępu.

---

## 21. Dane lokalne i trwałość

Główna konfiguracja znajduje się w user data aplikacji, zwykle pod:

~~~
~/.openmausbot/config.json
~~~

Stary katalog `~/.opengrokbot` może być migrowany dla kompatybilności. Nazwy
legacy pozostają w kodzie tylko tam, gdzie potrzebna jest bezpieczna migracja.

Najważniejsze magazyny harness:

- `config.json` — konfiguracja instalacji, providerów, auth i workspace;
- `workspace.json` — pamięć workspace, skills, autonomy, permissions,
  approval rules i usage;
- `rooms.json` — trwałe pokoje współpracy;
- `groups.json` — grupy i ich transcript;
- `goals.json` — postęp i stan goals;
- katalog attachments — pliki wiadomości;
- katalogi profili botów — skills i stan profilu bota.

Dane wrażliwe powinny mieć prywatne uprawnienia plikowe na systemach, które je
wspierają. Windows korzysta z mechanizmu ACL systemu.

Transcript, uploady, profile, bazy pamięci i sekrety nie należą do repozytorium
i nie mogą trafić do publicznego commita.

---

## 22. Diagnostyka

### 22.1. Local service

Sidebar może pokazać, że lokalna usługa jest offline. Wtedy boty custom/local
model nie wykonają tury, ale sam harness i boty z innymi providerami mogą nadal
działać.

### 22.2. Typowe objawy

**`no route: GET /api/workspace`**

- klient i harness pochodzą z różnych wersji;
- frontend jest nowszy niż serwer;
- request idzie do złego adresu lub starego procesu;
- reverse proxy kieruje UI do innego backendu.

Sprawdzić:

- adres serwera w ustawieniach;
- wersję desktopa i serwera;
- czy działa właściwy proces na porcie `8799`;
- czy assety UI i `dist-server` są z tego samego release.

**`404` przy `releases.atom` albo URL z `\\nPlease`**

- feed aktualizacji został zbudowany z uszkodzonym tekstem błędu;
- URL nie może zawierać literalnego `\\nPlease`;
- trzeba sprawdzić konfigurację publishera i feed release.

**Update zamyka aplikację, ale po ponownym otwarciu wersja się nie zmieniła**

- instalator mógł nie zostać pobrany;
- instalacja mogła zostać przerwana;
- proces starej aplikacji mógł blokować pliki;
- asset release lub `latest.yml` może wskazywać złą wersję;
- SmartScreen lub uprawnienia Windows mogły zatrzymać NSIS.

Sprawdzić log updatera, zgodność `latest.yml` z EXE i czy nowy instalator
uruchomiono jako pełny asset release.

**Bot nie odpowiada i tura wisi**

- sprawdzić Runtime Inspector;
- sprawdzić status providera/CLI;
- sprawdzić pending approval/question;
- sprawdzić, czy target bot nie jest zajęty;
- sprawdzić kolejkę agent mail;
- przerwać turę zamiast uruchamiać kilka duplikatów.

**Brak animacji**

- sprawdzić App Settings → General → Animacje interfejsu;
- sprawdzić `prefers-reduced-motion`;
- sprawdzić, czy bot ma aktywny runtime event;
- sprawdzić, czy UI i backend pochodzą z tego samego builda;
- sprawdzić Mascot/skin w ustawieniach bota.

**Kolega nie widzi sekcji lub botów**

- obie osoby muszą być w tym samym workspace;
- klient musi mieć aktualną sesję/token;
- sekcja musi być zapisana po stronie serwera;
- bot prywatny wymaga UID w ACL;
- po zmianie tokena stara sesja musi zalogować się ponownie.

### 22.3. Logi

Nie kopiować publicznie:

- access tokenów;
- kodów recovery;
- API keys;
- webhook secretów;
- cookies;
- pełnych payloadów connectorów;
- prywatnych adresów LAN;
- transcriptów zawierających dane osobowe.

Do raportu wystarczą wersja, endpoint bez sekretu, status HTTP, typ błędu,
czas, system i zanonimizowany fragment logu.

---

## 23. Instalacja i tryby uruchomienia

### 23.1. Windows desktop

Komenda builda:

~~~powershell
$env:TEMP = "D:\tmp"
$env:TMP = "D:\tmp"
$env:ELECTRON_BUILDER_CACHE = "D:\electron-builder-cache"
pnpm package:win
~~~

Wynik:

~~~
release/MultiBot-<wersja>-x64-setup.exe
release/latest.yml
release/MultiBot-<wersja>-x64-setup.exe.blockmap
~~~

Instalator jest per-user, bez UAC i bez podpisu certyfikatem. Windows
SmartScreen może pokazać ostrzeżenie.

Paczka zawiera UI i harness. Nie dociąga żadnego osobnego runtime'u — po
wybraniu serwera 24/7 provisioning zajmuje się tylko konfiguracją instalacji
i narzędziami CLI. Zadanie Windows uruchamia spakowaną aplikację
z `--server-only` przy logowaniu użytkownika.

### 23.2. Linux/VPS

Możliwe tryby:

- Docker Compose;
- user systemd service przez `scripts/install-linux.sh`.

Service ma `Restart=always`. Instalator próbuje włączyć `loginctl
enable-linger`, aby usługa działała po wylogowaniu.

### 23.3. Docker self-host

~~~sh
docker compose -f docker-compose.selfhost.yml up -d --build
~~~

Publikowany jest harness na `127.0.0.1:8799`. Poza nim kontener nie powinien
wystawiać żadnego publicznego portu.

### 23.4. Android/Termux

~~~sh
bash scripts/install-termux.sh
~~~

Usługa używa `termux-services`, Termux:Boot i wake lock. Chat, memory,
routines i skills działają.

### 23.5. Trzy wartości po pierwszym boocie

Każdy instalator kończy wypisaniem adresu, nazwy serwera i hasła serwera
(plus odcisku certyfikatu) z `DATA_DIR/setup.json`; w kontenerze te same
wartości idą raz do `docker compose logs app`. Wpisuje się je w MultiBot na
dowolnym urządzeniu w `Sign in to a server`. Gdy pliku nie ma, serwer ma już
profil i trzeba zalogować się na istniejący. Szczegóły: `docs/REMOTE-ACCESS.md`.

### 23.6. Zdalny HTTPS

Od 0.4.0 harness sam słucha po HTTPS (`https://<adres>:8799`) na certyfikacie z
własnym podpisem, który wystawia sobie przy pierwszym boocie — nic dodatkowego
nie trzeba stawiać. Zaufanie idzie po odcisku SHA-256 (TOFU), a odcisk widać w
logu startowym i w `GET /api/public/server`. Zaufane reverse proxy jest opcją;
wtedy TLS kończy się na nim, a harness stoi na `OMB_HOST=127.0.0.1 OMB_TLS=off`.
Szczegóły: `docs/REMOTE-ACCESS.md`. Bez usług trzecich i bez tuneli.

---

## 24. PWA, telefon i ograniczenia platform

| Platforma | Chat/PWA | Memory/routines/skills | Computer | Always-on |
|---|---:|---:|---:|---:|
| Windows | tak | tak | tak | task per-user |
| macOS | tak | tak | tak | desktop/server |
| Linux/VPS | tak | tak | headless domyślnie | systemd/Docker |
| Android/Termux | tak | tak | wymaga Termux:X11 | Termux services |

Ograniczenia bieżącej wersji:

- HTTPS jest wymagany dla pełnego zdalnego PWA, mikrofonu i stabilnych sesji;
- CLI uczestnik grupy może być reprezentowany przez trwały shadow profil
  harnessu;
- natywne aplikacje sklepowe iOS/Android nie są częścią desktopowego release;
- OAuth dla dowolnego MCP nie jest automatycznie dostępny bez konfiguracji
  danego connectora;
- automatyczne aktualizacje Windows zależą od poprawnego feedu i release
  assetów oraz są ograniczone konfiguracją kanału.

---

## 25. Mapa endpointów API

Poniżej znajduje się mapa rodzin endpointów, nie instrukcja omijania autoryzacji.
Większość tras wymaga tokena albo device session.

### 25.1. Health i auth

- `GET /api/health`;
- `GET /api/public/handshake`;
- `GET /api/public/server`;
- `GET /api/auth/status`;
- `POST /api/setup/server`;
- `POST /api/auth/register`;
- `POST /api/auth/login`;
- `POST /api/auth/recover`;
- `POST /api/auth/session`;
- `POST /api/auth/access-token`;
- `POST /api/auth/logout`;
- `POST /api/auth/logout-all`;
- `GET /api/auth/sessions`;
- `DELETE /api/auth/sessions/:id`.

### 25.2. Workspace i użytkownicy

- `GET /api/workspace`;
- `GET /api/workspace/members`;
- `GET /api/server`;
- `PATCH /api/server`;
- `GET /api/server/members`;
- `PUT /api/config` dla profilu i konfiguracji.

`GET /api/workspace` zwraca ID i nazwę workspace, listę members oraz
`currentUser`. Brak tej trasy oznacza niezgodność klienta z serwerem, a nie
problem po stronie samego komponentu UI.

### 25.3. Boty i rozmowy

- `/api/bots`;
- `/api/bots/:id`;
- `/api/bots/:id/messages`;
- `/api/bots/:id/attachments`;
- `/api/bots/:id/access`;
- `/api/bots/:id/autonomy`;
- `/api/bots/:id/permissions`;
- `/api/bots/:id/approval-rules`;
- `/api/search`;
- `/api/events`.

### 25.4. Pamięć

- `/api/memory/team/facts`;
- `/api/memory/team/markdown`;
- `/api/bots/:id/memory/facts`;
- `/api/bots/:id/memory/markdown`;
- `/api/bots/:id/memory/graph`;
- endpoint usage bota.

### 25.5. Współpraca

- `/api/groups`;
- `/api/groups/:id`;
- `/api/groups/:id/members`;
- `/api/groups/:id/chat`;
- `/api/rooms`;
- `/api/rooms/:id`;
- `/api/team-map`;
- `/api/teams/scout`;
- `/api/teams/import`.

### 25.6. Skills i routines

- `/api/bots/:id/skills`;
- `/api/skills`;
- `/api/bots/:id/routines`;
- `/api/routines/:id`;
- `/webhooks/:id`;
- endpointy progress dla uruchomień.

### 25.7. Device i provisioning

- `/api/device`;
- `/api/device/resources`;
- `/api/provision`;
- `/api/progress/:id`;
- `/api/cli-tools`;
- `/api/cli-tools/:id/install`.

### 25.8. Modele, connectory i MCP

- `/api/instances`;
- `/api/models/custom`;
- `/api/models/custom/:id`;
- `/api/connectors/catalog`;
- `/api/connectors/google-workspace`;
- `/api/connectors`;
- `/api/connectors/custom/:id`;
- `/api/mcp-servers`.

### 25.9. Computer i debug

- endpointy computer proxy;
- endpointy noVNC/WebSocket;
- `/api/bots/:id/inspector`;
- `/api/bots/:id/inspector/replay`.

---

## 26. Komendy użytkowe

### 26.1. Development

~~~sh
pnpm install
pnpm dev:server
pnpm dev
~~~

Porty developerskie:

- Vite: `127.0.0.1:5199`;
- harness: `127.0.0.1:8799`.

### 26.2. Sprawdzanie jakości

~~~sh
npx tsc -b
npx tsc -p tsconfig.server.build.json
npx vitest run
npx vite build
node scripts/selfhost-check.mjs
~~~

### 26.3. Windows release

~~~powershell
$env:TEMP = "D:\tmp"
$env:TMP = "D:\tmp"
$env:ELECTRON_BUILDER_CACHE = "D:\electron-builder-cache"
pnpm package:win
~~~

Przed releasem trzeba sprawdzić:

- package version;
- `latest.yml`;
- nazwę EXE;
- blockmap;
- brak zmian w vendored updater po buildzie;
- brak sekretów w diffie;
- działanie instalatora;
- zgodność release feedu z assetami.

---

## 27. Bezpieczeństwo publicznego repozytorium

Repozytorium jest przeznaczone do publicznego udostępniania. Publiczny kod
może zawierać schematy, nazwy endpointów, domyślne style i dokumentację, ale
nie może zawierać danych konkretnej instalacji.

Nigdy nie commitować:

- `.env`;
- API keys;
- access tokenów;
- tokenów sesji i API;
- webhook HMAC secretów;
- prywatnych URL-i serwera;
- adresów LAN;
- transcriptów rozmów;
- uploadów;
- wygenerowanych profili;
- lokalnych logów z sekretami;
- danych kolegów i członków workspace.

Zasady implementacyjne:

- sekrety write-only;
- redakcja diagnostyki;
- rotacja/wylogowanie zamyka sesje;
- hasło serwera dopuszcza rejestrację nowych profili;
- ACL sprawdzane na serwerze, nie tylko w React;
- SSRF/loopback restrictions dla proxy;
- osobne cookie/session handling dla WebSocket;
- walidacja długości i formatu wejścia;
- ograniczenie rozmiaru załączników/payloadów;
- brak zaufania do tekstu webhooka jako instrukcji;
- brak publicznego zwracania pełnej konfiguracji providerów.

Open source nie oznacza publicznego dostępu do workspace. Kod może być publiczny,
ale dane, tokeny i transcript pozostają prywatne operatora.

---

## 28. Znane różnice między dokumentacją a starszymi opisami

Ten plik jest aktualnym opisem wersji `0.2.1` i protokołu v2. Wcześniejsze materiały mogą
mieć następujące nieaktualne założenia:

- Agent mail i Team map jako pozycje stopki sidebara zamiast menu `⋮`;
- brak back w onboardingu;
- `Set up a server` bez możliwości powrotu;
- brak kroku profilu i Shared workspace w onboardingu;
- chwilowe pokoje współpracy wygaszane po kilku minutach;
- osobny `X` w ustawieniach bota;
- Updates i Tools w innej kolejności;
- jeden timestamp przy każdej wiadomości;
- natywny Windows tooltip dublujący hover card;
- brak animacji mascotów podczas pracy;
- `/api/workspace` niedostępne w starym harnessie;
- update feed z uszkodzonym tekstem błędu doklejonym do URL.

Jeśli zachowanie uruchomionej aplikacji różni się od tego dokumentu, najpierw
sprawdzić, czy desktop i serwer pochodzą z tego samego release. Potem sprawdzić
commit źródłowy i logi, zamiast zakładać, że opis lub stary proces jest aktualny.

---

## 29. Zakres wersji `0.2.1` / protokół v2

Wersja zamyka bieżący zestaw zmian związanych z:

- przywróceniem działającego packagingu desktopowego;
- profilem użytkownika podczas onboardingu;
- możliwością cofnięcia się z każdego kroku onboardingu;
- przejściem `Set up a server` z powrotem do ekranu wyboru;
- krokiem Shared workspace;
- integracją workspace access, members i server-password onboardingiem;
- utrzymaniem modelu osobna pamięć bota + wspólna pamięć zespołu;
- bieżącym układem App Settings: General → Tools → Updates;
- przeniesieniem Agent mail i Team map do menu `⋮`;
- trwałymi pokojami współpracy dostępnymi po czasie i restarcie;
- sekcjami, ich zwijaniem, chiefs i przenoszeniem botów;
- mascotami, stanami pracy i animacjami;
- zabezpieczeniami aktualizacji i release assetów.

Wersja nie udaje, że rozwiązuje wszystkie przyszłe elementy multi-user. Nadal
trzeba osobno monitorować reverse proxy, prywatne ACL, sekretne connectory i
politykę dostępu do team memory.

---

## 30. Krótka definicja gotowego workspace

Workspace jest poprawnie skonfigurowany, gdy:

- serwer odpowiada na `/api/health` i `/api/workspace`;
- klient ma poprawną sesję lub krótkotrwały token API;
- owner widzi członków i może zmienić nazwę/hasło serwera;
- drugi użytkownik dołącza własnym profilem;
- wspólne boty i sekcje są widoczne obu osobom;
- private bot jest widoczny tylko ACL;
- bot ma własną pamięć;
- team memory jest wspólna;
- Agent mail zapisuje wątek po reloadzie;
- room współpracy można otworzyć później;
- update feed zwraca poprawny release bez doklejonego tekstu błędu;
- `latest.yml`, EXE i blockmap mają tę samą wersję;
- żaden sekret nie trafił do repozytorium ani release notes.
