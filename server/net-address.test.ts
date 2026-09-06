// No sockets here on purpose: `discoverGateway` and `mapPort` are the two
// functions that actually open one, and both are thin wrappers over the pure
// pieces tested below (`ssdpLocation`, `parseControlUrl`, `parseSoapValue`,
// `readCapped`). They stay untested — a UDP multicast test would exercise the
// LAN it runs on, not the code.
import { createServer, connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

import type { AddressCandidate, AddressKind } from "./net-address.ts";

import {
  candidatesFrom,
  chooseAddress,
  isCarrierGradeNat,
  isGlobalIPv6,
  isPrivateIPv4,
  isOnionHost,
  isPublicRemote,
  noteReachedHost,
  parseControlUrl,
  parseSoapValue,
  pinAddress,
  probeRelay,
  readCapped,
  ssdpLocation,
} from "./net-address.ts";

function iface(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  return { address, family, internal, netmask: "", mac: "00:00:00:00:00:00", cidr: null } as NetworkInterfaceInfo;
}

const FIXTURE: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  Loopback: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
  "Wi-Fi": [
    iface("192.168.1.42", "IPv4"),
    iface("fe80::1c2d:3e4f:5a6b:7c8d", "IPv6"),
    iface("fd00:abcd::1", "IPv6"),
    iface("2a02:a31b:8140:1a80::42", "IPv6"),
  ],
  LTE: [iface("100.90.1.7", "IPv4")],
};

describe("candidatesFrom", () => {
  const candidates = candidatesFrom(FIXTURE, 8799);

  it("keeps only globally routable IPv6, brackets it, and speaks https", () => {
    expect(candidates.filter((candidate) => candidate.kind === "ipv6")).toEqual([
      { address: "https://[2a02:a31b:8140:1a80::42]:8799", kind: "ipv6", verified: false },
    ]);
  });

  // The whole point of the relay rung: on this fixture every other candidate is
  // a LAN address or an IPv6 the owner's router does not route, and the relay is
  // the one a stranger can actually reach.
  it("puts a configured relay first, ahead of every discovered address", () => {
    const withRelay = candidatesFrom(FIXTURE, 8799, "https", "203.0.113.9");
    expect(withRelay[0]).toEqual({ address: "https://203.0.113.9:8799", kind: "relay", verified: false });
    expect(withRelay.slice(1).map((candidate) => candidate.kind)).toEqual(candidates.map((candidate) => candidate.kind));
  });

  it("brackets an IPv6 relay and accepts a DNS name", () => {
    expect(candidatesFrom({}, 8799, "https", "2a05:d016::7")[0].address).toBe("https://[2a05:d016::7]:8799");
    expect(candidatesFrom({}, 8799, "https", " relay.example.net ")[0].address).toBe("https://relay.example.net:8799");
  });

  // `relay.env` is a file on disk, so it gets the same shape check as any other
  // stored address: a host, nothing that could smuggle a path or credentials in.
  it("ignores a relay host that is not a bare host", () => {
    for (const bad of ["", "  ", "evil.example/admin", "user:pass@evil.example"]) {
      expect(candidatesFrom({}, 8799, "https", bad).some((candidate) => candidate.kind === "relay")).toBe(false);
    }
  });

  it("falls back to http only when told to (OMB_TLS=off behind a proxy)", () => {
    expect(candidatesFrom({ eth0: [iface("1.1.1.1", "IPv4")] }, 8799, "http")[0].address)
      .toBe("http://1.1.1.1:8799");
  });

  it("drops loopback, link-local and unique-local addresses", () => {
    const addresses = candidates.map((candidate) => candidate.address).join(" ");
    for (const rejected of ["127.0.0.1", "::1]", "fe80", "fd00"]) expect(addresses).not.toContain(rejected);
  });

  it("labels a private IPv4 as LAN-only and skips a carrier-NAT one", () => {
    expect(candidates.filter((candidate) => candidate.kind === "ipv4-lan").map((candidate) => candidate.address))
      .toEqual(["https://192.168.1.42:8799"]);
    expect(candidates.map((candidate) => candidate.address).join(" ")).not.toContain("100.90.1.7");
  });

  it("puts IPv6 before the LAN address so the ladder picks the best first", () => {
    expect(candidates[0].kind).toBe("ipv6");
    expect(candidates.at(-1)?.kind).toBe("ipv4-lan");
  });

  it("treats a public IPv4 on an interface as reachable, not LAN-only", () => {
    expect(candidatesFrom({ eth0: [iface("8.8.8.8", "IPv4")] }, 8799))
      .toEqual([{ address: "https://8.8.8.8:8799", kind: "ipv4-upnp", verified: false }]);
  });
});

describe("address classification", () => {
  it("recognises every IPv4 block a stranger cannot route to", () => {
    for (const address of [
      "10.0.0.1", "172.16.4.5", "172.31.255.254", "192.168.0.1", "127.0.0.1", "169.254.7.7",
      "0.0.0.0", "198.18.0.1", "198.19.255.254", "192.0.0.8", "224.0.0.1", "239.255.255.250", "255.255.255.255",
      // Documentation ranges and the retired 6to4 anycast relay: they show up in
      // copied config, never as a machine anyone can reach.
      "192.0.2.5", "198.51.100.7", "203.0.113.9", "192.88.99.1",
    ]) {
      expect(isPrivateIPv4(address)).toBe(true);
    }
    for (const address of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "1.1.1.1", "198.17.0.1", "192.0.1.1", "203.0.114.1", "223.255.255.255"]) {
      expect(isPrivateIPv4(address)).toBe(false);
    }
  });

  it("recognises 100.64.0.0/10 as carrier-grade NAT", () => {
    for (const address of ["100.64.0.0", "100.90.1.7", "100.127.255.255"]) expect(isCarrierGradeNat(address)).toBe(true);
    for (const address of ["100.63.255.255", "100.128.0.1", "10.0.0.1"]) expect(isCarrierGradeNat(address)).toBe(false);
  });

  it("accepts only real global unicast IPv6 (2000::/3)", () => {
    for (const address of ["2a02:a31b::1", "2001:4860:4860::8888", "3fff::1"]) expect(isGlobalIPv6(address)).toBe(true);
    // Outside 2000::/3 entirely: loopback, link-local, ULA, multicast, NAT64
    // (64:ff9b::/96) and the discard prefix (100::/64).
    for (const address of ["::1", "fe80::1", "febf::1", "fc00::1", "fd12::1", "ff02::1", "64:ff9b::1.2.3.4", "100::1", "4000::1"]) {
      expect(isGlobalIPv6(address)).toBe(false);
    }
  });

  it("rejects the transition relics that look global but reach nothing", () => {
    // Windows keeps a Teredo pseudo-interface alive on machines with no IPv6.
    for (const address of ["2001:0:9d38:6ab8:1c2d:3e4f:5a6b:7c8d", "2001::1", "2002:c000:204::1", "2001:db8::1"]) {
      expect(isGlobalIPv6(address)).toBe(false);
    }
  });

  it("calls a remote public only when a stranger could really be there", () => {
    expect(isPublicRemote("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicRemote("2a02:a31b::9")).toBe(true);
    for (const address of ["", "127.0.0.1", "::1", "192.168.1.5", "100.90.1.7", "fe80::1", "::ffff:10.1.2.3", "224.0.0.1", "203.0.113.9"]) {
      expect(isPublicRemote(address)).toBe(false);
    }
  });
});

describe("ssdpLocation", () => {
  const datagram = (location: string) =>
    `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nlocation: ${location}\r\nST: upnp:rootdevice\r\n\r\n`;

  it("takes the LOCATION when the router that answered also hosts it", () => {
    expect(ssdpLocation({ rinfo: { address: "192.168.1.1" }, datagram: datagram("http://192.168.1.1:49000/igddesc.xml") }))
      .toBe("http://192.168.1.1:49000/igddesc.xml");
  });

  it("refuses a LOCATION pointing anywhere but the responder", () => {
    for (const location of ["http://192.168.1.99:49000/igddesc.xml", "http://evil.example/igddesc.xml", "http://8.8.8.8/x.xml"]) {
      expect(ssdpLocation({ rinfo: { address: "192.168.1.1" }, datagram: datagram(location) })).toBeNull();
    }
  });

  it("refuses a responder that is not on the LAN, and non-http descriptions", () => {
    expect(ssdpLocation({ rinfo: { address: "8.8.8.8" }, datagram: datagram("http://8.8.8.8:49000/igddesc.xml") })).toBeNull();
    expect(ssdpLocation({ rinfo: { address: "0.0.0.0" }, datagram: datagram("http://0.0.0.0/igddesc.xml") })).toBeNull();
    expect(ssdpLocation({ rinfo: { address: "192.168.1.1" }, datagram: datagram("file:///etc/passwd") })).toBeNull();
    expect(ssdpLocation({ rinfo: { address: "192.168.1.1" }, datagram: datagram("not-a-url") })).toBeNull();
  });

  it("returns null when the datagram carries no LOCATION at all", () => {
    expect(ssdpLocation({ rinfo: { address: "192.168.1.1" }, datagram: "HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\n\r\n" })).toBeNull();
  });
});

// A real Fritz!Box-shaped description: a service that cannot map ports, then
// the WAN connection one nested two device levels down.
const IGD_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
        <controlURL>/upnp/control/layer3f</controlURL>
      </service>
    </serviceList>
    <deviceList><device><deviceList><device>
      <serviceList>
        <service>
          <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
          <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
          <controlURL>/igdupnp/control/WANIPConn1</controlURL>
          <eventSubURL>/igdupnp/control/WANIPConn1</eventSubURL>
        </service>
      </serviceList>
    </device></deviceList></device></deviceList>
  </device>
</root>`;
const LOCATION = "http://192.168.1.1:49000/igddesc.xml";

describe("parseControlUrl", () => {
  it("resolves a relative controlURL against the LOCATION the device answered with", () => {
    expect(parseControlUrl(IGD_XML, LOCATION)).toEqual({
      url: "http://192.168.1.1:49000/igdupnp/control/WANIPConn1",
      serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1",
    });
  });

  it("keeps an absolute controlURL on the same host", () => {
    const xml = IGD_XML.replace("/igdupnp/control/WANIPConn1</controlURL>", "http://192.168.1.1:5000/ctl/IPConn</controlURL>");
    expect(parseControlUrl(xml, LOCATION)?.url).toBe("http://192.168.1.1:5000/ctl/IPConn");
  });

  it("refuses a controlURL that points away from the responder", () => {
    for (const control of ["http://10.0.0.1:5000/ctl/IPConn", "http://evil.example/ctl", "http://127.0.0.1:8799/api/config"]) {
      const xml = IGD_XML.replace("/igdupnp/control/WANIPConn1</controlURL>", `${control}</controlURL>`);
      expect(parseControlUrl(xml, LOCATION)).toBeNull();
    }
  });

  it("also accepts a PPPoE router (WANPPPConnection) and WANIPConnection:2", () => {
    for (const type of ["urn:schemas-upnp-org:service:WANPPPConnection:1", "urn:schemas-upnp-org:service:WANIPConnection:2"]) {
      expect(parseControlUrl(IGD_XML.replace("urn:schemas-upnp-org:service:WANIPConnection:1", type), LOCATION)?.serviceType).toBe(type);
    }
  });

  it("returns null when nothing on the device can map a port", () => {
    expect(parseControlUrl(IGD_XML.replace(/WANIPConnection:1/g, "WANCommonInterfaceConfig:1"), LOCATION)).toBeNull();
  });

  it("refuses an oversized description instead of chewing on it", () => {
    expect(parseControlUrl(IGD_XML + " ".repeat(64 * 1024), LOCATION)).toBeNull();
  });

  it("stays linear on the description shape that made the regex quadratic", () => {
    // Unmatched openers: every one of them sent the old `[\s\S]*?` body
    // scanning to the end of the string. 1.4 s measured at this size.
    const hostile = "<service>".repeat(20_000);
    const started = Date.now();
    expect(parseControlUrl(hostile, LOCATION)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("starts a block at <service>, not at <serviceId>", () => {
    // `lastIndexOf("<service")` would land on `<serviceId>` and lose the
    // `<serviceType>` that decides whether the service can map a port at all.
    expect(parseControlUrl(IGD_XML, LOCATION)?.serviceType).toBe("urn:schemas-upnp-org:service:WANIPConnection:1");
  });
});

describe("parseSoapValue", () => {
  const envelope = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">` +
    `<NewExternalIPAddress>203.0.113.9</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`;

  it("pulls the value out of a plain and a namespaced tag", () => {
    expect(parseSoapValue(envelope, "NewExternalIPAddress")).toBe("203.0.113.9");
    expect(parseSoapValue(envelope.replace(/NewExternalIPAddress/g, "u:NewExternalIPAddress"), "NewExternalIPAddress")).toBe("203.0.113.9");
  });

  it("returns null for a missing tag and refuses a tag that is not a name", () => {
    expect(parseSoapValue(envelope, "NewInternalPort")).toBeNull();
    expect(parseSoapValue(envelope, "New[Ext]")).toBeNull();
  });

  it("detects a carrier-NAT or RFC1918 answer in the value it just parsed", () => {
    expect(isCarrierGradeNat(parseSoapValue(envelope.replace("203.0.113.9", "100.72.4.19"), "NewExternalIPAddress") ?? "")).toBe(true);
    expect(isPrivateIPv4(parseSoapValue(envelope.replace("203.0.113.9", "192.168.100.1"), "NewExternalIPAddress") ?? "")).toBe(true);
  });
});

describe("readCapped", () => {
  async function* stream(...chunks: string[]) {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk);
  }

  it("joins the chunks it is given", async () => {
    expect(await readCapped(stream("<root>", "</root>"))).toBe("<root></root>");
  });

  it("gives up before holding more than the cap, however long the device talks", async () => {
    await expect(readCapped(stream("a".repeat(40), "b".repeat(40)), 64)).rejects.toThrow(/too large/);
    // Exactly the cap is fine; one byte past it is not.
    expect(await readCapped(stream("a".repeat(64)), 64)).toHaveLength(64);
  });
});

// The store is only wired inside the running server (`initNetAddress`), so with
// no deps these two answer from validation alone — which is exactly the part
// worth pinning down.
function fakeRequest(remoteAddress: string, host: string, extra: Record<string, string> = {}) {
  return { socket: { remoteAddress }, headers: { host, ...extra } };
}

describe("noteReachedHost", () => {
  it("ignores a request that came from anywhere unroutable", () => {
    for (const remote of ["127.0.0.1", "::1", "192.168.1.5", "10.4.4.4", "100.90.1.7", "fe80::1", ""]) {
      expect(noteReachedHost(fakeRequest(remote, "192.168.1.42:8799"), 8799)).toBeNull();
    }
  });

  it("refuses a Host that is not one of our own addresses, however plausible", () => {
    for (const host of ["evil.example", "evil.example:8799", "8.8.4.4:8799", "[2a02:dead::1]:8799", "0.0.0.0:8799", ""]) {
      expect(noteReachedHost(fakeRequest("8.8.8.8", host), 8799)).toBeNull();
    }
  });

  // Matching the hostname alone let `Host: <our-own-ip>:1` through and rewrote
  // the advertised address to a port nothing listens on.
  it("refuses our own host on a port we do not listen on", () => {
    for (const port of ["1", "80", "9999"]) {
      expect(noteReachedHost(fakeRequest("8.8.8.8", `192.168.1.42:${port}`), 8799)).toBeNull();
    }
  });

  it("refuses a Host carrying credentials", () => {
    expect(noteReachedHost(fakeRequest("8.8.8.8", "user:pass@192.168.1.42:8799"), 8799)).toBeNull();
  });
});

// The relay is the one candidate `noteReachedHost` can never confirm, so the
// probe is the only thing standing between "we published it" and "it works".
// A real handshake needs a server; what is worth pinning here is that every way
// of failing answers false instead of hanging or throwing.
describe("probeRelay", () => {
  it("is false when nothing is listening, and gives up inside its timeout", async () => {
    const started = Date.now();
    // 127.0.0.1:1 refuses immediately on every platform we run on.
    await expect(probeRelay("127.0.0.1", 1, "AA:BB")).resolves.toBe(false);
    await expect(probeRelay("[::1]", 1, "AA:BB", 300)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not throw on a host that cannot be resolved", async () => {
    await expect(probeRelay("relay.invalid", 8799, "AA:BB", 300)).resolves.toBe(false);
  });
});

describe("pinAddress", () => {
  it("refuses anything that is not a bare http(s) host and port", () => {
    for (const address of [
      "not a url", "ftp://1.2.3.4:8799", "http://1.2.3.4", "http://1.2.3.4:8799/admin",
      "http://user:pass@1.2.3.4:8799", "http://1.2.3.4:8799/?x=1", "http://1.2.3.4:8799/#x", "", 42, null, undefined,
    ]) {
      expect(pinAddress(8799, address)).toBeNull();
    }
  });

  it("accepts a host with an explicit port and keeps nothing else", () => {
    expect(pinAddress(8799, "  http://8.8.8.8:9000  ")?.current).toBe("http://8.8.8.8:9000");
    expect(pinAddress(8799, "https://[2a02:a31b::42]:8799")?.current).toBe("https://[2a02:a31b::42]:8799");
  });
});

const ONION = "a".repeat(56) + ".onion";

describe("isOnionHost", () => {
  it("accepts exactly a v3 onion", () => {
    expect(isOnionHost(ONION)).toBe(true);
    expect(isOnionHost(`  ${ONION.toUpperCase()}  `)).toBe(true);
  });

  it("refuses the wrong length, the wrong alphabet and anything merely ending in .onion", () => {
    for (const host of [
      "a".repeat(55) + ".onion", // one short
      "a".repeat(57) + ".onion", // one long
      "a".repeat(16) + ".onion", // v2, unroutable since 2021
      "a".repeat(55) + "1.onion", // 1 and 8/9 are not in base32
      "a".repeat(55) + "8.onion",
      `evil.example.${ONION}`, // a name tor would refuse, and we must never publish
      `${ONION}.evil.example`,
      "a".repeat(56), // no suffix
      "",
    ]) {
      expect(isOnionHost(host)).toBe(false);
    }
  });
});

describe("candidatesFrom with an onion", () => {
  it("advertises the onion below IPv6 and above the LAN address", () => {
    const kinds = candidatesFrom(FIXTURE, 8799, "https", null, ONION).map((candidate) => candidate.kind);
    expect(kinds).toEqual(["ipv6", "onion", "ipv4-lan"]);
  });

  it("refuses a hostname that is not a real onion, however much it looks like one", () => {
    for (const bad of ["", "  ", "evil.example", `evil.example.${ONION}`, "a".repeat(55) + ".onion"]) {
      expect(candidatesFrom(FIXTURE, 8799, "https", null, bad).some((candidate) => candidate.kind === "onion")).toBe(false);
    }
  });
});

// The ladder itself, with no NIC involved: `chooseAddress` is the whole of it.
describe("chooseAddress with an onion", () => {
  const candidate = (kind: AddressKind, verified = false): AddressCandidate => ({ address: `https://${kind}:8799`, kind, verified });
  const onion = candidate("onion");
  const lan = candidate("ipv4-lan");
  const ipv6 = candidate("ipv6");

  it("keeps the onion below a verified public address", () => {
    expect(chooseAddress([candidate("ipv6", true), onion])?.kind).toBe("ipv6");
    expect(chooseAddress([candidate("relay"), onion])?.kind).toBe("relay");
  });

  it("puts the onion above anything unverified, LAN included", () => {
    expect(chooseAddress([ipv6, onion, lan])?.kind).toBe("onion");
    expect(chooseAddress([lan, onion])?.kind).toBe("onion");
  });

  // The first scan happens seconds after boot, long before tor has published
  // anything — so the LAN address it picked must not win forever on seniority.
  it("does not let a first-boot LAN pick outrank the onion that arrived later", () => {
    expect(chooseAddress([ipv6, onion, lan], lan.address)?.kind).toBe("onion");
  });

  it("still refuses to revert an address a real client confirmed", () => {
    const provenLan = candidate("ipv4-lan", true);
    expect(chooseAddress([onion, provenLan], provenLan.address)?.kind).toBe("ipv4-lan");
    const provenIpv6 = candidate("ipv6", true);
    expect(chooseAddress([provenIpv6, onion], provenIpv6.address)?.kind).toBe("ipv6");
  });

  it("answers null on nothing at all", () => {
    expect(chooseAddress([], null)).toBeNull();
  });
});

// The onion is a candidate like any other, so `Host: <our-onion>` from a peer
// that CAN reach us directly would otherwise mark it verified and demote a
// public address we had really confirmed.
describe("noteReachedHost and the onion", () => {
  it("refuses to take an inbound request as proof of the onion", () => {
    expect(noteReachedHost(fakeRequest("8.8.8.8", `${ONION}:8799`), 8799)).toBeNull();
  });
});

// A Tor circuit that accepts and then goes quiet is the normal failure of a
// hidden service that has gone away, and `tls.connect({ socket, timeout })`
// does NOT apply the timeout to a socket it was handed (measured, Node 24).
// Without a clock of its own this promise never settles, `inFlight` never
// clears, and address discovery is frozen for the life of the process.
describe("probeRelay over a pre-opened socket", () => {
  const silent = createServer(() => {});
  afterEach(() => silent.close());

  it("gives up on a peer that accepts and never speaks", async () => {
    await new Promise((resolve) => silent.listen(0, "127.0.0.1", () => resolve(null)));
    const port = (silent.address() as { port: number }).port;
    const tunnel = netConnect(port, "127.0.0.1");
    await new Promise((resolve) => tunnel.once("connect", resolve));

    const started = Date.now();
    await expect(probeRelay("anything.onion", 8799, "AA:BB", 400, tunnel)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(tunnel.destroyed).toBe(true);
  });
});

describe("chooseAddress stickiness without an onion", () => {
  const candidate = (kind: AddressKind, verified = false): AddressCandidate => ({ address: `https://${kind}:8799`, kind, verified });

  // The LAN relaxation is there ONLY to let a late onion past a first-boot LAN
  // pick. On a server that has no onion at all it would just make the published
  // address flap between the LAN one and an unverified IPv6 on every scan.
  it("keeps a sticky LAN address when there is no onion to move to", () => {
    const lan = candidate("ipv4-lan");
    expect(chooseAddress([candidate("ipv6"), lan], lan.address)?.kind).toBe("ipv4-lan");
  });
});
