const baseUrl = normalizeBase(process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`);
const timeoutMs = numberEnv('PROBE_TIMEOUT_MS', 8_000, 500, 60_000);
const attempts = numberEnv('PROBE_ATTEMPTS', 1, 1, 30);
const intervalMs = numberEnv('PROBE_INTERVAL_MS', 1_000, 100, 30_000);

const checks = [
  {
    name: 'web',
    path: '/',
    validate: (response, body) => response.headers.get('content-type')?.includes('text/html') && body.includes('id="root"'),
  },
  {
    name: 'health',
    path: '/api/health',
    validate: (_response, body) => {
      const data = JSON.parse(body);
      const persistence = data?.data?.quotaPersistence;
      return data?.ok === true && data?.data?.status === 'ok' && (!persistence?.enabled || persistence.ok === true);
    },
  },
  {
    name: 'universe',
    path: '/api/universe',
    validate: (_response, body) => {
      const data = JSON.parse(body);
      return data?.ok === true && Array.isArray(data?.data?.instruments) && data.data.instruments.length > 0;
    },
  },
  {
    name: 'config',
    path: '/api/config',
    validate: (_response, body) => {
      const data = JSON.parse(body);
      return data?.ok === true && Array.isArray(data?.data?.watchlist);
    },
  },
];

let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    for (const check of checks) await runCheck(check);
    console.log(`探针通过：${checks.length}/${checks.length}，目标 ${baseUrl}`);
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (lastError) {
  console.error(`探针失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  process.exitCode = 1;
}

async function runCheck(check) {
  const response = await fetch(`${baseUrl}${check.path}`, {
    headers: { Accept: check.name === 'web' ? 'text/html' : 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${check.name} 返回 HTTP ${response.status}`);
  let valid = false;
  try {
    valid = Boolean(check.validate(response, body));
  } catch {
    valid = false;
  }
  if (!valid) throw new Error(`${check.name} 响应结构不符合预期`);
  console.log(`✓ ${check.name} ${response.status}`);
}

function normalizeBase(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('BASE_URL 必须使用 http(s)');
  return url.toString().replace(/\/+$/, '');
}

function numberEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
