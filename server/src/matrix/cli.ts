import path from 'node:path';
import { config, wisburgEnabled } from '../config.js';
import { QuotaLedger } from '../core/quota.js';
import { McpClient } from '../mcp/client.js';
import { WisburgService } from '../mcp/wisburg.js';
import { ResearchMatrix } from './store.js';
import { WisburgMatrixSync, type MatrixSyncProgress } from './sync.js';

const args = parseArgs(process.argv.slice(2));
const matrix = new ResearchMatrix(config.matrix.dbPath);

if (args.reindex) console.log(`重建索引完成：${matrix.reindex()} 篇文档`);
if (args.stats) {
  console.log(JSON.stringify(matrix.stats(), null, 2));
  matrix.close();
  process.exit(0);
}

if (!wisburgEnabled()) {
  matrix.close();
  throw new Error('智堡实时连接已关闭；只有 WISBURG_LIVE_ENABLED=true 且 token 有效时才能同步研究矩阵');
}

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  console.log('\n收到 SIGINT：完成当前请求后保存检查点…');
});
process.on('SIGTERM', () => {
  stopping = true;
  console.log('\n收到 SIGTERM：完成当前请求后保存检查点…');
});

if (args.resetLists) matrix.resetSyncState();

const mcp = new McpClient({
  url: config.wisburg.url,
  token: config.wisburg.token,
  protocolVersion: config.wisburg.protocolVersion,
  clientName: 'jin10-wisburg-matrix-sync',
  clientVersion: '1.0.0',
});
const ledger = new QuotaLedger(
  config.wisburg.dailyLimit,
  config.quota.reserveRatio,
  config.quota.sustainHours,
  path.join(config.stateDir, 'wisburg-quota.json'),
);
const wisburg = new WisburgService(mcp, ledger);

try {
  const tools = await mcp.listTools();
  console.log(`智堡连接成功：${tools.length} 个工具；数据库 ${config.matrix.dbPath}`);
  const sync = new WisburgMatrixSync(wisburg, ledger, matrix);
  const result = await sync.run({
    pageSize: args.pageSize ?? config.matrix.pageSize,
    maxPagesPerSource: args.maxPages ?? config.matrix.maxPagesPerSource,
    maxTotalDetails: args.totalDetails ?? config.matrix.maxTotalDetails,
    maxReportDetails: args.reportDetails ?? config.matrix.maxReportDetails,
    maxArticleDetails: args.articleDetails ?? config.matrix.maxArticleDetails,
    concurrency: args.concurrency ?? config.matrix.concurrency,
    forceLists: args.resetLists,
    ...(args.sources.length ? { sources: args.sources } : {}),
    shouldStop: () => stopping,
    onProgress: logProgress,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await mcp.close().catch(() => undefined);
  matrix.close();
}

interface CliArgs {
  stats: boolean;
  reindex: boolean;
  resetLists: boolean;
  pageSize?: number;
  maxPages?: number;
  totalDetails?: number;
  reportDetails?: number;
  articleDetails?: number;
  concurrency?: number;
  sources: string[];
}

function parseArgs(values: string[]): CliArgs {
  const out: CliArgs = { stats: false, reindex: false, resetLists: false, sources: [] };
  for (const arg of values) {
    if (arg === '--stats') out.stats = true;
    else if (arg === '--reindex') out.reindex = true;
    else if (arg === '--reset-lists') out.resetLists = true;
    else if (arg.startsWith('--page-size=')) out.pageSize = numberArg(arg);
    else if (arg.startsWith('--max-pages=')) out.maxPages = numberArg(arg);
    else if (arg.startsWith('--detail-calls=')) out.totalDetails = numberArg(arg);
    else if (arg.startsWith('--report-details=')) out.reportDetails = numberArg(arg);
    else if (arg.startsWith('--article-details=')) out.articleDetails = numberArg(arg);
    else if (arg.startsWith('--concurrency=')) out.concurrency = numberArg(arg);
    else if (arg.startsWith('--sources=')) {
      out.sources = arg
        .slice(arg.indexOf('=') + 1)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  return out;
}

function numberArg(arg: string): number {
  const value = Number(arg.slice(arg.indexOf('=') + 1));
  if (!Number.isFinite(value) || value < 0) throw new Error(`参数必须是非负数：${arg}`);
  return Math.trunc(value);
}

function logProgress(event: MatrixSyncProgress): void {
  if (event.phase === 'list') {
    if (!event.message.includes('跳过') && event.calls % 5 !== 0 && event.completed === 0 && event.failed === 0) return;
  }
  console.log(`[${event.phase}] ${event.message}`);
}
