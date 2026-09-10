// Jeden powód, dla którego wiersz modelu w pickerze jest martwy albo przygaszony.
// Serwer liczy `snapshot.authenticated` dla każdego harnessu CLI (acp/core.ts →
// support.isAuthenticated), ale do 0.5.x czytały go tylko Ustawienia aplikacji —
// picker patrzył wyłącznie na `state`. Efekt: Gemini i Qwen z zainstalowanym, ale
// NIEZALOGOWANYM CLI wyglądały na gotowe (wersja, pełna jasność), a użytkownik
// dowiadywał się o braku logowania dopiero z czerwonej pigułki po wysłaniu tury.

export type InstanceGate = "ok" | "missing" | "signin";

interface GateSnapshot {
  state: "available" | "unavailable";
  authenticated?: boolean;
}

// OpenCode jest wyjątkiem świadomym: jego `isAuthenticated` mówi tylko o kluczu
// OpenCode Go, a darmowe modele Zen chodzą anonimowo (PR #73). Ten wpis ma własną
// bramkę klucza per model (`needsKey` w ModelPicker), więc bramka logowania
// zdusiłaby całą listę Zen bez powodu.
const OWN_KEY_GATE = new Set(["opencode"]);

export function instanceGate(snapshot: GateSnapshot, instanceId: string): InstanceGate {
  if (snapshot.state !== "available") return "missing";
  if (snapshot.authenticated === false && !OWN_KEY_GATE.has(instanceId)) return "signin";
  return "ok";
}
