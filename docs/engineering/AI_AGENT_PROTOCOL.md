# Protokół dla agentów AI

Ten repozytorium rozwijają trzy osoby i dowolna liczba agentów kodujących.
Protokół jest jeden i nie zależy od dostawcy: Claude Code, Codex, OpenCode,
Cline, agenty MultiBota i to, co przyjdzie po nich, podlegają tym samym regułom.
System ma przetrwać wymianę wszystkich narzędzi naraz.

Kanonem jest [`../../AGENTS.md`](../../AGENTS.md). Ten plik dodaje to, co dotyczy
wyłącznie agentów.

## 1. Start

Pełna lista kroków startowych jest w `AGENTS.md` §1. Trzy rzeczy, na których
agenty wykładają się najczęściej:

- **Ścieżkę repo ustalasz dynamicznie** (`git rev-parse --show-toplevel`).
  Nigdy nie zakładasz litery dysku ani katalogu — każdy z trzech deweloperów ma
  repo gdzie indziej i to jest w porządku.
- **Sprawdzasz gałąź, zanim cokolwiek napiszesz.** `main` → STOP.
- **`git fetch origin` przed założeniem gałęzi.** Baza to aktualny `origin/main`,
  nie to, co miałeś w cache'u.

Stan repo opisujesz przez remote, katalog główny, gałąź, SHA commitu i PR —
nigdy przez ścieżkę lokalną.

## 2. Własność zapisu

Każde aktywne zadanie ma **dokładnie jednego właściciela zapisu**. Może nim być
Kacper, Bartek, Mieszko albo wskazany agent działający w imieniu jednego z nich.

Jeśli nad jednym zadaniem pracuje kilka agentów, jeden pisze, reszta:

- bada kod i szuka faktów,
- recenzuje,
- analizuje,
- proponuje łatki do zastosowania przez właściciela zapisu.

Równoległe odczyty są darmowe i pożądane. Równoległe zapisy w tym samym drzewie
są zabronione.

## 3. Wykrywanie kolizji — przed implementacją, nie po

```sh
gh pr list --repo E4B-labs/multibot-desktop
git fetch origin && git branch -r
git log --oneline origin/main -20
```

Szukasz: tych samych plików, tego samego modułu, zmian w kształcie zapisanych
danych, zmian w `server/contracts.ts`, dwóch gałęzi ruszających
`server/index.ts`. Znalazłeś nakładkę — zgłoś ją i ustal kolejność. Cicha
duplikacja pracy kosztuje więcej niż jedno pytanie.

Największe punkty zapalne repo (duże pliki, w które trafia niemal każda zmiana)
wypisuje [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 4. Kilka agentów na jednej maszynie

Osobne zadanie = osobna gałąź = osobny worktree = osobny terminal = osobny PR.

```
Claude Code  → kacper/feat/billing    → worktree A
Codex        → kacper/feat/dashboard  → worktree B
OpenCode     → kacper/fix/auth        → worktree C
Cline        → kacper/feat/settings   → worktree D
```

Dwa agenty z prawem zapisu w jednym katalogu nadpiszą sobie pliki, a git tego
nie zgłosi — zobaczysz to dopiero jako zniknięty kod w PR. To nie jest
ostrożnościowa rekomendacja, tylko twardy zakaz.

Osobne komputery dają izolację systemu plików, ale **nie dają izolacji na
poziomie gita**. Każde niezależne zadanie i tak potrzebuje własnej gałęzi.

## 5. Adaptery narzędzi

| Narzędzie | Jak trafia do protokołu |
|---|---|
| Claude Code | czyta `CLAUDE.md`, który wskazuje na `AGENTS.md` jako nadrzędny |
| Codex, OpenCode | czytają `AGENTS.md` natywnie |
| Cline i pozostałe (obecne i przyszłe) | **muszą przeczytać `AGENTS.md` przed pierwszą zmianą w repo**; jeśli narzędzie ma własny plik reguł, ma on wyłącznie wskazywać na `AGENTS.md` i nie może zawierać reguł sprzecznych |
| agenty MultiBota | ten sam protokół; działają w imieniu konkretnej osoby i używają jej nazwy w gałęzi |

Nie ma i nie będzie osobnych, sprzecznych zestawów reguł dla poszczególnych
narzędzi. Jeden protokół, wielu klientów. Plik narzędziowy, który zaczyna
powielać reguły zamiast na nie wskazywać, jest błędem do naprawienia.

## 6. Dowód zamiast przekonania

Zadanie jest zrobione, gdy wkleisz wyjście bramek z liczbami i link do PR.
„Powinno działać" nie jest dowodem. Przy diagnozie: najpierw złap błąd z konsoli
albo z logu, dopiero potem edytuj kod. Nietrywialna logika zostawia jeden
uruchamialny test — test, który nie pada na starym kodzie, niczego nie pilnuje.

## 7. Pamięć zespołu

Wszystko, co będzie prawdziwe także jutro — decyzja wraz z powodem, pułapka,
przepis na wydanie, aktualny stan kanałów — idzie do pamięci zespołu na dysku
Kacpra: `G:RAG-Second BrainrainconceptMultiBot.md` (sekcje `zasady`,
`decyzje`, `pulapki`, `stack`, `wdrozenie`, `stan`), w tej samej turze,
w której to ustalisz. Przed pracą nad znanym tematem przeczytaj ten plik i
`brain/INDEX.md`. Pliki lokalne to podręczny cache, nie źródło prawdy.
Dawny TaskTree Brain (Supabase, narzędzia `brain_*`) nie istnieje od 17.09.2026.

Do pamięci **nigdy** nie trafiają wartości sekretów — wyłącznie ich nazwy.
