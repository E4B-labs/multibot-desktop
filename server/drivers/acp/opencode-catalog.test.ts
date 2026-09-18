import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OpenCodeCatalogStore,
  OPENCODE_GO_MODELS_URL,
  parseOpenCodeCatalog,
} from "./opencode-catalog.ts";

const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response;

describe("OpenCode model catalog", () => {
  let scratch = "";

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("keeps all Go models but only free Zen models", () => {
    const catalog = parseOpenCodeCatalog(
      { data: [{ id: "gpt-5.6-luna" }, { id: "grok-4.6" }] },
      { data: [
        { id: "big-pickle" },
        { id: "mimo-v2.5-free" },
        { id: "paid-model" },
        { id: "zero-price", pricing: { input: 0, output: 0 } },
      ] },
      "2026-08-31T12:00:00.000Z",
    );

    expect(catalog.go.options.map((option) => option.id)).toEqual([
      "opencode-go/gpt-5.6-luna",
      "opencode-go/grok-4.6",
    ]);
    expect(catalog.zen.options.map((option) => option.id)).toEqual([
      "opencode/big-pickle",
      "opencode/mimo-v2.5-free",
      "opencode/zero-price",
    ]);
    expect(catalog.zen.options.map((option) => option.id)).not.toContain("opencode/paid-model");
  });

  it("default falls back to first option when preferred id missing", () => {
    const catalog = parseOpenCodeCatalog(
      { data: [{ id: "grok-4.6" }, { id: "kimi-k2.5" }] },
      { data: [{ id: "big-pickle" }] },
      "2026-09-05T00:00:00.000Z",
    );

    // Luna zniknęła z katalogu — default schodzi na kolejny znany model Go,
    // a nigdy na id Zen (na tym stoi bramka klucza w ModelPickerze).
    expect(catalog.go.default).toBe("opencode-go/grok-4.6");

    const unknownOnly = parseOpenCodeCatalog(
      { data: [{ id: "brand-new-model" }] },
      { data: [{ id: "big-pickle" }] },
      "2026-09-05T00:00:00.000Z",
    );
    expect(unknownOnly.go.default).toBe("opencode-go/brand-new-model");
  });

  it("uses cache within 12 hours and keeps it after fetch failure", async () => {
    scratch = mkdtempSync(join(tmpdir(), "multibot-opencode-catalog-"));
    const cachePath = join(scratch, "opencode-models.json");
    let calls = 0;
    const fetcher: typeof fetch = async (url) => {
      calls += 1;
      return response(url.toString() === OPENCODE_GO_MODELS_URL
        ? { data: [{ id: "go-model" }] }
        : { data: [{ id: "big-pickle" }] });
    };
    const store = new OpenCodeCatalogStore(fetcher, cachePath);

    await store.refresh(true);
    expect(calls).toBe(2);
    await store.refresh();
    expect(calls).toBe(2);
    expect(store.go.options[0]?.id).toBe("opencode-go/go-model");

    const failed = new OpenCodeCatalogStore(async () => response({}, false), cachePath);
    await failed.refresh(true);
    expect(failed.go.options[0]?.id).toBe("opencode-go/go-model");
    expect(failed.lastRefreshSucceeded).toBe(false);
  });

  it("falls back to bundled free models when first fetch fails", async () => {
    scratch = mkdtempSync(join(tmpdir(), "multibot-opencode-catalog-"));
    const store = new OpenCodeCatalogStore(async () => response({}, false), join(scratch, "missing.json"));
    await store.refresh(true);
    expect(store.go.options.map((option) => option.id)).toContain("opencode-go/gpt-6-astra");
    expect(store.go.default).toBe("opencode-go/gpt-5.6-luna");
    expect(store.zen.options.map((option) => option.id)).toContain("opencode/big-pickle");
  });
});
