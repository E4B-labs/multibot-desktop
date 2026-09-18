// Jedyna sieć pod całym drzewem paneli. Bez niej jeden błąd renderowania
// odmontowuje aplikację do czarnego ekranu i wraca ona dopiero po
// przeładowaniu okna — tak zachował się panel Admina (React #31, QA 10.09.2026)
// i zabrał ze sobą czat, do którego użytkownik chciał wrócić.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLanguage } from "@/lib/language";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Osobny komponent funkcyjny, bo język czytamy hookiem, a granica musi być
 * klasą — tylko klasa dostaje `getDerivedStateFromError`. */
function CrashCard({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const polish = useLanguage() === "pl";
  return (
    <div className="m-6 max-w-xl rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Coś poszło nie tak" : "Something went wrong"}</div>
      <div className="mt-1 break-words text-[12.5px] text-ink-secondary">{error.message}</div>
      <button type="button" onClick={onRetry} className="mt-3 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">
        {polish ? "Przeładuj panel" : "Reload panel"}
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Zgłaszamy dalej: cichy błąd renderowania to błąd, którego nikt nie naprawi.
    console.error("panel crashed", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <CrashCard error={error} onRetry={() => this.setState({ error: null })} />;
  }
}
