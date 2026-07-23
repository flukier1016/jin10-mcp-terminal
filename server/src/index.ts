import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';

import { config, assertConfig, wisburgEnabled } from './config.js';
import { McpClient } from './mcp/client.js';
import { Jin10Service, TOOLS } from './mcp/jin10.js';
import { WisburgService, WISBURG_TOOLS } from './mcp/wisburg.js';
import { QuotaLedger } from './core/quota.js';
import { StreamBus } from './core/bus.js';
import { Scheduler } from './core/scheduler.js';
import { UNIVERSE, REGION_LABEL, ASSET_LABEL, CORE_CODES, type Scope } from './core/universe.js';
import { createApiRouter } from './routes/api.js';
import { createStreamRouter } from './routes/stream.js';
import { createResearchRouter } from './routes/research.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  assertConfig();

  // ── 数据源 1：金十数据（实时行情 / 快讯 / 资讯 / 日历） ──────────
  const jin10Mcp = new McpClient({
    url: config.jin10.url,
    token: config.jin10.token,
    protocolVersion: config.jin10.protocolVersion,
    clientName: 'jin10-mcp-terminal',
    clientVersion: '1.0.0',
  });
  wireLogs(jin10Mcp, '金十');

  const [tools, resources] = await Promise.all([jin10Mcp.listTools(), jin10Mcp.listResources()]);
  log(`金十工具 ${tools.length} 个: ${tools.map((t) => t.name).join(', ')}`);
  log(`金十资源 ${resources.length} 个: ${resources.map((r) => r.uri).join(', ')}`);
  const missing = TOOLS.filter((t) => !tools.some((x) => x.name === t));
  if (missing.length) log(`⚠️  金十缺少预期工具: ${missing.join(', ')}`);

  const jin10Ledger = new QuotaLedger(config.quota.dailyLimit, config.quota.reserveRatio, config.quota.sustainHours);
  const jin10 = new Jin10Service(jin10Mcp, jin10Ledger);
  const bus = new StreamBus();
  const scheduler = new Scheduler(jin10, jin10Ledger, bus);
  await scheduler.start();

  jin10Mcp.on('notification', (method: string, params: unknown) => {
    log(`金十通知: ${method}`);
    if (method === 'notifications/resources/list_changed') {
      void jin10
        .quoteCodes()
        .then((codes) => {
          scheduler.codes = codes;
          bus.broadcast({ type: 'status', mcp: 'up', detail: '品种列表已更新' });
        })
        .catch(() => undefined);
    } else if (method === 'notifications/message') {
      log(`金十日志: ${JSON.stringify(params).slice(0, 300)}`);
    }
  });
  jin10Mcp.openNotificationStream();
  await jin10Mcp.setLogLevel('info').catch(() => undefined);

  // ── 数据源 2：智堡 Wisburg（研报 / 文章 / 市场日报 / 图表） ──────
  let wisburg: WisburgService | null = null;
  let wisburgLedger: QuotaLedger | null = null;
  if (wisburgEnabled()) {
    const wisMcp = new McpClient({
      url: config.wisburg.url,
      token: config.wisburg.token,
      protocolVersion: config.wisburg.protocolVersion,
      clientName: 'jin10-mcp-terminal',
      clientVersion: '1.0.0',
    });
    wireLogs(wisMcp, '智堡');
    try {
      const wt = await wisMcp.listTools();
      log(`智堡工具 ${wt.length} 个: ${wt.map((t) => t.name).join(', ')}`);
      const miss = WISBURG_TOOLS.filter((t) => !wt.some((x) => x.name === t));
      if (miss.length) log(`⚠️  智堡缺少预期工具: ${miss.join(', ')}`);
      wisburgLedger = new QuotaLedger(config.wisburg.dailyLimit, config.quota.reserveRatio, config.quota.sustainHours);
      wisburg = new WisburgService(wisMcp, wisburgLedger);
    } catch (err) {
      // 智堡不可用不应拖垮金十终端
      log(`⚠️  智堡接入失败，该模块已停用: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log('未配置 WISBURG_TOKEN，智堡研究模块已停用');
  }

  // ── HTTP ────────────────────────────────────────────────────────
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // SSE 必须绕过压缩，否则事件会被 gzip 缓冲住失去实时性
  app.use(
    compression({
      filter: (req, res) => (req.path.startsWith('/api/stream') ? false : compression.filter(req, res)),
    }),
  );
  app.use(express.json({ limit: '64kb' }));

  if (config.corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  /** 总览宇宙的分类元数据，前端据此做地区/品种汇总。 */
  app.get('/api/universe', (_req, res) => {
    res.json({
      ok: true,
      data: {
        instruments: UNIVERSE,
        core: CORE_CODES,
        regions: REGION_LABEL,
        assets: ASSET_LABEL,
        coverage: scheduler.coverage(),
        sources: { jin10: true, wisburg: wisburg !== null },
      },
    });
  });

  /**
   * 切换覆盖范围。
   * core = 只盯核心 9 品种，每个约 5 分钟刷新（24/7 额度下的理论上限）
   * full = 覆盖全部 33 品种，核心更快、长尾更慢
   */
  app.post('/api/scope', (req, res) => {
    const next = (req.body as { scope?: string } | undefined)?.scope;
    if (next !== 'core' && next !== 'full') {
      return res.status(400).json({ ok: false, error: { message: 'scope 必须是 core 或 full' } });
    }
    scheduler.scope = next as Scope;
    log(`覆盖范围切换为 ${next}`);
    res.json({ ok: true, data: scheduler.coverage() });
  });

  app.use('/api', createStreamRouter(bus, scheduler));
  if (wisburg && wisburgLedger) {
    app.use('/api/research', createResearchRouter(wisburg, wisburgLedger));
  } else {
    app.use('/api/research', (_req, res) =>
      res.status(503).json({ ok: false, error: { kind: 'disabled', message: '智堡数据源未启用' } }),
    );
  }
  app.use('/api', createApiRouter(jin10, scheduler));

  // 生产环境由同一进程托管前端构建产物，Railway 上只需要一个服务
  const webDist = path.resolve(__dirname, '../../web/dist');
  app.use(express.static(webDist, { maxAge: '1h', index: false }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'), (err) => {
      if (err) res.status(404).type('text/plain').send('前端尚未构建，请先执行 npm run build');
    });
  });

  const server = app.listen(config.port, () => {
    const cov = scheduler.coverage();
    log(`金十实时终端已启动 → http://localhost:${config.port}`);
    log(
      `额度策略: 每工具 ${config.quota.dailyLimit}/天，保留 ${Math.round(config.quota.reserveRatio * 100)}%，` +
        `铺满 ${config.quota.sustainHours}h ⇒ 行情 ${Math.round(cov.quoteIntervalMs / 1000)}s/次、K线 ${Math.round(cov.klineIntervalMs / 1000)}s/次`,
    );
    log(`覆盖 ${cov.codes} 个品种，普通品种整轮刷新约 ${Math.round(cov.cycleMs / 60000)} 分钟；24/7 常驻=${config.quota.pollWhenIdle}`);
  });
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  const shutdown = async (sig: string) => {
    log(`收到 ${sig}，正在退出…`);
    scheduler.stop();
    bus.closeAll();
    await jin10Mcp.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function wireLogs(client: McpClient, tag: string): void {
  client.on('status', (s: string) => log(`${tag} MCP 状态: ${s}`));
  client.on('reconnect', (why: string) => log(`${tag} MCP 会话重建: ${why}`));
  client.on('notifyStream', (s: string) => log(`${tag} MCP 推送流: ${s}`));
  client.on('ready', (info: { serverInfo?: { name?: string; version?: string } | null }) => {
    log(`${tag} MCP 就绪: ${info.serverInfo?.name ?? 'unknown'} v${info.serverInfo?.version ?? '?'}`);
  });
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
