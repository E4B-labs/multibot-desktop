import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

import {
  candidatesFrom,
  isCarrierGradeNat,
  isGlobalIPv6,
  isPrivateIPv4,
  isPublicRemote,
  noteReachedHost,
  parseControlUrl,
  parseSoapValue,
  parseSsdpLocation,
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

  it("keeps only globally routable IPv6 and brackets it", () => {
    const v6 = candidates.filter((candidate) => candidate.kind === "ipv6");
    expect(v6).toHaveLength(1);
    expect(v6[0].address).toBe("http://[2a02:a31b:8140:1a80::42]:8799");
    expect(v6[0].verified).toBe(false);
    expect(v6[0].source).toBe("interface:Wi-Fi");
  });

  it("drops loopback, link-local and unique-local addresses", () => {
    const addresses = candidates.map((candidate) => candidate.address).join(" ");
    expect(addresses).not.toContain("127.0.0.1");
    expect(addresses).not.toContain("::1]");
    expect(addresses).not.toContain("fe80");
    expect(addresses).not.toContain("fd00");
  });

  it("labels a private IPv4 as LAN-only and skips a carrier-NAT one", () => {
    const lan = candidates.filter((candidate) => candidate.kind === "ipv4-lan");
    expect(lan.map((candidate) => candidate.address)).toEqual(["http://192.168.1.42:8799"]);
    expect(candidates.map((candidate) => candidate.address).join(" ")).not.toContain("100.90.1.7");
  });

  it("puts IPv6 before the LAN address so the ladder picks the best first", () => {
    expect(candidates[0].kind).toBe("ipv6");
    expect(candidates.at(-1)?.kind).toBe("ipv4-lan");
  });

  it("treats a public IPv4 on an interface as reachable, not LAN-only", () => {
    const [candidate] = candidatesFrom({ eth0: [iface("203.0.113.9", "IPv4")] }, 8799);
    expect(candidate).toEqual({ address: "http://203.0.113.9:8799", kind: "ipv4-upnp", verified: false, source: "interface:eth0" });
  });
});

describe("address classification", () => {
  it("recognises RFC1918 and the other unroutable IPv4 blocks", () => {
    for (const address of ["10.0.0.1", "172.16.4.5", "172.31.255.254", "192.168.0.1", "127.0.0.1", "169.254.7.7"]) {
      expect(isPrivateIPv4(address)).toBe(true);
    }
    for (const address of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "203.0.113.9"]) expect(isPrivateIPv4(address)).toBe(false);
  });

  it("recognises 100.64.0.0/10 as carrier-grade NAT", () => {
    for (const address of ["100.64.0.0", "100.90.1.7", "100.127.255.255"]) expect(isCarrierGradeNat(address)).toBe(true);
    for (const address of ["100.63.255.255", "100.128.0.1", "10.0.0.1"]) expect(isCarrierGradeNat(address)).toBe(false);
  });

  it("accepts only global unicast IPv6", () => {
    expect(isGlobalIPv6("2a02:a31b::1")).toBe(true);
    for (const address of ["::1", "fe80::1", "febf::1", "fc00::1", "fd12::1", "ff02::1"]) expect(isGlobalIPv6(address)).toBe(false);
  });

  it("rejects the transition relics that look global but reach nothing", () => {
    // Windows keeps a Teredo pseudo-interface alive on machines with no IPv6.
    for (const address of ["2001:0:9d38:6ab8:1c2d:3e4f:5a6b:7c8d", "2001::1", "2002:c000:204::1", "2001:db8::1"]) {
      expect(isGlobalIPv6(address)).toBe(false);
    }
  });

  it("calls a remote public only when a stranger could really be there", () => {
    expect(isPublicRemote("::ffff:203.0.113.9")).toBe(true);
    expect(isPublicRemote("2a02:a31b::9")).toBe(true);
    for (const address of ["", "127.0.0.1", "::1", "192.168.1.5", "100.90.1.7", "fe80::1", "::ffff:10.1.2.3"]) {
      expect(isPublicRemote(address)).toBe(false);
    }
  });
});

// A real Fritz!Box-shaped description: two WAN services, one relative and one
// absolute controlURL, plus a service that cannot map ports at all.
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

describe("parseControlUrl", () => {
  it("resolves a relative controlURL against the LOCATION the device answered with", () => {
    expect(parseControlUrl(IGD_XML, "http://192.168.1.1:49000/igddesc.xml")).toEqual({
      url: "http://192.168.1.1:49000/igdupnp/control/WANIPConn1",
      serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1",
    });
  });

  it("keeps an absolute controlURL as it is", () => {
    const xml = IGD_XML.replace("/igdupnp/control/WANIPConn1</controlURL>", "http://10.0.0.1:5000/ctl/IPConn</controlURL>");
    expect(parseControlUrl(xml, "http://192.168.1.1:49000/igddesc.xml")?.url).toBe("http://10.0.0.1:5000/ctl/IPConn");
  });

  it("also accepts a PPPoE router (WANPPPConnection) and WANIPConnection:2", () => {
    for (const type of ["urn:schemas-upnp-org:service:WANPPPConnection:1", "urn:schemas-upnp-org:service:WANIPConnection:2"]) {
      const xml = IGD_XML.replace("urn:schemas-upnp-org:service:WANIPConnection:1", type);
      expect(parseControlUrl(xml, "http://192.168.1.1:49000/igddesc.xml")?.serviceType).toBe(type);
    }
  });

  it("returns null when nothing on the device can map a port", () => {
    const xml = IGD_XML.replace(/WANIPConnection:1/g, "WANCommonInterfaceConfig:1");
    expect(parseControlUrl(xml, "http://192.168.1.1:49000/igddesc.xml")).toBeNull();
  });
});

describe("parseSoapValue", () => {
  const envelope = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">` +
    `<NewExternalIPAddress>203.0.113.9</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`;

  it("pulls the value out of a plain tag", () => {
    expect(parseSoapValue(envelope, "NewExternalIPAddress")).toBe("203.0.113.9");
  });

  it("pulls it out of a namespaced tag too", () => {
    expect(parseSoapValue(envelope.replace(/NewExternalIPAddress/g, "u:NewExternalIPAddress"), "NewExternalIPAddress")).toBe("203.0.113.9");
  });

  it("returns null for a missing tag and refuses a tag that is not a name", () => {
    expect(parseSoapValue(envelope, "NewInternalPort")).toBeNull();
    expect(parseSoapValue(envelope, "New[Ext]")).toBeNull();
  });

  it("detects a carrier-NAT answer in the value it just parsed", () => {
    const cgnat = envelope.replace("203.0.113.9", "100.72.4.19");
    expect(isCarrierGradeNat(parseSoapValue(cgnat, "NewExternalIPAddress") ?? "")).toBe(true);
    const rfc1918 = envelope.replace("203.0.113.9", "192.168.100.1");
    expect(isPrivateIPv4(parseSoapValue(rfc1918, "NewExternalIPAddress") ?? "")).toBe(true);
  });
});

describe("parseSsdpLocation", () => {
  it("finds the LOCATION header whatever its case", () => {
    const response = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nlocation: http://192.168.1.1:49000/igddesc.xml\r\nST: upnp:rootdevice\r\n\r\n";
    expect(parseSsdpLocation(response)).toBe("http://192.168.1.1:49000/igddesc.xml");
    expect(parseSsdpLocation("HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\n\r\n")).toBeNull();
  });
});

function fakeRequest(remoteAddress: string, host: string, headers: Record<string, string> = {}) {
  return { socket: { remoteAddress }, headers: { host, ...headers } };
}

describe("noteReachedHost", () => {
  it("ignores a request that came from anywhere unroutable", () => {
    for (const remote of ["127.0.0.1", "::1", "192.168.1.5", "10.4.4.4", "100.90.1.7", "fe80::1", ""]) {
      expect(noteReachedHost(fakeRequest(remote, "multibot.example:8799"), 8799)).toBeNull();
    }
  });

  it("records the Host a public client actually reached us on", () => {
    expect(noteReachedHost(fakeRequest("203.0.113.9", "198.51.100.7:8799"), 8799)).toBe("http://198.51.100.7:8799");
  });

  it("adds the listening port when the Host carries none", () => {
    expect(noteReachedHost(fakeRequest("2a02:a31b::9", "multibot.example"), 8799)).toBe("http://multibot.example:8799");
  });

  it("keeps a bracketed IPv6 Host intact and follows the proxy's scheme", () => {
    expect(noteReachedHost(fakeRequest("203.0.113.10", "[2a02:a31b::42]:8799", { "x-forwarded-proto": "https" }), 8799))
      .toBe("https://[2a02:a31b::42]:8799");
  });

  it("refuses a wildcard or loopback Host, which names nothing anyone can type", () => {
    for (const host of ["", "0.0.0.0:8799", "localhost:8799", "[::]:8799"]) {
      expect(noteReachedHost(fakeRequest("203.0.113.11", host), 8799)).toBeNull();
    }
  });
});
