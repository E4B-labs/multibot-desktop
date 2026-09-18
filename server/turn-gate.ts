// Ile tur floty chodzi NARAZ.
//
// Boty pracują równolegle — jeden bot to jedna tura na raz (pilnuje tego flaga
// `busy`), ale dwa różne boty nie mają powodu czekać na siebie. Jedyne, co ich
// łączy, to maszyna pod spodem, więc ograniczamy tylko LICZBĘ jednoczesnych
// tur, a nie ich kolejność.
//
// Historia: pierwsza wersja brała na całą turę wyłączną dzierżawę wspólnego
// pulpitu, przez co drugi bot ruszał dopiero po pierwszym — flota wyglądała na
// szeregową, choć nic tego nie wymagało.
//
// ponytail: klucz to id bota, a wejście jest re-entrantne — tura zagnieżdżona
// na tym samym bocie nie bierze drugiego slotu i nie zakleszcza się o siebie.
// Gdyby kiedyś trzeba było liczyć każdą turę osobno, kluczem staje się turnId.

/** Domyślny sufit: cztery tury naraz mieszczą się na laptopie i na telefonie. */
export const DEFAULT_MAX_PARALLEL_TURNS = 4;

export function maxParallelTurns(): number {
  const raw = Number(process.env.MULTIBOT_MAX_PARALLEL_TURNS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_PARALLEL_TURNS;
}

export class TurnGate {
  private active = new Set<string>();
  private waiters: Array<{ key: string; resolve: () => void }> = [];

  /** Wolny slot → od razu; komplet → FIFO, w kolejności zgłoszeń. */
  acquire(key: string): Promise<void> {
    if (this.active.has(key)) return Promise.resolve();
    if (this.active.size < maxParallelTurns()) {
      this.active.add(key);
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push({ key, resolve }));
  }

  /** Zwolnienie klucza, który slotu nie miał, jest bezpieczne (koniec tury woła
   *  to bezwarunkowo). */
  release(key: string): void {
    if (!this.active.delete(key)) {
      const waiting = this.waiters.findIndex((w) => w.key === key);
      if (waiting >= 0) this.waiters.splice(waiting, 1);
      return;
    }
    while (this.waiters.length && this.active.size < maxParallelTurns()) {
      const next = this.waiters.shift()!;
      this.active.add(next.key);
      next.resolve();
    }
  }

  state(): { active: string[]; waiting: string[] } {
    return { active: [...this.active], waiting: this.waiters.map((w) => w.key) };
  }

  /** Hook testowy/restartowy: żadna tura nie przeżywa restartu harnessa. */
  reset(): void {
    this.active.clear();
    this.waiters.splice(0).forEach((w) => w.resolve());
  }
}

/** Jedna brama na instalację — harness i panel komputera patrzą na ten sam stan. */
export const turnGate = new TurnGate();
