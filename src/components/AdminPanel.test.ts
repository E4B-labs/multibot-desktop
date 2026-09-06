import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADMIN_POLL_MS, adminErrorText, isServerName, relativeTime, uptimeText } from "./AdminPanel";

const source = readFileSync(new URL("./AdminPanel.tsx", import.meta.url), "utf8");

describe("admin polling", () => {
  it("polls every ten seconds", () => {
    expect(ADMIN_POLL_MS).toBe(10000);
  });

  it("puts exactly one route on the interval", () => {
    // Everything else in this tab is read once or on a click. A second polled
    // route would double the traffic to a server that may be a phone.
    const polled = source.slice(source.indexOf("const load = "), source.indexOf("setInterval(load, ADMIN_POLL_MS)"));
    expect(polled).toContain("/api/admin/overview");
    expect(polled.match(/\/api\//g)).toEqual(["/api/"]);
    expect(source.match(/setInterval/g)).toHaveLength(1);
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);

  it("says how long ago, not when", () => {
    expect(relativeTime(now - 3 * 60_000, now, "en")).toBe("3 minutes ago");
    expect(relativeTime(now - 5 * 3_600_000, now, "en")).toBe("5 hours ago");
    expect(relativeTime(now - 2 * 86_400_000, now, "en")).toBe("2 days ago");
  });

  it("collapses anything inside the last second to 'now'", () => {
    expect(relativeTime(now - 200, now, "en")).toBe("now");
  });

  it("has a dash for a user who has never been seen", () => {
    expect(relativeTime(undefined, now, "en")).toBe("—");
    expect(relativeTime(null, now, "en")).toBe("—");
  });
});

describe("uptimeText", () => {
  it("drops to days once there are any", () => {
    expect(uptimeText(3 * 86_400_000 + 4 * 3_600_000, false)).toBe("3d 4h");
    expect(uptimeText(90 * 60_000, false)).toBe("1h 30m");
    expect(uptimeText(undefined, false)).toBe("—");
  });
});

describe("isServerName", () => {
  it("keeps the server's own rule — the name gets typed into another device", () => {
    expect(isServerName("brave-otter")).toBe(true);
    expect(isServerName("ab")).toBe(false);
    expect(isServerName("-leading")).toBe(false);
    expect(isServerName("Upper-Case")).toBe(false);
  });
});

describe("adminErrorText", () => {
  it("turns the server's own refusals into something actionable", () => {
    expect(adminErrorText("owner access required", false)).toContain("owner");
    expect(adminErrorText("invalid server name", true)).toContain("Nazwa serwera");
    // Klucze przepisane WPROST z server/identity.ts — literówka tutaj znaczy
    // surowy kod na ekranie właściciela.
    expect(adminErrorText("last_owner", false)).toContain("lock everyone out");
    expect(adminErrorText("no_such_profile", true)).toContain("Tego profilu");
    expect(adminErrorText("cannot reset another owner", false)).toContain("own code");
    expect(adminErrorText("too many attempts", false)).toContain("Wait a minute");
  });

  it("still shows an unknown code rather than swallowing it", () => {
    expect(adminErrorText("brand_new_code", false)).toContain("brand_new_code");
  });
});

describe("destructive actions ask first", () => {
  it("rotate, reset and disable all confirm before they run", () => {
    // Each of the three is irreversible for somebody else: a rotated password
    // locks out every device, a reset invalidates a profile password, disabling
    // shuts a person out. Three actions, three confirmations.
    expect(source.match(/window\.confirm/g)).toHaveLength(3);
  });

  it("shows a once-only credential in a box that has to be dismissed by hand", () => {
    expect(source).not.toContain("window.alert");
    expect(source).toContain("SecretBox");
  });
});
