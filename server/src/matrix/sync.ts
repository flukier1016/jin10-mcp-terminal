import type { QuotaLedger } from '../core/quota.js';
import {
  CATEGORY_TOOL,
  type ReportCategory,
  type WisburgPage,
  type WisburgService,
  type WisburgTool,
  WISBURG_TOOLS,
} from '../mcp/wisburg.js';
import { sourceDescriptor, type ResearchMatrix } from './store.js';

export interface MatrixSyncOptions {
  pageSize: number;
  maxPagesPerSource: number;
  maxTotalDetails: number;
  maxReportDetails: number;
  maxArticleDetails: number;
  concurrency: number;
  forceLists?: boolean;
  sources?: string[];
  shouldStop?: () => boolean;
  onProgress?: (event: MatrixSyncProgress) => void;
}

export interface MatrixSyncProgress {
  phase: 'list' | 'report-detail' | 'article-detail' | 'done';
  source?: string;
  calls: number;
  items: number;
  completed: number;
  failed: number;
  message: string;
}

export interface MatrixSyncResult {
  runId: number;
  listCalls: number;
  listedItems: number;
  reportDetailCalls: number;
  reportDetails: number;
  articleDetailCalls: number;
  articleDetails: number;
  failed: number;
  stopped: boolean;
  stats: Record<string, unknown>;
}

interface SourceSpec {
  source: string;
  tool: WisburgTool;
  fetch: (after?: string) => Promise<WisburgPage>;
}

/** 按游标续跑的智堡批量同步器；所有远端调用都先经过 QuotaLedger。 */
export class WisburgMatrixSync {
  constructor(
    private readonly wisburg: WisburgService,
    private readonly ledger: QuotaLedger,
    private readonly matrix: ResearchMatrix,
  ) {}

  async run(options: MatrixSyncOptions): Promise<MatrixSyncResult> {
    const normalized = normalizeOptions(options);
    const runId = this.matrix.startRun({
      pageSize: normalized.pageSize,
      maxPagesPerSource: normalized.maxPagesPerSource,
      maxTotalDetails: normalized.maxTotalDetails,
      maxReportDetails: normalized.maxReportDetails,
      maxArticleDetails: normalized.maxArticleDetails,
      concurrency: normalized.concurrency,
      forceLists: Boolean(normalized.forceLists),
      sources: normalized.sources ?? null,
    });

    let listCalls = 0;
    let listedItems = 0;
    let failed = 0;
    let reportDetailCalls = 0;
    let reportDetails = 0;
    let articleDetailCalls = 0;
    let articleDetails = 0;

    try {
      const specs = this.sourceSpecs(normalized.pageSize).filter(
        (spec) => !normalized.sources?.length || normalized.sources.includes(spec.source),
      );
      const listCircuit = { open: false, reason: '' };
      const listResults = await parallelMap(specs, normalized.concurrency, async (spec) => {
        if (normalized.shouldStop() || listCircuit.open) return { calls: 0, items: 0, failed: 0 };
        return this.syncSource(spec, normalized, listCircuit);
      });
      for (const result of listResults) {
        listCalls += result.calls;
        listedItems += result.items;
        failed += result.failed;
      }

      const detailCircuit = { open: false, reason: '' };
      let remainingDetailBudget = normalized.maxTotalDetails;
      if (!normalized.shouldStop() && (!normalized.sources?.length || normalized.sources.includes('report-detail'))) {
        const report = await this.syncDetails(
          'report',
          'get-report-detail',
          Math.min(normalized.maxReportDetails, remainingDetailBudget),
          normalized,
          detailCircuit,
        );
        reportDetailCalls = report.calls;
        reportDetails = report.completed;
        failed += report.failed;
        remainingDetailBudget -= report.calls;
      }

      if (
        !normalized.shouldStop() &&
        !detailCircuit.open &&
        (!normalized.sources?.length || normalized.sources.includes('article-detail'))
      ) {
        const article = await this.syncDetails(
          'article',
          'get-article-detail',
          Math.min(normalized.maxArticleDetails, remainingDetailBudget),
          normalized,
          detailCircuit,
        );
        articleDetailCalls = article.calls;
        articleDetails = article.completed;
        failed += article.failed;
      }

      const stopped = normalized.shouldStop();
      const summary = {
        runId,
        listCalls,
        listedItems,
        reportDetailCalls,
        reportDetails,
        articleDetailCalls,
        articleDetails,
        failed,
        stopped,
      };
      this.matrix.finishRun(runId, stopped || failed ? 'partial' : 'complete', summary);
      const result: MatrixSyncResult = { ...summary, stats: this.matrix.stats() };
      normalized.onProgress({
        phase: 'done',
        calls: listCalls + reportDetailCalls + articleDetailCalls,
        items: listedItems,
        completed: reportDetails + articleDetails,
        failed,
        message: stopped
          ? '同步已安全停止，可从检查点续跑'
          : listCircuit.open || detailCircuit.open
            ? '智堡账户级限流已熔断，今日检查点已保存'
            : '同步完成',
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        listCalls,
        listedItems,
        reportDetailCalls,
        reportDetails,
        articleDetailCalls,
        articleDetails,
        failed,
      };
      this.matrix.finishRun(runId, 'failed', result, message);
      throw error;
    }
  }

  private sourceSpecs(pageSize: number): SourceSpec[] {
    const reports = (category: ReportCategory): SourceSpec => ({
      source: `report:${category}`,
      tool: CATEGORY_TOOL[category],
      fetch: (after) => this.wisburg.listReports(category, { first: pageSize, ...(after ? { after } : {}) }),
    });
    return [
      reports('ib'),
      reports('company'),
      reports('am'),
      reports('archive'),
      reports('ec'),
      {
        source: 'feed',
        tool: 'list-feed',
        fetch: (after) => this.wisburg.listFeed({ first: pageSize, ...(after ? { after } : {}) }),
      },
      {
        source: 'daily',
        tool: 'list-market-daily',
        fetch: (after) => this.wisburg.listMarketDaily({ first: pageSize, ...(after ? { after } : {}) }),
      },
      {
        source: 'article',
        tool: 'list-articles',
        fetch: (after) => this.wisburg.listArticles({ first: pageSize, ...(after ? { after } : {}) }),
      },
      {
        source: 'image',
        tool: 'list-images',
        fetch: (after) => this.wisburg.listImages({ first: pageSize, ...(after ? { after } : {}) }),
      },
    ];
  }

  private async syncSource(
    spec: SourceSpec,
    options: Required<Pick<MatrixSyncOptions, 'pageSize' | 'maxPagesPerSource' | 'concurrency'>> &
      MatrixSyncOptions & {
        shouldStop: () => boolean;
        onProgress: (event: MatrixSyncProgress) => void;
      },
    circuit: { open: boolean; reason: string },
  ): Promise<{ calls: number; items: number; failed: number }> {
    let state = this.matrix.getSyncState(spec.source);
    const refreshing = state.completed && !options.forceLists;
    if (options.forceLists) {
      this.matrix.resetSyncState(spec.source);
      state = this.matrix.getSyncState(spec.source);
    } else if (state.completed) {
      // 历史已扫到底时仍从头检查新内容；遇到整页旧数据就停止，避免每天重扫全库。
      state = { ...state, cursor: null, completed: false };
    }

    let calls = 0;
    let items = 0;
    let failed = 0;
    const seenCursors = new Set<string>();
    while (
      calls < options.maxPagesPerSource &&
      !options.shouldStop() &&
      !circuit.open &&
      this.ledger.canSpend(spec.tool) &&
      !state.completed
    ) {
      const cursor = state.cursor ?? undefined;
      if (cursor && seenCursors.has(cursor)) {
        state = { ...state, completed: true, lastError: `游标重复：${cursor}`, lastSyncedAt: Date.now() };
        this.matrix.saveSyncState(state);
        break;
      }
      if (cursor) seenCursors.add(cursor);

      try {
        calls += 1;
        const page = await spec.fetch(cursor);
        let newItems = 0;
        for (const item of page.items) {
          const docKey = sourceDescriptor(spec.source, item.id).docKey;
          if (!this.matrix.hasDocument(docKey)) newItems += 1;
          this.matrix.upsertWisburgItem(spec.source, item);
        }
        items += newItems;

        const next = page.next_cursor;
        const completed =
          !page.has_more ||
          !next ||
          page.items.length === 0 ||
          next === cursor ||
          (refreshing && newItems === 0);
        state = {
          source: spec.source,
          cursor: completed ? null : next,
          completed,
          pages: state.pages + 1,
          items: state.items + newItems,
          calls: state.calls + 1,
          lastSyncedAt: Date.now(),
          lastError: null,
        };
        this.matrix.saveSyncState(state);
        options.onProgress({
          phase: 'list',
          source: spec.source,
          calls,
          items,
          completed: state.completed ? 1 : 0,
          failed,
          message: `${spec.source} 第 ${state.pages} 页，累计 ${state.items} 条`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/分页游标超出限制|cursor.{0,20}(?:limit|range)|API error \[1004]/i.test(message)) {
          state = {
            ...state,
            cursor: null,
            completed: true,
            calls: state.calls + 1,
            lastSyncedAt: Date.now(),
            lastError: '已达智堡服务端分页上限',
          };
          this.matrix.saveSyncState(state);
          options.onProgress({
            phase: 'list',
            source: spec.source,
            calls,
            items,
            completed: 1,
            failed,
            message: `${spec.source} 已达智堡服务端分页上限`,
          });
          break;
        }
        if (/429|Too Many Requests|调用次数.*上限|rate.?limit/i.test(message)) {
          circuit.open = true;
          circuit.reason = message;
          this.blockAllWisburgTools();
        }
        failed += 1;
        state = {
          ...state,
          calls: state.calls + 1,
          lastSyncedAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.matrix.saveSyncState(state);
        options.onProgress({
          phase: 'list',
          source: spec.source,
          calls,
          items,
          completed: 0,
          failed,
          message: `${spec.source} 失败：${state.lastError}`,
        });
        break;
      }
    }
    return { calls, items, failed };
  }

  private async syncDetails(
    kind: 'report' | 'article',
    tool: 'get-report-detail' | 'get-article-detail',
    configuredMax: number,
    options: MatrixSyncOptions & {
      concurrency: number;
      shouldStop: () => boolean;
      onProgress: (event: MatrixSyncProgress) => void;
    },
    circuit: { open: boolean; reason: string },
  ): Promise<{ calls: number; completed: number; failed: number }> {
    if (circuit.open) return { calls: 0, completed: 0, failed: 0 };
    const budget = Math.min(configuredMax, this.ledger.spendable(tool));
    if (budget <= 0) return { calls: 0, completed: 0, failed: 0 };
    const pending = this.matrix.pendingDetails(kind, budget);
    let cursor = 0;
    let calls = 0;
    let completed = 0;
    let failed = 0;
    let consecutiveFailures = 0;

    const worker = async () => {
      while (!options.shouldStop() && !circuit.open && this.ledger.canSpend(tool) && calls < budget) {
        const item = pending[cursor++];
        if (!item) return;
        calls += 1;
        try {
          const detail =
            kind === 'report'
              ? await this.wisburg.getReport(item.external_id, item.category as ReportCategory)
              : await this.wisburg.getArticle(item.external_id);
          this.matrix.upsertDetail(item.doc_key, detail);
          completed += 1;
          consecutiveFailures = 0;
        } catch (error) {
          failed += 1;
          consecutiveFailures += 1;
          const message = error instanceof Error ? error.message : String(error);
          const rateLimited = /429|Too Many Requests|调用次数.*上限|rate.?limit/i.test(message);
          // 账户额度耗尽不代表这篇文档坏了，不占用它的三次内容重试机会。
          this.matrix.markDetailError(item.doc_key, message, !rateLimited);
          if (rateLimited) {
            circuit.open = true;
            circuit.reason = message;
            // 实测列表与详情入口共享账户级硬限流，任一命中后当天整组停止。
            this.blockAllWisburgTools();
          } else if (consecutiveFailures >= 12) {
            circuit.open = true;
            circuit.reason = `连续 ${consecutiveFailures} 次详情失败`;
          }
        }
        if ((completed + failed) % 20 === 0 || completed + failed === pending.length) {
          options.onProgress({
            phase: kind === 'report' ? 'report-detail' : 'article-detail',
            source: kind,
            calls,
            items: pending.length,
            completed,
            failed,
            message: `${kind} 详情 ${completed + failed}/${pending.length}，成功 ${completed}`,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, () => worker()));
    return { calls, completed, failed };
  }

  private blockAllWisburgTools(): void {
    for (const wisburgTool of WISBURG_TOOLS) this.ledger.markExhausted(wisburgTool);
  }
}

function normalizeOptions(
  options: MatrixSyncOptions,
): Required<
  Pick<
    MatrixSyncOptions,
    'pageSize' | 'maxPagesPerSource' | 'maxTotalDetails' | 'maxReportDetails' | 'maxArticleDetails' | 'concurrency'
  >
> &
  MatrixSyncOptions & {
    shouldStop: () => boolean;
    onProgress: (event: MatrixSyncProgress) => void;
  } {
  return {
    ...options,
    pageSize: Math.min(100, Math.max(1, Math.trunc(options.pageSize))),
    maxPagesPerSource: Math.max(0, Math.trunc(options.maxPagesPerSource)),
    maxTotalDetails: Math.max(0, Math.trunc(options.maxTotalDetails)),
    maxReportDetails: Math.max(0, Math.trunc(options.maxReportDetails)),
    maxArticleDetails: Math.max(0, Math.trunc(options.maxArticleDetails)),
    concurrency: Math.min(12, Math.max(1, Math.trunc(options.concurrency))),
    shouldStop: options.shouldStop ?? (() => false),
    onProgress: options.onProgress ?? (() => undefined),
  };
}

async function parallelMap<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let index = 0;
  const worker = async () => {
    while (true) {
      const current = index++;
      const item = items[current];
      if (item === undefined) return;
      out[current] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}
