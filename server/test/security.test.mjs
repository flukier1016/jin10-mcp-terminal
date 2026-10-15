import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SECURITY_HEADERS, securityHeaders } from '../dist/core/security.js';

test('安全响应头：禁止被嵌入、不嗅探类型、强制 HTTPS，且不拦首页内联脚本', () => {
  const headers = {};
  let passed = false;
  securityHeaders({}, { setHeader: (name, value) => { headers[name] = value; } }, () => { passed = true; });
  assert.equal(passed, true);
  assert.deepEqual(Object.keys(headers).sort(), Object.keys(SECURITY_HEADERS).sort());
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /script-src|default-src/);
});

test('仓库里不出现真实密钥或本机绝对路径', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const secret = /sk-(?!x{6,})[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\/Users\/[a-z]|[?&]api_key=[A-Za-z0-9]{12,}/;
  const hits = files.filter((f) => !f.endsWith('package-lock.json') && fs.existsSync(path.join(root, f))
    && secret.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(hits, []);
});
