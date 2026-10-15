import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';

import { config, assertConfig, wisburgEnabled } from './config.js';
import { McpClient } from './mcp/client.js';
import { Jin10Service, TOOLS, type Jin10Client } from './mcp/jin10.js';
import { DemoJin10Client } from './mcp/demo.js';
import { WisburgService, WISBURG_TOOLS } from './mcp/wisburg.js';
import { QuotaLedger } from './core/quota.js';
import { securityHeaders } from './core/security.js';
import { StreamBus } from './core/bus.js';
import { Scheduler } from './core/scheduler.js';
import { UNIVERSE, REGION_LABEL, ASSET_LABEL, CORE_CODES, type Scope } from './core/universe.js';
import { createApiRouter } from './routes/api.js';
import { createStreamRouter } from './routes/stream.js';
import { createResearchRouter } from './routes/research.js';
import { createReportRouter } from './routes/report.js';
import { createTopicRouter } from './routes/topic.js';
import { createMatrixRouter } from './routes/matrix.js';
import { ResearchMatrix } from './matrix/store.js';
import { WisburgMatrixSync } from './matrix/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  assertConfig();
  const matrix = new ResearchMatrix(config.matrix.dbPath, { readOnly: config.matrix.readOnly });
  let stopMatrixSync = false;
  let matrixSyncPromise: Promise<unknown> | null = null;

  // ── 数据源 1：金十数据（实时行情 / 快讯 / 资讯 / 日历） ──────────
  let jin10Mcp: McpClient | null = null;
  let jin10Client: Jin10Client;
  if (config.demoMode) {
    jin10Client = new DemoJin10Client();
    log('演示模式已启用：使用本地确定性数据，不连接金十或智堡');
  } else {
    jin10Mcp = new McpClient({
      url: config.jin10.url,
      token: config.jin10.token,
      protocolVersion: config.jin10.protocolVersion,
      clientName: 'jin10-mcp-terminal',
      clientVersion: '1.0.0',
    });
    jin10Client = jin10Mcp;
    wireLogs(jin10Mcp, '金十');

    const [tools, resources] = await Promise.all([jin10Mcp.listTools(), jin10Mcp.listResources()]);
    log(`金十工具 ${tools.length} 个: ${tools.map((t) => t.name).join(', ')}`);
    log(`金十资源 ${resources.length} 个: ${resources.map((r) => r.uri).join(', ')}`);
    const missing = TOOLS.filter((t) => !tools.some((x) => x.name === t));
    if (missing.length) log(`⚠️  金十缺少预期工具: ${missing.join(', ')}`);
  }

  const jin10Ledger = new QuotaLedger(
    config.quota.dailyLimit,
    config.quota.reserveRatio,
    config.quota.sustainHours,
    path.join(config.stateDir, config.demoMode ? 'demo-quota.json' : 'jin10-quota.json'),
  );
  const jin10 = new Jin10Service(jin10Client, jin10Ledger);
  const bus = new StreamBus();
  const scheduler = new Scheduler(jin10, jin10Ledger, bus);
  await scheduler.start();

  if (jin10Mcp) {
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
  }

  // ── 数据源 2：智堡 Wisburg（研报 / 文章 / 市场日报 / 图表） ──────
  let wisburg: WisburgService | null = null;
  let wisburgLedger: QuotaLedger | null = null;
  let wisburgMcp: McpClient | null = null;
  if (wisburgEnabled()) {
    wisburgMcp = new McpClient({
      url: config.wisburg.url,
      token: config.wisburg.token,
      protocolVersion: config.wisburg.protocolVersion,
      clientName: 'jin10-mcp-terminal',
      clientVersion: '1.0.0',
    });
    wireLogs(wisburgMcp, '智堡');
    try {
      const wt = await wisburgMcp.listTools();
      log(`智堡工具 ${wt.length} 个: ${wt.map((t) => t.name).join(', ')}`);
      const miss = WISBURG_TOOLS.filter((t) => !wt.some((x) => x.name === t));
      if (miss.length) log(`⚠️  智堡缺少预期工具: ${miss.join(', ')}`);
      wisburgLedger = new QuotaLedger(
        config.wisburg.dailyLimit,
        config.quota.reserveRatio,
        config.quota.sustainHours,
        path.join(config.stateDir, 'wisburg-quota.json'),
      );
      wisburg = new WisburgService(wisburgMcp, wisburgLedger);
    } catch (err) {
      // 智堡不可用不应拖垮金十终端
      log(`⚠️  智堡接入失败，该模块已停用: ${err instanceof Error ? err.message : String(err)}`);
      await wisburgMcp.close().catch(() => undefined);
      wisburgMcp = null;
    }
  } else {
    log(
      config.demoMode
        ? '演示模式下智堡实时研究模块已停用'
        : config.wisburg.liveEnabled
          ? '未配置 WISBURG_TOKEN，智堡实时研究模块已停用'
          : '智堡实时连接已关闭；本地缓存 Matrix 只读 API 保持可用',
    );
  }

  // ── HTTP ────────────────────────────────────────────────────────
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);

  // SSE 必须绕过压缩，否则事件会被 gzip 缓冲住失去实时性
  app.use(
    compression({
      filter: (req, res) => (req.path.startsWith('/api/stream') ? false : compression.filter(req, res)),
    }),
  );
  app.use(express.json({ limit: '64kb' }));

  if (config.corsOrigins.length) {
    app.use((req, res, next) => {
      const requestOrigin = req.headers.origin?.replace(/\/+$/, '');
      const allowAll = config.corsOrigins.includes('*');
      const allowed = allowAll ? '*' : requestOrigin && config.corsOrigins.includes(requestOrigin) ? requestOrigin : '';
      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', allowed);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      }
      if (req.method === 'OPTIONS') return allowed ? res.sendStatus(204) : res.sendStatus(403);
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
        sources: { jin10: !config.demoMode, wisburg: wisburg !== null, demo: config.demoMode },
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
  app.use('/api', createReportRouter(scheduler, wisburg));
  app.use('/api', createTopicRouter(jin10, wisburg, scheduler));
  app.use(
    '/api/matrix',
    createMatrixRouter(matrix, {
      publicContent: config.matrix.publicContent,
      adminToken: config.matrix.adminToken,
    }),
  );
  if (wisburg && wisburgLedger) {
    app.use('/api/research', createResearchRouter(wisburg, wisburgLedger));
  } else {
    app.use('/api/research', (_req, res) =>
      res.status(410).json({
        ok: false,
        error: { kind: 'retired', message: '智堡实时连接已关闭；历史缓存请使用 /api/matrix' },
      }),
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

  const server = app.listen(config.port, config.host, () => {
    const cov = scheduler.coverage();
    log(`金十实时终端已启动 → http://localhost:${config.port}（监听 ${config.host}）`);
    log(
      `额度策略: 每工具 ${config.quota.dailyLimit}/天，保留 ${Math.round(config.quota.reserveRatio * 100)}%，` +
        `铺满 ${config.quota.sustainHours}h ⇒ 行情 ${Math.round(cov.quoteIntervalMs / 1000)}s/次、K线 ${Math.round(cov.klineIntervalMs / 1000)}s/次`,
    );
    log(`覆盖 ${cov.codes} 个品种，普通品种整轮刷新约 ${Math.round(cov.cycleMs / 60000)} 分钟；24/7 常驻=${config.quota.pollWhenIdle}`);
  });
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  if (config.matrix.autoSync && wisburg && wisburgLedger) {
    const sync = new WisburgMatrixSync(wisburg, wisburgLedger, matrix);
    matrixSyncPromise = sync
      .run({
        pageSize: config.matrix.pageSize,
        maxPagesPerSource: config.matrix.maxPagesPerSource,
        maxTotalDetails: config.matrix.maxTotalDetails,
        maxReportDetails: config.matrix.maxReportDetails,
        maxArticleDetails: config.matrix.maxArticleDetails,
        concurrency: config.matrix.concurrency,
        shouldStop: () => stopMatrixSync,
        onProgress: (event) => {
          if (event.phase === 'done' || event.failed || event.completed || event.calls % 10 === 0) {
            log(`Matrix ${event.phase}: ${event.message}`);
          }
        },
      })
      .then((result) => log(`Matrix 自动同步完成: ${JSON.stringify(result)}`))
      .catch((error) => log(`⚠️  Matrix 自动同步失败: ${error instanceof Error ? error.message : String(error)}`));
  }

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，正在退出…`);
    stopMatrixSync = true;
    scheduler.stop();
    bus.closeAll();
    await matrixSyncPromise?.catch(() => undefined);
    await jin10Mcp?.close();
    await wisburgMcp?.close();
    matrix.close();
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
