# MultiBot — protokół inżynierski

Kanoniczna, niezależna od narzędzia instrukcja dla **każdego**, kto pisze w tym
repo: człowieka i agenta AI (Claude Code, Codex, OpenCode, Cline, agenty
MultiBota, cokolwiek przyjdzie po nich). Jeden protokół, wiele klientów — nie ma
osobnych reguł dla poszczególnych narzędzi.

Repo: `E4B-labs/multibot-desktop` (publiczne, gałąź domyślna `main`). Aplikacja
mobilna ma osobne repo `E4B-labs/multibot-mobile`. Prywatne notatki wdrożeniowe
właściciela żyją poza remote; podstawowy przepływ pracy ich nie wymaga.

Ten plik jest krótki celowo. Szczegóły: [`docs/engineering/`](docs/engineering/).

## 1. Protokół startowy — zanim dotkniesz kodu

1. Ustal katalog główny (`git rev-parse --show-toplevel`) — nigdy nie zakładaj ścieżki.
2. Przeczytaj ten plik w całości, potem dokumentację dotyczącą zadania (§7).
3. `git status` — drzewo czyste albo świadomie brudne.
4. **Sprawdź gałąź; nie może być `main`.** Jesteś na `main` i masz coś zmienić →
   STOP, załóż gałąź zadaniową i worktree (§3). Sprawdź też, że ten worktree
   należy do tego zadania — jeden worktree, jedno zadanie.
5. `git fetch origin` — baza to aktualny `origin/main`.
6. Zrozum zakres; jeśli jest niejasny, dopytaj przed edycją.
7. Przeczytaj kod, który zmieniasz, zanim go zmienisz. Wypisz moduły, które
   zmiana dotknie (`src/`, `server/`, `electron/`), i testy, które ją udowodnią.
8. Kolizje: `gh pr list --repo E4B-labs/multibot-desktop` i `git branch -r`. Jeśli
   ktoś już rusza te pliki — dogadaj się, nie duplikuj pracy.

## 2. `main` jest święty

Nikt — człowiek ani agent — nie pushuje na `main`. Każda zmiana idzie drogą:

```
ZADANIE → GAŁĄŹ → WORKTREE → COMMITY → PUSH → PR → CI
        → multibot/review → multibot/merge-gate → main
```

Autor nigdy nie akceptuje własnej pracy. Recenzent nie mergeuje. Strażnik bramki
nie przepisuje kodu funkcji. Szczegóły: [`PR_POLICY.md`](docs/engineering/PR_POLICY.md).

## 3. Gałęzie, worktree, własność

Nazwa gałęzi: **`<developer>/<type>/<task>`** — `developer` = `kacper` |
`bartek` | `mieszko`; `type` = `feat` | `fix` | `refactor` | `chore` | `docs` |
`test` | `perf`. Przykłady: `kacper/feat/billing-dashboard`,
`bartek/fix/refresh-token`. Nie zakładamy stałych gałęzi osobowych. Baza zawsze
`origin/main`. Po merge'u gałąź kasujemy.

**Jedno zadanie = jedna gałąź = jeden worktree = jeden PR.**

```sh
git fetch origin
git worktree add <dowolna-lokalna-ścieżka> -b kacper/feat/moja-zmiana origin/main
```

Ścieżka jest lokalna i prywatna dla twojej maszyny — nigdy nie trafia do plików
repo. Kilku agentów na jednej maszynie pracuje w **osobnych** worktree; dwa
agenty piszące w jednym katalogu to gwarantowana kolizja. Jeśli nad jednym
zadaniem pracuje kilku agentów, dokładnie jeden ma prawo zapisu; reszta bada,
recenzuje i proponuje łatki. Szczegóły:
[`BRANCHING.md`](docs/engineering/BRANCHING.md),
[`AI_AGENT_PROTOCOL.md`](docs/engineering/AI_AGENT_PROTOCOL.md).

## 4. Commity

Konwencjonalne, małe, spójne: `feat(auth): add refresh token rotation`.
Zakazane: `update`, `changes`, `fix stuff`, `wip`, `final`, `final2`. Nie łącz
niepowiązanych zmian w jednym commicie. Nie commituj świadomie zepsutego kodu.

## 5. Bramki — dokładnie to, co sprawdza CI

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint            # git diff --check && tsc --noEmit
pnpm typecheck       # tsc -b && tsc -p tsconfig.server.json
pnpm test            # vitest run
pnpm exec vite build # produkcyjny build UI
```

Nietrywialna logika zostawia jeden uruchamialny test obok istniejących — bez
nowych frameworków i bez nowych zależności. Test, który nie pada na starym
kodzie, niczego nie pilnuje. **Dowód, nie przekonanie:** zadanie jest zrobione,
gdy wkleisz wyjście bramki z liczbami. „Powinno działać" się nie liczy.

## 6. Zakazy

1. **Pliki tymczasowe i cache idą tam, gdzie wskazuje właściciel maszyny**
   (`TEMP`/`TMP`, `ELECTRON_BUILDER_CACHE`), nigdy na sztywno w kodzie. Na
   maszynach Kacpra dysk `C:` jest zajęty — nie zapisujesz tam nic.
2. **Nie `git add -A`.** W drzewie bywają cudze niezacommitowane zmiany. Pliki
   dodajesz po nazwie. Nigdy `--force`, nigdy `push --force` na `main`.
3. **Sekrety nigdzie**: ani w repo, ani w logu, ani w raporcie, ani w pamięci
   zespołu (`G:RAG-Second Brain`, tam idą wyłącznie nazwy sekretów). To repo jest publiczne.
4. **Nie zmieniasz `server/contracts.ts`** ani kształtu zapisanych danych bez
   decyzji właściciela.
5. **Nie dokładasz zależności npm** dla czegoś, co robi kilka linii.
6. Żaden plik repo nie zależy od nazwy użytkownika, litery dysku, katalogu
   domowego ani lokalnego adresu IP.

## 7. Dokumentacja inżynierska

| Plik | O czym |
|---|---|
| [`ARCHITECTURE.md`](docs/engineering/ARCHITECTURE.md) | procesy, porty, dane, auth, drivery, punkty kolizji |
| [`WORKFLOW.md`](docs/engineering/WORKFLOW.md) | pełny cykl zadania od fetch do merge'a |
| [`BRANCHING.md`](docs/engineering/BRANCHING.md) | nazewnictwo, baza, rebase, gałęzie do sprzątnięcia |
| [`AI_AGENT_PROTOCOL.md`](docs/engineering/AI_AGENT_PROTOCOL.md) | agenty równoległe, adaptery narzędzi, pamięć zespołu |
| [`PR_POLICY.md`](docs/engineering/PR_POLICY.md) | co musi być w PR, role recenzenta i bramki |
| [`CODE_OWNERSHIP.md`](docs/engineering/CODE_OWNERSHIP.md) | kto trzyma który obszar |
| [`RELEASE.md`](docs/engineering/RELEASE.md) | kanały, numeracja wersji, wydanie desktopu |
| [`REPO_STATE.md`](docs/engineering/REPO_STATE.md) | stan repo, dług, ryzyka, plan migracji |
| [`GITHUB_SETTINGS.md`](docs/engineering/GITHUB_SETTINGS.md) | docelowa ochrona `main` i komendy do jej włączenia |

## 8. Raport po zadaniu

Co zmienione (pliki i po co) · dowód bramek z liczbami · link do PR · czego
**nie** zrobiłeś i dlaczego · co wymaga właściciela (decyzja, token, klik).
