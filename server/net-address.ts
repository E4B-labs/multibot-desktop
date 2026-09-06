// multibot (0.4.0): "what address do I tell people to type in?" answered
// without a single third party — no tunnel, no STUN, no echo service. The
// ladder is: a globally routable IPv6 straight off an interface, then a public
// IPv4 borrowed from the router over UPnP IGD, then the LAN address with an
// honest "only on this Wi-Fi" label.
//
// EVERY address here comes from one of exactly two trusted sources: this
// machine's own interfaces, or the owner pinning one by hand. Nothing a remote
// peer sends can introduce an address — a `Host:` header only ever confirms one
// we already knew about, never adds one.
//
// The pure parts (classifiers, parsers, `ssdpLocation`) take strings and return
// strings so the tests never open a socket; the I/O sits at the edges with a
// time cap AND a byte cap, so a hostile or broken router degrades to
// `portMapping:"unsupported"` instead of hanging or exhausting anything.
//
// ponytail: UPnP only; add NAT-PMP when a real router refuses it.
import { createSocket } from "node:dgram";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type AddressKind = "ipv6" | "ipv4-upnp" | "ipv4-lan";
export type AddressCandidate = { address: string; kind: AddressKind; verified: boolean };
export type PortMapping = { state: "mapped" | "unsupported" | "cgnat" | "error"; error?: string };
export type AddressReport = {
  current: string | null;
  verified: boolean;
  checkedAt: number;
  candidates: AddressCandidate[];
  portMapping: PortMapping;
};

/** A router that ignores us must not be able to stall a boot or a request. */
const NET_TIMEOUT_MS = 2_000;
/** `AbortSignal.timeout` caps time, not size: a device that dribbles bytes
 * forever stays inside its timeout while filling our heap. */
const MAX_BODY_BYTES = 256 * 1024;
/** A real IGD description is a few kilobytes; nothing legitimate is near this. */
const MAX_DESCRIPTION_BYTES = 64 * 1024;
/** A machine with a dozen virtual switches already produces a long list; a cap
 * keeps one stored row bounded no matter what shows up. */
const MAX_CANDIDATES = 16;
const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const IGD_SERVICE_TYPES = [
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
const KIND_ORDER: AddressKind[] = ["ipv6", "ipv4-upnp", "ipv4-lan"];

const META_ADDRESS = "server.publicAddress";
const META_PINNED = "server.addressPinned";
const META_EXTERNAL = "server.addressExternal";
/** Written, never read back for a trust decision — that was the round-2 bug.
 * It exists because the admin overview (`server/admin.ts`) shows whether the
 * address was ever confirmed, and when. */
const META_VERIFIED_AT = "server.addressVerifiedAt";
const META_REPORT = "server.addressReport";

// ── address classification (pure) ────────────────────────────────────

function bare(address: string): string {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = value.indexOf("%");
  const stripped = zone >= 0 ? value.slice(0, zone) : value;
  return stripped.startsWith("::ffff:") ? stripped.slice(7) : stripped;
}

function octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map(Number);
  return values.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? values : null;
}

/** Everything nobody on the internet can route to us at: RFC1918, loopback,
 * link-local, benchmarking (198.18/15), IETF protocol assignments (192.0.0/24),
 * the deprecated 6to4 anycast relay (192.88.99/24), the three documentation
 * ranges (they turn up in copied config, never on a real NIC) and the whole
 * multicast/reserved top end. */
export function isPrivateIPv4(address: string): boolean {
  const parts = octets(bare(address));
  if (!parts) return false;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

/** 100.64.0.0/10 — the carrier's own NAT. An "external" IP in this range means
 * the router is itself behind the ISP's NAT, so no port mapping can help. */
export function isCarrierGradeNat(address: string): boolean {
  const parts = octets(bare(address));
  return Boolean(parts && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

/** Global unicast IPv6 only. `2000::/3` is the whole of it, which is also what
 * rules out 64:ff9b::/96 (NAT64) and 100::/64 (discard) without naming them.
 * The exceptions inside it are transition relics: measured on a Windows box,
 * the Teredo pseudo-interface offers a 2001:0::/32 address that passes every
 * range test and reaches nothing. */
export function isGlobalIPv6(address: string): boolean {
  const value = bare(address);
  if (!value.includes(":")) return false;
  const groups = value.split(":");
  const head = Number.parseInt(groups[0] || "0", 16);
  if (!Number.isFinite(head) || (head & 0xe000) !== 0x2000) return false;
  if (head === 0x2002) return false; // 6to4
  const second = Number.parseInt(groups[1] || "0", 16) || 0;
  return !(head === 0x2001 && (second === 0 || second === 0x0db8)); // Teredo, documentation
}

/** True only for an address a stranger on the internet could really be at. */
export function isPublicRemote(address: string): boolean {
  const value = bare(address);
  if (!value) return false;
  if (octets(value)) return !isPrivateIPv4(value) && !isCarrierGradeNat(value);
  return isGlobalIPv6(value);
}

function kindOf(hostname: string): AddressKind {
  if (hostname.includes(":")) return "ipv6";
  return isPrivateIPv4(hostname) ? "ipv4-lan" : "ipv4-upnp";
}

/** The harness is HTTPS-only from 0.4.0 (`server/tls-cert.ts`); the scheme is
 * still a parameter because `OMB_TLS=off` behind a reverse proxy is a real,
 * documented deployment. */
export type Scheme = "http" | "https";

function addressFor(host: string, port: number, scheme: Scheme): string {
  return `${scheme}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

/** This machine's interfaces, translated into things a person could type.
 * Loopback, link-local and unique-local are dropped: none of them answers
 * "where do I reach you". */
export function candidatesFrom(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number, scheme: Scheme = "https"): AddressCandidate[] {
  const found = new Map<string, AddressCandidate>();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const isV6 = entry.family === "IPv6" || (entry.family as unknown as number) === 6;
      if (isV6 ? !isGlobalIPv6(entry.address) : isCarrierGradeNat(entry.address)) continue;
      const host = isV6 ? bare(entry.address) : entry.address;
      const address = addressFor(host, port, scheme);
      if (!found.has(address)) found.set(address, { address, kind: kindOf(host), verified: false });
    }
  }
  return [...found.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

// ── UPnP IGD (pure parsers + socket/HTTP edges) ──────────────────────

/** What a router answered our M-SEARCH with, validated before we believe a word
 * of it: the datagram must come from a LAN address, and the description it
 * advertises must live on that same box. A spoofed datagram could otherwise aim
 * our SOAP calls — and our LAN IP — at any host it liked. */
export function ssdpLocation(response: { rinfo: { address: string }; datagram: string }): string | null {
  const from = response.rinfo.address;
  if (from === "0.0.0.0" || !isPrivateIPv4(from)) return null;
  for (const line of response.datagram.split(/\r?\n/)) {
    const match = /^location:\s*(\S+)/i.exec(line);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      return url.protocol === "http:" && url.hostname === from ? url.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The IGD lists several services; only the WAN connection ones can map a port.
 * `controlURL` may be relative, so it is resolved against the LOCATION — and
 * then re-checked, because an absolute one is free to point elsewhere. */
/** Cut the description into `<service>` blocks WITHOUT a regex spanning them.
 * Measured on `"<service>".repeat(n)` (n unmatched openers, the shape a hostile
 * device sends): the obvious `<service\b[\s\S]*?</service>` takes 1.4 s at
 * 180 KB and 10.9 s at 540 KB, and the usual "non-backtracking" rewrite
 * `<service\b[^<]*(?:<(?!/service>)[^<]*)*</service>` is four times WORSE
 * (4.8 s / 43.9 s) — both are quadratic, because every opener rescans to the
 * end looking for a close that never comes. Splitting on the closer and taking
 * the last opener before it is linear: 0 ms at both sizes. */
function serviceBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const parts = xml.split("</service>");
  for (let index = 0; index < parts.length - 1; index++) {
    // `<service[\s>]` and not `<service`, or `<serviceId>` would win and the
    // block would start after the `<serviceType>` we came for.
    let open = -1;
    for (const match of parts[index].matchAll(/<service[\s>]/g)) open = match.index;
    if (open >= 0) blocks.push(parts[index].slice(open));
  }
  return blocks;
}

export function parseControlUrl(xml: string, base: string): { url: string; serviceType: string } | null {
  if (xml.length > MAX_DESCRIPTION_BYTES) return null;
  for (const block of serviceBlocks(xml)) {
    const serviceType = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1];
    const control = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!serviceType || !control || !IGD_SERVICE_TYPES.includes(serviceType)) continue;
    try {
      const url = new URL(control, base);
      return url.hostname === new URL(base).hostname ? { url: url.toString(), serviceType } : null;
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

/** Read a body the router is streaming at us, refusing to hold more than `cap`
 * bytes however long it keeps talking. */
export async function readCapped(chunks: AsyncIterable<Uint8Array>, cap = MAX_BODY_BYTES): Promise<string> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > cap) throw new Error("response too large");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function getCapped(url: string, init?: RequestInit, cap = MAX_BODY_BYTES): Promise<string | null> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
  if (!response.ok || !response.body) return null;
  return readCapped(response.body, cap);
}

/** One M-SEARCH shout on the LAN; the first router that answers credibly wins.
 * Never rejects and never outlives its timeout. */
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
    socket.on("message", (datagram, rinfo) => {
      const location = ssdpLocation({ rinfo, datagram: datagram.toString("utf8") });
      if (location) finish(location);
    });
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

/** Ask the router for its WAN address and, if that address is really on the
 * internet, punch TCP `port` through to `lanIp`. Lease 0 = "until I say
 * otherwise", which is why the refresh tick re-issues it: plenty of routers
 * quietly drop permanent mappings on reboot. */
type Control = { url: string; serviceType: string };

function soap(control: Control, action: string, args: string): Promise<string | null> {
  return getCapped(control.url, {
    method: "POST",
    headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${control.serviceType}#${action}"` },
    body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${control.serviceType}">${args}</u:${action}></s:Body></s:Envelope>`,
  });
}

/** The mapping this process owns, so shutdown can hand the port back. */
let ownedMapping: { control: Control; port: number } | null = null;

export async function mapPort(gateway: string, port: number, lanIp: string): Promise<{ mapping: PortMapping; externalIp?: string }> {
  try {
    const description = await getCapped(gateway, undefined, MAX_DESCRIPTION_BYTES);
    const control = description ? parseControlUrl(description, gateway) : null;
    if (!control) return { mapping: { state: "unsupported" } };

    const externalIp = parseSoapValue((await soap(control, "GetExternalIPAddress", "")) ?? "", "NewExternalIPAddress");
    if (!externalIp || !octets(externalIp)) return { mapping: { state: "unsupported" } };
    if (isPrivateIPv4(externalIp) || isCarrierGradeNat(externalIp)) return { mapping: { state: "cgnat" } };

    const added = await soap(control, "AddPortMapping",
      `<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort><NewProtocol>TCP</NewProtocol>` +
      `<NewInternalPort>${port}</NewInternalPort><NewInternalClient>${lanIp}</NewInternalClient>` +
      `<NewEnabled>1</NewEnabled><NewPortMappingDescription>MultiBot</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>`);
    if (added === null) return { mapping: { state: "error", error: "AddPortMapping refused" }, externalIp };
    ownedMapping = { control, port };
    return { mapping: { state: "mapped" }, externalIp };
  } catch (error) {
    return { mapping: { state: "error", error: error instanceof Error ? error.message : "upnp failed" } };
  }
}

/** Hand the port back on the way out, so a moved or retired server does not
 * leave the router forwarding to an address nothing answers on. Best effort:
 * one SOAP call under the usual 2 s cap, and a shutdown never waits for it. */
export async function unmapPort(): Promise<void> {
  const owned = ownedMapping;
  ownedMapping = null;
  if (!owned) return;
  try {
    await soap(owned.control, "DeletePortMapping",
      `<NewRemoteHost></NewRemoteHost><NewExternalPort>${owned.port}</NewExternalPort><NewProtocol>TCP</NewProtocol>`);
  } catch {
    /* the router is gone or refused — nothing left to do about it here */
  }
}

// ── persistence + orchestration (edges) ──────────────────────────────

export type AddressDeps = {
  scheme: Scheme;
  /** False on a loopback-only bind: forwarding a router port to 127.0.0.1 would
   * hand the internet a door onto nothing. */
  mapPorts: boolean;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  onChange(report: AddressReport): void;
};

let deps: AddressDeps | null = null;
let notedAt = 0;
let inFlight: Promise<AddressReport> | null = null;

export function initNetAddress(next: AddressDeps): void {
  deps = next;
}

function storedReport(): AddressReport | null {
  try {
    const raw = deps?.getMeta(META_REPORT);
    return raw ? (JSON.parse(raw) as AddressReport) : null;
  } catch {
    return null;
  }
}

/** Host and port, nothing else — the shape every stored address must have.
 * Applied on write AND on read: a meta row is not a trust boundary we get to
 * assume, and a value that no longer passes is dropped rather than served. */
function validAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** The three address sources that exist: this machine's interfaces, the WAN
 * address the router reported for a mapping it accepted, and the owner's pin.
 * Nothing a peer sends is ever one of them. */
function trusted(port: number): AddressCandidate[] {
  const list = candidatesFrom(networkInterfaces(), port, deps?.scheme ?? "https");
  for (const key of [META_EXTERNAL, META_PINNED]) {
    const stored = validAddress(deps?.getMeta(key));
    if (stored && !list.some((candidate) => candidate.address === stored)) {
      list.unshift({ address: stored, kind: kindOf(new URL(stored).hostname), verified: false });
    }
  }
  // Stable sort: the pin and the WAN address keep their place within their kind.
  return list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).slice(0, MAX_CANDIDATES);
}

/** Verification survives a rescan: it was earned by a real remote client, and
 * re-reading our own interfaces does not take it away. */
function carryVerified(candidates: AddressCandidate[], previous: AddressReport | null): AddressCandidate[] {
  const proven = new Set((previous?.candidates ?? []).filter((candidate) => candidate.verified).map((candidate) => candidate.address));
  return candidates.map((candidate) => ({ ...candidate, verified: proven.has(candidate.address) }));
}

function persist(report: AddressReport, previous: AddressReport | null): AddressReport {
  if (!deps) return report;
  deps.setMeta(META_REPORT, JSON.stringify(report));
  if (report.current) deps.setMeta(META_ADDRESS, report.current);
  if (report.verified) deps.setMeta(META_VERIFIED_AT, String(report.checkedAt));
  else if (previous?.verified) deps.setMeta(META_VERIFIED_AT, "");
  if (previous?.current !== report.current || previous?.verified !== report.verified) deps.onChange(report);
  return report;
}

/** The last report as stored, so a request never waits for SSDP. */
export function currentReport(port: number): AddressReport {
  const stored = storedReport();
  if (stored) return stored;
  const candidates = trusted(port);
  return { current: candidates[0]?.address ?? null, verified: false, checkedAt: 0, candidates, portMapping: { state: "unsupported" } };
}

/** A request that arrived from a genuinely public remote address is free proof
 * of reachability — the client just did what we were trying to test. But the
 * `Host:` header is attacker-controlled, so it can only CONFIRM an address we
 * already produced ourselves: scheme, host AND port must equal one of them.
 * Matching the hostname alone was not enough — `Host: <our-ip>:1` then rewrote
 * the advertised address to a port nothing listens on.
 *
 * ponytail: behind a reverse proxy `remoteAddress` is the proxy's private
 * address, so this never fires there and the address simply stays unverified —
 * the honest outcome, since we cannot see the real peer. Deliberately NOT read
 * from `x-forwarded-*`: any client can send those.
 */
export function noteReachedHost(
  req: { socket: { remoteAddress?: string | undefined; encrypted?: boolean }; headers: Record<string, string | string[] | undefined> },
  port: number,
): string | null {
  if (!deps || !isPublicRemote(req.socket.remoteAddress ?? "")) return null;
  // One store touch a minute whatever arrives: this sits on a route clients poll.
  if (Date.now() - notedAt < 60_000) return null;
  const scheme: Scheme = req.socket.encrypted ? "https" : "http";
  let host: URL;
  try {
    host = new URL(`${scheme}://${String(req.headers.host ?? "").trim()}`);
  } catch {
    return null;
  }
  if (host.username || host.password) return null;
  // No port in `Host:` means the scheme default; any other port is not us.
  if (host.port && Number(host.port) !== port) return null;
  const address = `${scheme}://${host.hostname}:${port}`;
  const previous = storedReport();
  const candidates = carryVerified(trusted(port), previous);
  if (!candidates.some((candidate) => candidate.address === address)) return null;

  notedAt = Date.now();
  const marked = candidates.map((candidate) => (candidate.address === address ? { ...candidate, verified: true } : candidate));
  persist({
    current: address,
    verified: true,
    checkedAt: Date.now(),
    candidates: marked.slice(0, MAX_CANDIDATES),
    portMapping: previous?.portMapping ?? { state: "unsupported" },
  }, previous);
  return address;
}

/** The owner names the address by hand. Host and port only: no credentials, no
 * path, nothing that could smuggle a second meaning into a value the setup
 * screen tells people to type. */
export function pinAddress(port: number, address: unknown): AddressReport | null {
  const value = typeof address === "string" ? validAddress(address.trim()) : null;
  if (!value) return null;

  const previous = storedReport();
  deps?.setMeta(META_PINNED, value);
  const candidates = carryVerified(trusted(port), previous);
  return persist({
    current: value,
    verified: candidates.find((candidate) => candidate.address === value)?.verified ?? false,
    checkedAt: Date.now(),
    candidates,
    portMapping: previous?.portMapping ?? { state: "unsupported" },
  }, previous);
}

/** The whole ladder in one pass: scan interfaces, ask the router, remember the
 * answer. Concurrent callers (the owner's `{refresh:true}` and the ten-minute
 * tick) share one scan rather than shouting over each other on the LAN. */
export function refreshAddress(port: number): Promise<AddressReport> {
  inFlight ??= scan(port).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function scan(port: number): Promise<AddressReport> {
  const previous = storedReport();
  let portMapping: PortMapping = { state: "unsupported" };

  const lan = trusted(port).find((candidate) => candidate.kind === "ipv4-lan");
  if (lan && deps?.mapPorts) {
    const gateway = await discoverGateway();
    if (gateway) {
      const mapped = await mapPort(gateway, port, new URL(lan.address).hostname);
      portMapping = mapped.mapping;
      // The router is a trusted source, so its WAN address is remembered: that
      // is the only thing that lets a NAT'd server ever be confirmed, once a
      // real client reaches us there.
      deps.setMeta(META_EXTERNAL, mapped.mapping.state === "mapped" && mapped.externalIp
        ? addressFor(mapped.externalIp, port, deps.scheme)
        : "");
    }
  }
  // Read AFTER the mapping, so a freshly learnt WAN address is already in.
  const candidates = carryVerified(trusted(port), previous);

  const chosen = candidates.find((candidate) => candidate.address === previous?.current)
    ?? candidates.find((candidate) => candidate.verified)
    ?? candidates[0]
    ?? null;
  return persist({
    current: chosen?.address ?? null,
    verified: Boolean(chosen?.verified),
    checkedAt: Date.now(),
    candidates: candidates.slice(0, MAX_CANDIDATES),
    portMapping,
  }, previous);
}
