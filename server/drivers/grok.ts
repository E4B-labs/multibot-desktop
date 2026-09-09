// Chat-completions driver — an OpenAI-compatible `/chat/completions` endpoint
// with SSE streaming. Unlike the CLI drivers this one is transcript-replay: the
// server hands it the folded thread history each turn (SendTurnInput.transcript)
// and it emits true token-level content.delta events. Also supplies the
// instance's generateText (bot titles, thread names) — upstream's TextGeneration
// slot.
//
// Two drivers come out of the same factory because the wire format is the same:
// `grok` (xAI, fixed url and model list) and `openaiCompatible` (multibot: the
// endpoint the user configures under /api/models/custom — Ollama, LM Studio,
// OpenRouter). The second one used to run on the Python engine as driver
// `slafy`; the engine is gone, the feature is not.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

export interface ChatCompletionsConfig {
  url: string;
  /** resolved at create-time from instance environment / app config */
  apiKeyEnv: string;
  /** multibot: per-instance endpoint+model for user-configured custom models */
  model?: { default?: string; baseUrl?: string };
}

export type ModelCatalog = ProviderDriver["models"];

interface DriverSpec {
  driverKind: string;
  displayName: string;
  defaultUrl: string;
  defaultApiKeyEnv: string;
  models: ModelCatalog;
  /** wire name in the native transcript log */
  logSource: string;
  /** model used for short generateText calls (titles); falls back to models.default */
  titleModel?: string;
  /** what to tell the user when the instance cannot answer */
  keyHint: (env: string) => string;
  /** false for a self-hosted endpoint, which usually needs no key at all */
  requiresKey: boolean;
  /** extra unavailability check, e.g. "no endpoint configured" */
  unavailableReason?: (config: ChatCompletionsConfig) => string | null;
  /** multibot: custom-model instances carry their own single model */
  modelsFor?: (config: ChatCompletionsConfig) => ModelCatalog;
}

function makeChatCompletionsDriver(spec: DriverSpec): ProviderDriver<ChatCompletionsConfig> {
  const DRIVER_KIND = spec.driverKind;

  const decodeConfig = (raw: unknown): ChatCompletionsConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const model = (o.model ?? undefined) as ChatCompletionsConfig["model"];
    return {
      // A custom instance stores its endpoint under `model.baseUrl` (that is the
      // shape /api/models/custom writes), so it doubles as the driver url.
      url: typeof o.url === "string" ? o.url : (typeof model?.baseUrl === "string" ? model.baseUrl : spec.defaultUrl),
      apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : spec.defaultApiKeyEnv,
      ...(model ? { model } : {}),
    };
  };

  return {
  driverKind: DRIVER_KIND,
  metadata: { displayName: spec.displayName, supportsMultipleInstances: true },
  models: spec.models,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ChatCompletionsConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const MODELS = spec.modelsFor?.(config) ?? spec.models;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: Array<{ role: string; content: string }>,
      model: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, stream: opts.stream }),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${spec.displayName} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
        };
      }
      let text = "";
      let usage: { input: number; output: number } | null = null;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
          if (chunk.usage) {
            usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
          }
        }
      }
      return { text, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (spec.requiresKey && !apiKey) throw new Error(spec.keyHint(config.apiKeyEnv));
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, { dir: "out", source: spec.logSource, msg: { model: turn.model, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });

      (async () => {
        try {
          const { text, usage } = await complete(messages, turn.model || MODELS.default, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta) =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
          });
          appendNative(threadId, { dir: "in", source: spec.logSource, msg: { text, usage } });
          if (text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
          }
          if (usage) {
            emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const missing = spec.unavailableReason?.(config) ?? null;
      if (missing) return { state: "unavailable", reason: missing };
      if (spec.requiresKey && !apiKey) {
        return { state: "unavailable", reason: spec.keyHint(config.apiKeyEnv) };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // This transcript-only API driver has no function/tool-call loop.
        // Marking it explicitly prevents the harness from promising web tools
        // that the xAI chat-completions request cannot execute.
        capabilities: { sessionModelSwitch: "in-session", webTools: "none" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => {
          throw new Error(`${DRIVER_KIND} driver has no pending asks`);
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text } = await complete([{ role: "user", content: prompt }], spec.titleModel ?? MODELS.default, { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },  };
}

export const GrokDriver = makeChatCompletionsDriver({
  driverKind: "grok",
  // "(API)" distinguishes this key-billed driver from grokAgent, the CLI one
  displayName: "Grok (API)",
  defaultUrl: "https://api.x.ai/v1",
  defaultApiKeyEnv: "XAI_API_KEY",
  models: {
    default: "grok-4",
    options: [
      { id: "grok-4", label: "Grok 4" },
      { id: "grok-4-fast", label: "Grok 4 Fast" },
      { id: "grok-3-mini", label: "Grok 3 Mini" },
    ],
  },
  logSource: "xai.chat.completions",
  titleModel: "grok-3-mini",
  requiresKey: true,
  keyHint: (env) =>
    `no xAI API key — add {"xai":{"key":"xai-…"}} to ~/.multibot/config.json or set ${env}`,
});

/** multibot: a model endpoint the user configured by hand (/api/models/custom).
 * Its url and its single model both come from the instance config, so the
 * driver-level catalogue is empty until an instance is created. */
export const OpenAiCompatibleDriver = makeChatCompletionsDriver({
  driverKind: "openaiCompatible",
  displayName: "OpenAI-compatible",
  defaultUrl: "",
  defaultApiKeyEnv: "OPENAI_API_KEY",
  models: { default: "", options: [] },
  logSource: "openai.chat.completions",
  // A self-hosted endpoint (Ollama, LM Studio) usually needs no key; what it
  // cannot do without is an address and a model name.
  requiresKey: false,
  keyHint: (env) => `endpoint refused the request — set ${env} if it needs a key`,
  unavailableReason: (config) =>
    config.url && config.model?.default ? null : "no endpoint configured — set a base URL and a model",
  modelsFor: (config) => {
    const id = config.model?.default;
    return id ? { default: id, options: [{ id, label: id }] } : { default: "", options: [] };
  },
});
