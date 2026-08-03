import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseBoolean, parseNumber, parseOrigins, shouldConnectWisburg } from '../dist/config.js';
import { QuotaLedger, beijingDayKey, msUntilBeijingMidnight } from '../dist/core/quota.js';
import { DemoJin10Client } from '../dist/mcp/demo.js';

test('环境变量解析在不同平台保持稳定', () => {
  assert.equal(parseBoolean('YES', false), true);
  assert.equal(parseBoolean('off', true), false);
  assert.equal(parseBoolean('unexpected', true), true);
  assert.equal(parseNumber('8080', 3000, { min: 1, max: 65_535, integer: true }), 8080);
  assert.equal(parseNumber('99999', 3000, { min: 1, max: 65_535, integer: true }), 3000);
  assert.deepEqual(parseOrigins('https://a.example/, https://b.example,https://a.example'), [
    'https://a.example',
    'https://b.example',
  ]);
});

test('智堡实时连接默认拒绝旧 token，必须显式开启', () => {
  assert.equal(shouldConnectWisburg({ demoMode: false, liveEnabled: false, token: 'stale-token' }), false);
  assert.equal(shouldConnectWisburg({ demoMode: false, liveEnabled: true, token: '' }), false);
  assert.equal(shouldConnectWisburg({ demoMode: true, liveEnabled: true, token: 'valid-token' }), false);
  assert.equal(shouldConnectWisburg({ demoMode: false, liveEnabled: true, token: 'valid-token' }), true);
});

test('北京时间日界线不依赖服务器本地时区', () => {
  const justBefore = Date.UTC(2026, 6, 28, 15, 59, 59);
  const justAfter = Date.UTC(2026, 6, 28, 16, 0, 1);
  assert.equal(beijingDayKey(justBefore), '2026-07-28');
  assert.equal(beijingDayKey(justAfter), '2026-07-29');
  assert.ok(msUntilBeijingMidnight(justBefore) <= 1_000);
  assert.ok(msUntilBeijingMidnight(justAfter) > 86_000_000);
});

test('额度账本在进程重启后恢复当天计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin10-ledger-'));
  const stateFile = path.join(dir, 'quota.json');
  try {
    const first = new QuotaLedger(100, 0.1, 24, stateFile);
    first.record('get_quote');
    first.record('get_quote');

    const restored = new QuotaLedger(100, 0.1, 24, stateFile);
    assert.equal(restored.used('get_quote'), 2);
    assert.deepEqual(restored.persistenceStatus, { enabled: true, ok: true, error: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('演示数据源无需密钥即可覆盖核心 API 数据形状', async () => {
  const client = new DemoJin10Client();
  const codes = await client.readResource('quote://codes');
  assert.ok(codes.length >= 30);

  const quote = await client.callTool('get_quote', { code: 'XAUUSD' });
  assert.equal(quote.code, 'XAUUSD');
  assert.ok(Number.isFinite(Number(quote.close)));

  const series = await client.callTool('get_kline', { code: 'XAUUSD', count: 12 });
  assert.equal(series.klines.length, 12);
  assert.ok(series.klines.every((bar, index, all) => index === 0 || bar.time > all[index - 1].time));

  const calendar = await client.callTool('list_calendar');
  assert.ok(calendar.some((event) => event.actual === null));
});
