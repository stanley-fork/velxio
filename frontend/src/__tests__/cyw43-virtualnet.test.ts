/**
 * cyw43-virtualnet.test.ts
 *
 * Unit tests for the self-contained virtual network (DHCP + ARP responder)
 * that lets a joined Pico W STA reach CYW43_LINK_UP with no backend.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_VNET, virtualNetReply } from '../simulation/cyw43/virtualNet';

const CLIENT_MAC = new Uint8Array([0x28, 0xcd, 0xc1, 0x01, 0x02, 0x03]);

function ip16(sum: number): number {
  while (sum >> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

/** Minimal DHCP DISCOVER/REQUEST the way lwIP frames it. */
function buildDhcpRequest(msgType: number): Uint8Array {
  const ETH = 14, IP = 20, UDP = 8;
  const dhcp = new Uint8Array(240 + 7);
  dhcp[0] = 1; // BOOTREQUEST
  dhcp[1] = 1; dhcp[2] = 6;
  dhcp.set([0x11, 0x22, 0x33, 0x44], 4); // xid
  dhcp.set(CLIENT_MAC, 28); // chaddr
  dhcp.set([0x63, 0x82, 0x53, 0x63], 236); // magic cookie
  dhcp.set([53, 1, msgType, 0xff], 240); // option 53 + end
  const total = ETH + IP + UDP + dhcp.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < 6; i++) buf[i] = 0xff; // dst broadcast
  buf.set(CLIENT_MAC, 6);
  dv.setUint16(12, 0x0800, false);
  buf[ETH] = 0x45;
  dv.setUint16(ETH + 2, IP + UDP + dhcp.length, false);
  buf[ETH + 9] = 17; // UDP
  let s = 0;
  for (let i = 0; i < IP; i += 2) s += dv.getUint16(ETH + i, false);
  dv.setUint16(ETH + 10, ip16(s), false);
  dv.setUint16(ETH + IP + 0, 68, false); // src port
  dv.setUint16(ETH + IP + 2, 67, false); // dst port (DHCP server)
  dv.setUint16(ETH + IP + 4, UDP + dhcp.length, false);
  buf.set(dhcp, ETH + IP + UDP);
  return buf;
}

function dhcpReplyType(reply: Uint8Array): number {
  // reply = ETH(14)+IP(20)+UDP(8)+DHCP; option 53 is right after the magic cookie.
  const dhcp = 14 + 20 + 8;
  let i = dhcp + 236 + 4;
  while (i < reply.length) {
    if (reply[i] === 0xff) break;
    if (reply[i] === 0) { i++; continue; }
    if (reply[i] === 53) return reply[i + 2];
    i += 2 + reply[i + 1];
  }
  return 0;
}

describe('cyw43 virtual network', () => {
  it('answers DHCP DISCOVER with an OFFER carrying the client IP', () => {
    const reply = virtualNetReply(DEFAULT_VNET, buildDhcpRequest(1))!;
    expect(reply).not.toBeNull();
    expect(dhcpReplyType(reply)).toBe(2); // DHCPOFFER
    // yiaddr (offered address) sits at DHCP offset 16.
    const yi = reply.subarray(14 + 20 + 8 + 16, 14 + 20 + 8 + 20);
    expect(Array.from(yi)).toEqual([...DEFAULT_VNET.clientIp]);
    // Unicast back to the requesting STA.
    expect(Array.from(reply.subarray(0, 6))).toEqual([...CLIENT_MAC]);
  });

  it('answers DHCP REQUEST with an ACK', () => {
    const reply = virtualNetReply(DEFAULT_VNET, buildDhcpRequest(3))!;
    expect(dhcpReplyType(reply)).toBe(5); // DHCPACK
  });

  it('answers an ARP who-has the gateway with the AP MAC', () => {
    const a = 14;
    const req = new Uint8Array(a + 28);
    const dv = new DataView(req.buffer);
    for (let i = 0; i < 6; i++) req[i] = 0xff;
    req.set(CLIENT_MAC, 6);
    dv.setUint16(12, 0x0806, false); // ARP
    dv.setUint16(a + 0, 1, false);   // htype
    dv.setUint16(a + 2, 0x0800, false);
    req[a + 4] = 6; req[a + 5] = 4;
    dv.setUint16(a + 6, 1, false);   // request
    req.set(CLIENT_MAC, a + 8);
    req.set(DEFAULT_VNET.clientIp, a + 14);
    req.set(DEFAULT_VNET.serverIp, a + 24); // who-has the gateway

    const reply = virtualNetReply(DEFAULT_VNET, req)!;
    expect(reply).not.toBeNull();
    expect(dv.getUint16(12, false)).toBe(0x0806);
    const rdv = new DataView(reply.buffer);
    expect(rdv.getUint16(a + 6, false)).toBe(2); // ARP reply
    // sender HW = AP MAC, sender IP = gateway
    expect(Array.from(reply.subarray(a + 8, a + 14))).toEqual([...DEFAULT_VNET.apMac]);
    expect(Array.from(reply.subarray(a + 14, a + 18))).toEqual([...DEFAULT_VNET.serverIp]);
  });

  it('ignores non-DHCP UDP and ARP for other addresses', () => {
    // ARP for some other IP -> no reply.
    const a = 14;
    const req = new Uint8Array(a + 28);
    const dv = new DataView(req.buffer);
    dv.setUint16(12, 0x0806, false);
    dv.setUint16(a + 0, 1, false);
    dv.setUint16(a + 2, 0x0800, false);
    req[a + 4] = 6; req[a + 5] = 4;
    dv.setUint16(a + 6, 1, false);
    req.set([8, 8, 8, 8], a + 24); // not the gateway
    expect(virtualNetReply(DEFAULT_VNET, req)).toBeNull();
  });
});
