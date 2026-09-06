import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addressNote, authRequest, backLeavesWizard, credentialsText, joinErrorField, joinErrorText, joinPlan, nextStep, previousStep, startingPoint } from "./Onboarding";

// Vitest runs in `node` here and the repo has no jsdom, so the screens
// themselves are not rendered (same as WindowControls.test.ts). Everything that
// can break silently is a pure function instead, and the rest is guarded in the
// source text.
const source = readFileSync(new URL("./Onboarding.tsx", import.meta.url), "utf8");


describe("onboarding: the two paths", () => {
  it("walks setup from the choice to a finished profile", () => {
    expect(nextStep("setup", "choice")).toBe("installing");
    expect(nextStep("setup", "installing")).toBe("credentials");
    expect(nextStep("setup", "credentials")).toBe("profile");
    expect(nextStep("setup", "profile")).toBe("working");
    expect(nextStep("setup", "working")).toBe("done");
    expect(nextStep("setup", "done")).toBe("done");
  });

  it("walks join through sign-in and the profile question", () => {
    expect(nextStep("join", "choice")).toBe("signin");
    expect(nextStep("join", "signin")).toBe("profileKind");
    expect(nextStep("join", "profileKind")).toBe("profile");
    expect(nextStep("join", "profile")).toBe("working");
    expect(nextStep("join", "working")).toBe("done");
  });

  it("never crosses the two paths", () => {
    // `installing` belongs to setup only, `signin` to join only: asking the
    // wrong path for them has to be a no-op, not a jump into the other flow.
    expect(nextStep("join", "installing")).toBe("installing");
    expect(nextStep("setup", "signin")).toBe("signin");
  });

  it("recovery hangs off the profile screens, not off the line", () => {
    // Nie jest krokiem w żadnej ścieżce, więc `nextStep` go nie dotyka; wstecz
    // wraca tam, skąd się do niego wchodzi.
    expect(nextStep("join", "recover")).toBe("recover");
    expect(previousStep("join", "recover")).toBe("signin");
    expect(previousStep("setup", "recover")).toBe("profile");
  });

  it("walks back the way it came and stops at the choice", () => {
    expect(previousStep("join", "profileKind")).toBe("signin");
    expect(previousStep("join", "signin")).toBe("choice");
    expect(previousStep("join", "choice")).toBe("choice");
    expect(previousStep("setup", "credentials")).toBe("installing");
  });
});

describe("joinErrorField", () => {
  it("points at the address when the address is what failed", () => {
    for (const code of ["invalid_address", "unreachable", "timeout", "not_multibot", "server_not_set_up", "certificate_changed", "insecure_address"]) {
      expect(joinErrorField(code)).toBe("address");
    }
  });

  it("separates the two credentials — that is the whole point of the rewrite", () => {
    expect(joinErrorField("wrong_server_name")).toBe("name");
    expect(joinErrorField("wrong_server_password")).toBe("password");
  });

  it("points at the profile fields for the profile call's own refusals", () => {
    expect(joinErrorField("invalid username")).toBe("profileName");
    expect(joinErrorField("profile_name_taken")).toBe("profileName");
    expect(joinErrorField("no_such_profile")).toBe("profileName");
    expect(joinErrorField("wrong_profile_password")).toBe("profilePassword");
    expect(joinErrorField("password must contain 12-128 characters")).toBe("profilePassword");
  });

  it("puts anything else on the form", () => {
    expect(joinErrorField("rate_limited")).toBe("form");
    expect(joinErrorField("forbidden")).toBe("form");
    expect(joinErrorField("something_new")).toBe("form");
  });
});

describe("credentialsText", () => {
  it("is exactly the four lines that get typed into another device", () => {
    expect(credentialsText({ serverName: "brave-otter", address: "https://192.168.1.42:8799", serverPassword: "7f3k-92xa-qq5m" })).toBe(
      "MultiBot server\nName: brave-otter\nAddress: https://192.168.1.42:8799\nPassword: 7f3k-92xa-qq5m",
    );
  });
});

describe("addressNote", () => {
  const base = { serverName: "brave-otter", serverPassword: "x", address: "https://10.0.0.5:8799" };

  it("says nothing when the server has not reported how it found the address", () => {
    expect(addressNote(base, false)).toBeNull();
    expect(addressNote(null, false)).toBeNull();
  });

  it("names each limit the person has to know about", () => {
    expect(addressNote({ ...base, addressKind: "ipv4-lan" }, false)).toContain("Wi-Fi");
    expect(addressNote({ ...base, addressVerified: false }, false)).toContain("outside");
    expect(addressNote({ ...base, portMapping: { state: "cgnat" } }, false)).toContain("carrier");
    expect(addressNote({ ...base, portMapping: { state: "cgnat" } }, true)).toContain("Operator");
  });
});

describe("onboarding source", () => {
  it("no longer calls the retired provisioning route", () => {
    // `/api/provision` is gone server-side in this PR; a call left here would
    // 404 on a fresh install, which is exactly the screen that cannot fail.
    expect(source).not.toContain("/api/provision");
    expect(source).not.toContain("/api/progress/");
  });

  it("never shows a credential in a dialog you cannot copy from", () => {
    // The recovery code is shown once. `window.alert` loses it to a stray
    // Enter key and leaves nothing to select.
    expect(source).not.toContain("window.alert");
  });
});

describe("joinPlan", () => {
  const values = { serverName: "brave-otter", serverPassword: "7f3k", address: "https://10.0.0.5:8799" };

  it("setup joins with the values it already read — nobody retypes them", () => {
    expect(joinPlan("setup", "", values)).toEqual({ kind: "join", serverName: "brave-otter", serverPassword: "7f3k" });
  });

  it("a grant already in hand always wins over joining again", () => {
    expect(joinPlan("setup", "g1", values)).toEqual({ kind: "grant", grant: "g1" });
    expect(joinPlan("join", "g1", null)).toEqual({ kind: "grant", grant: "g1" });
  });

  it("nothing to join with is blocked, never a half-filled request", () => {
    expect(joinPlan("join", "", null)).toEqual({ kind: "blocked" });
    expect(joinPlan("setup", "", null)).toEqual({ kind: "blocked" });
    expect(joinPlan("setup", "", { ...values, serverPassword: "" })).toEqual({ kind: "blocked" });
  });
});

describe("authRequest", () => {
  const base = { username: "kacper", displayName: "Kacper", password: "a-long-enough-one", recoveryCode: "", joinGrant: "g1", deviceName: "test", native: false };

  it("a new profile carries its display name, an existing one does not", () => {
    expect(authRequest({ ...base, mode: "register" })).toEqual({
      path: "/api/auth/register",
      headers: {},
      body: { username: "kacper", password: "a-long-enough-one", joinGrant: "g1", deviceName: "test", displayName: "Kacper" },
    });
    expect(authRequest({ ...base, mode: "login" }).body.displayName).toBeUndefined();
    expect(authRequest({ ...base, mode: "login" }).path).toBe("/api/auth/login");
  });

  it("recovery sends its code and calls the password what the server calls it", () => {
    expect(authRequest({ ...base, mode: "recover", recoveryCode: "code-1" })).toEqual({
      path: "/api/auth/recover",
      headers: {},
      body: { username: "kacper", recoveryCode: "code-1", newPassword: "a-long-enough-one", joinGrant: "g1", deviceName: "test" },
    });
    // `password` would be silently ignored by /api/auth/recover.
    expect(authRequest({ ...base, mode: "recover" }).body.password).toBeUndefined();
  });

  it("only a React Native shell asks for a session token — Electron keeps the cookie", () => {
    expect(authRequest({ ...base, mode: "register", native: true }).headers).toEqual({ "x-multibot-client": "native" });
    expect(authRequest({ ...base, mode: "register", native: false }).headers).toEqual({});
  });
});

describe("joinErrorText", () => {
  it("explains the shell refusing to change servers", () => {
    expect(joinErrorText("forbidden", false)).toContain("Restart the app");
    expect(joinErrorText("forbidden", true)).toContain("Uruchom aplikację ponownie");
  });

  it("says the server's own 422 rules in the reader's language", () => {
    expect(joinErrorText("password must contain 12-128 characters", false)).toContain("12 to 128");
    expect(joinErrorText("invalid username", true)).toContain("Nazwa profilu");
    expect(joinErrorText("account unavailable", false)).toContain("disabled");
  });

  it("an unknown code is never reported as a connection problem", () => {
    // The connection was fine; the server said something this build has never
    // seen. Blaming the network sends the reader to fix the wrong thing.
    const text = joinErrorText("some_new_code", false);
    expect(text).toContain("some_new_code");
    expect(text).not.toContain("connect");
  });
});

describe("where onboarding starts", () => {
  // Objaw: po restarcie apki z wybranym hostem zdalnym pokazywał się ekran
  // „postaw serwer / zaloguj się", choć serwer jest już wybrany — a w polu
  // adresu siedziałby origin lokalnego proxy zamiast adresu hosta.
  it("goes straight to sign-in on the host the shell already picked", () => {
    expect(startingPoint("https://192.168.1.42:8799", "http://127.0.0.1:47820")).toEqual({
      step: "signin",
      address: "https://192.168.1.42:8799",
    });
  });

  it("keeps the choice screen everywhere else", () => {
    expect(startingPoint("", "https://127.0.0.1:8799")).toEqual({ step: "choice", address: "https://127.0.0.1:8799" });
  });

  // Objaw: „Wstecz" z ekranu logowania w trybie zdalnym wracało na ekran
  // wyboru, a „Postaw serwer" na nim woła `useLocalHost()` — czyli przycisk
  // cicho zdejmował komputer z hosta, na którym stał.
  it("has nowhere to step back to from the first screen of remote mode", () => {
    expect(backLeavesWizard("https://192.168.1.42:8799", "signin")).toBe(true);
    expect(backLeavesWizard("https://192.168.1.42:8799", "profileKind")).toBe(false);
    expect(backLeavesWizard("", "signin")).toBe(false);
  });
});
