import assert from 'node:assert/strict';
import test from 'node:test';
import geoip from 'geoip-lite';
import { sessionClientInfo } from '../server/session-client-info.mjs';

const info = (ip, headers = {}) => sessionClientInfo({ ip, headers });

test('normalizes IPv4, mapped IPv4 and IPv6 and resolves public IPs locally', () => {
  assert.equal(info('::ffff:8.8.8.8').loginIp, '8.8.8.8');
  assert.match(info('8.8.8.8').geoLocation, /美国/);
  assert.match(info('114.114.114.114').geoLocation, /中国/);
  const v6 = info('2001:4860:4860:0000:0000:0000:0000:8888');
  assert.equal(v6.loginIp, '2001:4860:4860::8888');
  assert.match(v6.geoLocation, /美国/);
});

test('classifies local and reserved addresses without assigning an invented location', () => {
  for (const ip of ['127.0.0.1', '::1', '10.2.3.4', '192.168.1.2', '172.16.1.2', '169.254.1.2', '100.64.1.2', 'fc00::1', 'fe80::1']) {
    assert.equal(info(ip).geoLocation, '本地网络', ip);
  }
  for (const ip of ['0.0.0.0', '::', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.2', '203.0.113.3', '2001:db8::1', 'ff02::1']) {
    assert.equal(info(ip).geoLocation, '保留地址', ip);
  }
});

test('ignores arbitrary forwarding and country headers and rejects malformed IPs', () => {
  const spoof = { 'x-forwarded-for': '8.8.8.8', 'cf-connecting-ip': '8.8.8.8', 'cf-ipcountry': 'US', 'x-real-ip': '8.8.8.8' };
  assert.equal(info('10.1.2.3', spoof).loginIp, '10.1.2.3');
  assert.equal(info('10.1.2.3', spoof).geoLocation, '本地网络');
  for (const ip of [null, '', 'example.com', '8.8.8.8, 1.1.1.1', '8.8.8.8:443', '[2001:db8::1]', '127.1', '0x7f000001', '999.8.8.8']) {
    assert.deepEqual(info(ip, spoof), { loginIp: null, geoLocation: '未知属地', deviceType: 'unknown' });
  }
});

test('accepts connecting IP only behind verified Cloudflare IPv4 or IPv6 edges', () => {
  for (const edge of ['104.16.1.2', '172.64.1.2', '::ffff:173.245.48.1', '2606:4700::1']) {
    assert.equal(info(edge, { 'cf-connecting-ip': '114.114.114.114' }).loginIp, '114.114.114.114');
  }
  assert.equal(info('104.15.255.255', { 'cf-connecting-ip': '8.8.8.8' }).loginIp, '104.15.255.255');
  assert.equal(info('104.16.1.2', { 'cf-connecting-ip': '8.8.8.8, 1.1.1.1' }).loginIp, '104.16.1.2');
  assert.equal(info('104.16.1.2', { 'cf-connecting-ip': ['8.8.8.8'] }).loginIp, '104.16.1.2');
});

test('restores Cloudflare Pseudo IPv4 only when accompanied by valid public IPv6', () => {
  const headers = { 'cf-connecting-ip': '240.1.2.3', 'cf-connecting-ipv6': '2001:4860:4860::8888' };
  assert.equal(info('104.16.1.2', headers).loginIp, '2001:4860:4860::8888');
  assert.equal(info('10.1.2.3', headers).loginIp, '10.1.2.3');
  assert.equal(info('104.16.1.2', { ...headers, 'cf-connecting-ipv6': '::1' }).loginIp, '240.1.2.3');
  assert.equal(info('104.16.1.2', { ...headers, 'cf-connecting-ip': '8.8.8.8' }).loginIp, '8.8.8.8');
});

test('coarsely identifies desktop, phone and tablet without exposing raw user agents', () => {
  const examples = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1', 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0', 'desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15 Safari/604.1', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile Safari/537', 'mobile'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15 Safari/604.1', 'tablet'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15 Safari/604.1', 'tablet'],
    ['Mozilla/5.0 (Linux; Android 14; SM-T970) Chrome/130 Safari/537', 'tablet'],
    ['Mozilla/5.0 (Linux; Android 14; Tablet) Chrome/130 Safari/537', 'tablet'],
    ['curl/8.0.1', 'unknown'],
    ['Mozilla/5.0 (Linux; Android 14; BRAVIA TV) Safari/537', 'unknown'],
    ['', 'unknown'],
  ];
  for (const [ua, type] of examples) {
    const result = info('127.0.0.1', { 'user-agent': ua });
    assert.equal(result.deviceType, type, ua);
    assert.deepEqual(Object.keys(result).sort(), ['deviceType', 'geoLocation', 'loginIp']);
  }
  assert.equal(info('127.0.0.1', { 'sec-ch-ua-mobile': '?1' }).deviceType, 'mobile');
  assert.equal(info('127.0.0.1', { 'sec-ch-ua-mobile': '?0' }).deviceType, 'unknown');
  assert.equal(info('127.0.0.1', { 'sec-ch-ua-form-factors': '"Tablet"', 'sec-ch-ua-mobile': '?0' }).deviceType, 'tablet');
});

test('unavailable GeoIP metadata cannot prevent authentication', () => {
  const original = geoip.lookup;
  try {
    geoip.lookup = () => null;
    assert.equal(info('8.8.8.8').geoLocation, '未知属地');
    geoip.lookup = () => { throw new Error('database unavailable'); };
    assert.equal(info('8.8.8.8').loginIp, '8.8.8.8');
    assert.equal(info('8.8.8.8').geoLocation, '未知属地');
  } finally { geoip.lookup = original; }
});
