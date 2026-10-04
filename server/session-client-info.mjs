import { isIP } from 'node:net';
import geoip from 'geoip-lite';
import ipaddr from 'ipaddr.js';

// Cloudflare's published proxy networks, verified 2026-10-04:
// https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
// Never trust a connecting-IP header unless Express's trusted-proxy boundary
// identifies a Cloudflare edge as the preceding client.
const cloudflareNetworks = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
].map(cidr => ipaddr.parseCIDR(cidr));
const countryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const localRanges = new Set(['loopback', 'private', 'linkLocal', 'uniqueLocal', 'carrierGradeNat']);

function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === 'string' ? value.slice(0, 1024) : '';
}

function parseAddress(value) {
  // Reject proxy lists, addresses with ports, shortened IPv4 and arbitrary text.
  if (typeof value !== 'string' || value.length > 64 || !isIP(value.trim())) return null;
  try { return ipaddr.process(value.trim()); } catch { return null; }
}

function requestAddress(req) {
  const peer = parseAddress(req.ip);
  if (!peer) return null;
  const cloudflarePeer = cloudflareNetworks.some(([network, prefix]) => (
    peer.kind() === network.kind() && peer.match(network, prefix)
  ));
  if (!cloudflarePeer) return peer;
  const visitor = parseAddress(header(req, 'cf-connecting-ip'));
  if (!visitor) return peer;
  // In Cloudflare's Pseudo IPv4 "Overwrite Headers" mode the Class E
  // placeholder is accompanied by the visitor's actual IPv6 address.
  if (visitor.kind() === 'ipv4' && visitor.match(ipaddr.parseCIDR('240.0.0.0/4'))) {
    const visitorV6 = parseAddress(header(req, 'cf-connecting-ipv6'));
    if (visitorV6?.kind() === 'ipv6' && visitorV6.range() === 'unicast') return visitorV6;
  }
  return visitor;
}

function locationFor(address) {
  if (!address) return '未知属地';
  const range = address.range();
  if (localRanges.has(range)) return '本地网络';
  if (range !== 'unicast') return '保留地址';
  try {
    const result = geoip.lookup(address.toString());
    if (!result) return '未知属地';
    const country = /^[A-Z]{2}$/.test(result.country || '')
      ? countryNames.of(result.country) : '';
    const parts = [country, result.region, result.city]
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => value.trim());
    return [...new Set(parts)].join(' · ') || '未知属地';
  } catch {
    // GeoIP is optional display metadata; lookup failure must not block login.
    return '未知属地';
  }
}

function deviceFor(req) {
  const ua = header(req, 'user-agent');
  const formFactors = header(req, 'sec-ch-ua-form-factors');
  if (/bot\b|crawler|spider|curl\/|wget\/|postmanruntime|headlesschrome/i.test(ua)) return 'unknown';
  if (/"Tablet"/i.test(formFactors)
    || /iPad|\bTablet\b|PlayBook|Silk\/|Kindle|\bSM-T\w+/i.test(ua)
    || /Macintosh/i.test(ua) && /Mobile\//i.test(ua)) return 'tablet';
  if (/"Mobile"/i.test(formFactors) || header(req, 'sec-ch-ua-mobile').trim() === '?1'
    || /iPhone|iPod|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|Opera Mobi/i.test(ua)) return 'mobile';
  if (/Android/i.test(ua)) {
    if (/TV|BRAVIA|AFT\w+/i.test(ua)) return 'unknown';
    return /Mobile/i.test(ua) ? 'mobile' : 'tablet';
  }
  if (/"Desktop"/i.test(formFactors) || /Windows NT|Macintosh|Mac OS X|X11|CrOS|Linux/i.test(ua)) return 'desktop';
  return 'unknown';
}

/** Login-time metadata only; performs no network lookup and retains no raw UA. */
export function sessionClientInfo(req) {
  const address = requestAddress(req);
  return {
    loginIp: address?.toString() ?? null,
    geoLocation: locationFor(address),
    deviceType: deviceFor(req),
  };
}
