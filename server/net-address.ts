// multibot (0.4.0): "what address do I tell people to type in?" answered
// without a single third party — no tunnel, no STUN, no echo service. The
// ladder is: a globally routable IPv6 straight off an interface, then a public
// IPv4 borrowed from the router over UPnP IGD, then the LAN address with an
// honest "only on this Wi-Fi" label.
//
// Everything above `refreshAddress` is a pure function over strings so the
// tests never open a socket; the I/O (SSDP, SOAP, fetch, the meta store) sits
// at the edges and every network call is wrapped in a timeout + try/catch, so
// a router that answers nothing degrades to "unsupported" instead of hanging
// the boot.
//
// ponytail: UPnP only; add NAT-PMP when a real router refuses it.
import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { isSecureRequest } from "./identity.ts";

export type AddressKind = "ipv6" | "ipv4-upnp" | "ipv4-lan";
export type AddressCandidate = { address: string; kind: AddressKind; verified: boolean; source: string };
export type PortMappingState = "mapped" | "unsupported" | "cgnat" | "error";
export type PortMapping = { state: PortMappingState; externalPort?: number; error?: string };
export type AddressReport = {
  current: string | null;
  verified: boolean;
  checkedAt: number;
  candidates: AddressCandidate[];
  portMapping: PortMapping;
};

/** Every network call gets the same short leash: a router that ignores us must
 * not be able to stall a boot or an owner's request. */
const NET_TIMEOUT_MS = 2_000;
const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const IGD_SERVICE_TYPES = [
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
/** A verification by a real remote client is worth keeping across a restart,
 * but not forever: a phone that reached us on holiday Wi-Fi proves nothing a
 * day later. */
const VERIFIED_TTL_MS = 24 * 3_600_000;
const KIND_ORDER: AddressKind[] = ["ipv6", "ipv4-upnp", "ipv4-lan"];

const META_ADDRESS = "server.publicAddress";
const META_VERIFIED_AT = "server.addressVerifiedAt";
const META_REPORT = "server.addressReport";

// ── address classification (pure) ────────────────────────────────────

function stripV6Prefix(address: string): string {
  const value = address.trim().toLowerCase();
  const zone = value.indexOf("%");
  const bare = zone >= 0 ? value.slice(0, zone) : value;
  return bare.startsWith("::ffff:") ? bare.slice(7) : bare;
}

function v4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/** RFC1918 plus the addresses nobody can route to from the outside. */
export function isPrivateIPv4(address: string): boolean {
  const octets = v4Octets(stripV6Prefix(address));
  if (!octets) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** 100.64.0.0/10 — the carrier's own NAT. An "external" IP in this range means
 * the router is itself behind the ISP's NAT, so no port mapping can help. */
export function isCarrierGradeNat(address: string): boolean {
  const octets = v4Octets(stripV6Prefix(address));
  if (!octets) return false;
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

/** Global unicast IPv6 only: no loopback, no link-local (fe80::/10), no unique
 * local (fc00::/7), no multicast — and none of the transition relics either.
 * Measured on a Windows box: the "Teredo Tunneling Pseudo-Interface" hands out
 * a 2001:0::/32 address that passes every range test and reaches nothing. */
export function isGlobalIPv6(address: string): boolean {
  const value = stripV6Prefix(address);
  if (!value.includes(":")) return false;
  if (value === "::1" || value === "::") return false;
  const groups = value.split(":");
  const head = Number.parseInt(groups[0] || "0", 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((head & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((head & 0xff00) === 0xff00) return false; // ff00::/8
  if (head === 0x2002) return false; // 2002::/16 — 6to4, deprecated
  const second = Number.parseInt(groups[1] || "0", 16) || 0;
  if (head === 0x2001 && (second === 0 || second === 0x0db8)) return false; // Teredo, documentation
  return true;
}

/** True only for an address a stranger on the internet could be coming from. */
export function isPublicRemote(address: string): boolean {
  const value = stripV6Prefix(address);
  if (!value) return false;
  if (v4Octets(value)) return !isPrivateIPv4(value) && !isCarrierGradeNat(value);
  return isGlobalIPv6(value);
}

export function addressFor(host: string, port: number, secure = false): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${secure ? "https" : "http"}://${bracketed}:${port}`;
}

/** The interfaces of this machine, translated into things a person could type.
 * Loopback, link-local and unique-local addresses are dropped: none of them is
 * an answer to "where do I reach you". */
export function candidatesFrom(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number): AddressCandidate[] {
  const found: AddressCandidate[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const isV6 = entry.family === "IPv6" || (entry.family as unknown as number) === 6;
      const bare = stripV6Prefix(entry.address);
      let kind: AddressKind;
      if (isV6) {
        if (!isGlobalIPv6(entry.address)) continue;
        kind = "ipv6";
      } else {
        if (isPrivateIPv4(entry.address)) kind = "ipv4-lan";
        // A public IPv4 sitting directly on an interface (a VPS, a modem in
        // bridge mode) needs no port mapping — it lands in the same bucket as
        // the one UPnP would hand us, because the UI treats both as "reachable
        // from anywhere".
        else if (isCarrierGradeNat(entry.address)) continue;
        else kind = "ipv4-upnp";
      }
      const address = addressFor(isV6 ? bare : entry.address, port);
      if (seen.has(address)) continue;
      seen.add(address);
      found.push({ address, kind, verified: false, source: `interface:${name}` });
    }
  }
  return found.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

// ── UPnP IGD (pure parsers + socket/HTTP edges) ──────────────────────

export function parseSsdpLocation(message: string): string | null {
  for (const line of message.split(/\r?\n/)) {
    const match = /^location:\s*(\S+)/i.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** The IGD description lists several services; only the WAN connection ones can
 * map a port. `controlURL` is allowed to be relative, so it is resolved against
 * the LOCATION the device answered with. */
export function parseControlUrl(xml: string, base: string): { url: string; serviceType: string } | null {
  for (const block of xml.match(/<service\b[\s\S]*?<\/service>/gi) ?? []) {
    const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1];
    const control = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!type || !control || !IGD_SERVICE_TYPES.includes(type)) continue;
    try {
      return { url: new URL(control, base).toString(), serviceType: type };
    } catch {
      return null;
    }
  }
  return null;
}

/** SOAP answers are flat `<NewExternalIPAddress>1.2.3.4</…>` pairs, sometimes
 * namespaced. One regex beats pulling in an XML parser. */
export function parseSoapValue(xml: string, tag: string): string | null {
  if (!/^[A-Za-z][\w.-]*$/.test(tag)) return null;
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, "i").exec(xml);
  return match ? match[1].trim() : null;
}

/** One M-SEARCH shout on the LAN; the first router that answers wins. Never
 * rejects and never outlives its timeout — the boot path calls this. */
export function discoverGateway(timeoutMs = NET_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.on("error", () => finish(null));
    socket.on("message", (message) => finish(parseSsdpLocation(message.toString("utf8"))));
    try {
      socket.bind(() => {
        const search = Buffer.from([
          "M-SEARCH * HTTP/1.1",
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          "MX: 2",
          "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
          "",
          "",
        ].join("\r\n"));
        socket.send(search, 0, search.length, SSDP_PORT, SSDP_ADDRESS, (error) => {
          if (error) finish(null);
        });
      });
    } catch {
      finish(null);
    }
  });
}

async function soap(control: { url: string; serviceType: string }, action: string, args: string): Promise<string | null> {
  const envelope = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${control.serviceType}">${args}</u:${action}></s:Body></s:Envelope>`;
  const response = await fetch(control.url, {
    method: "POST",
    headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${control.serviceType}#${action}"` },
    body: envelope,
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  const text = await response.text();
  return response.ok ? text : null;
}

/** Ask the router for its WAN address and, if that address is really on the
 * internet, punch TCP `port` through to `lanIp`. Lease 0 = "until I say
 * otherwise", which is why `refreshAddress` re-issues it every 10 minutes:
 * plenty of routers quietly drop permanent mappings on reboot. */
export async function mapPort(gateway: string, port: number, lanIp: string): Promise<{ mapping: PortMapping; externalIp?: string }> {
  try {
    const description = await fetch(gateway, { signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
    const control = description.ok ? parseControlUrl(await description.text(), gateway) : null;
    if (!control) return { mapping: { state: "unsupported" } };

    const external = parseSoapValue((await soap(control, "GetExternalIPAddress", "")) ?? "", "NewExternalIPAddress");
    if (!external || !v4Octets(external)) return { mapping: { state: "unsupported" } };
    if (isPrivateIPv4(external) || isCarrierGradeNat(external)) return { mapping: { state: "cgnat" }, externalIp: external };

    const added = await soap(
      control,
      "AddPortMapping",
      `<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort><NewProtocol>TCP</NewProtocol>` +
        `<NewInternalPort>${port}</NewInternalPort><NewInternalClient>${lanIp}</NewInternalClient>` +
        `<NewEnabled>1</NewEnabled><NewPortMappingDescription>MultiBot</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>`,
    );
    if (added === null) return { mapping: { state: "error", error: "AddPortMapping refused" }, externalIp: external };
    return { mapping: { state: "mapped", externalPort: port }, externalIp: external };
  } catch (error) {
    return { mapping: { state: "error", error: error instanceof Error ? error.message : "upnp failed" } };
  }
}

// ── verification ─────────────────────────────────────────────────────

/** Self-probe: the address is only ours if the answer echoes BOTH our pid and
 * the nonce we just made up — a stray dev server on the same port has the same
 * API shape but neither. */
export async function probe(address: string, expect: { pid: number; nonce: string }): Promise<boolean> {
  try {
    const response = await fetch(`${address}/api/health?probe=${encodeURIComponent(expect.nonce)}`, {
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { app?: unknown; pid?: unknown; probe?: unknown };
    return body.app === "multibot" && body.pid === expect.pid && body.probe === expect.nonce;
  } catch {
    return false;
  }
}

// ── persistence + orchestration (edges) ──────────────────────────────

export type AddressDeps = {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  onChange?(report: AddressReport): void;
};

let deps: AddressDeps | null = null;
let lastNoted = "";
let lastNotedAt = 0;

export function initNetAddress(next: AddressDeps | null): void {
  deps = next;
  lastNoted = "";
  lastNotedAt = 0;
}

function storedReport(): AddressReport | null {
  try {
    const raw = deps?.getMeta(META_REPORT);
    return raw ? (JSON.parse(raw) as AddressReport) : null;
  } catch {
    return null;
  }
}

function persist(report: AddressReport, previous: AddressReport | null): void {
  if (!deps) return;
  deps.setMeta(META_REPORT, JSON.stringify(report));
  if (report.current) deps.setMeta(META_ADDRESS, report.current);
  if (report.verified) deps.setMeta(META_VERIFIED_AT, String(report.checkedAt));
  if (previous?.current !== report.current || previous?.verified !== report.verified) deps.onChange?.(report);
}

function pick(candidates: AddressCandidate[], preferred: string | null): AddressCandidate | null {
  const pinned = preferred ? candidates.find((candidate) => candidate.address === preferred) : undefined;
  return pinned ?? candidates.find((candidate) => candidate.verified) ?? candidates[0] ?? null;
}

/** The last report as persisted, so a request never has to wait for SSDP. Falls
 * back to a plain interface scan on a server that has not refreshed yet. */
export function currentReport(port: number): AddressReport {
  const stored = storedReport();
  if (stored) return stored;
  const candidates = candidatesFrom(networkInterfaces(), port);
  return { current: candidates[0]?.address ?? null, verified: false, checkedAt: 0, candidates, portMapping: { state: "unsupported" } };
}

/** A request that arrived from a genuinely public remote address is free proof
 * of reachability: the client just did what we were trying to test. The `Host`
 * header it used is, by definition, an address that works. */
export function noteReachedHost(
  req: { socket: { remoteAddress?: string | undefined }; headers: Record<string, string | string[] | undefined> },
  port: number,
): string | null {
  if (!isPublicRemote(req.socket.remoteAddress ?? "")) return null;
  const host = String(req.headers.host ?? "").trim();
  if (!host || /^\[?(?:0\.0\.0\.0|::|localhost)\]?(:\d+)?$/i.test(host)) return null;
  const scheme = isSecureRequest(req) ? "https" : "http";
  const address = /:\d+$/.test(host) ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
  // Hot path: /api/health and /api/auth/me call this on every request.
  if (address === lastNoted && Date.now() - lastNotedAt < 60_000) return address;
  lastNoted = address;
  lastNotedAt = Date.now();
  if (!deps) return address;
  const previous = storedReport();
  const candidates = (previous?.candidates ?? []).map((candidate) =>
    candidate.address === address ? { ...candidate, verified: true } : candidate,
  );
  if (!candidates.some((candidate) => candidate.address === address)) {
    candidates.unshift({ address, kind: address.includes("[") ? "ipv6" : "ipv4-upnp", verified: true, source: "reached" });
  }
  persist(
    { ...(previous ?? { checkedAt: 0, portMapping: { state: "unsupported" } as PortMapping }), current: address, verified: true, checkedAt: Date.now(), candidates },
    previous,
  );
  return address;
}

/** Owner pins one of the candidates (or any URL they know works). */
export function pinAddress(port: number, address: unknown): AddressReport | null {
  if (typeof address !== "string" || !address.trim()) return null;
  const value = address.trim().replace(/\/+$/, "");
  const report = currentReport(port);
  const known = report.candidates.find((candidate) => candidate.address === value);
  if (!known) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    } catch {
      return null;
    }
    report.candidates.unshift({ address: value, kind: value.includes("[") ? "ipv6" : "ipv4-upnp", verified: false, source: "pinned" });
  }
  const next: AddressReport = { ...report, current: value, verified: known?.verified ?? false, checkedAt: Date.now() };
  persist(next, report);
  return next;
}

/** The whole ladder in one pass: scan interfaces, ask the router, verify what
 * we can, remember the answer. Never throws — a failure just produces a report
 * with `verified:false` and a `portMapping` that says why. */
export async function refreshAddress(port: number): Promise<AddressReport> {
  const previous = storedReport();
  const candidates = candidatesFrom(networkInterfaces(), port);
  let portMapping: PortMapping = { state: "unsupported" };

  const lan = candidates.find((candidate) => candidate.kind === "ipv4-lan");
  if (lan) {
    const gateway = await discoverGateway();
    if (gateway) {
      const lanIp = lan.address.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
      const mapped = await mapPort(gateway, port, lanIp);
      portMapping = mapped.mapping;
      const external = mapped.mapping.state === "mapped" && mapped.externalIp ? addressFor(mapped.externalIp, port) : null;
      if (external && !candidates.some((candidate) => candidate.address === external)) {
        candidates.unshift({ address: external, kind: "ipv4-upnp", verified: false, source: "upnp" });
      }
    }
  }

  const nonce = randomBytes(8).toString("hex");
  const verifiedAt = Number(deps?.getMeta(META_VERIFIED_AT) ?? 0);
  const rememberedVerified = verifiedAt && Date.now() - verifiedAt < VERIFIED_TTL_MS ? deps?.getMeta(META_ADDRESS) ?? null : null;
  await Promise.all(
    candidates.map(async (candidate) => {
      candidate.verified = candidate.address === rememberedVerified || (await probe(candidate.address, { pid: process.pid, nonce }));
    }),
  );

  const chosen = pick(candidates, previous?.current ?? null);
  const report: AddressReport = {
    current: chosen?.address ?? null,
    verified: Boolean(chosen?.verified),
    checkedAt: Date.now(),
    candidates,
    portMapping,
  };
  persist(report, previous);
  return report;
}
