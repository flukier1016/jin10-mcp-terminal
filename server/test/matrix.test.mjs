import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { QuotaLedger } from '../dist/core/quota.js';
import { analyzeResearch } from '../dist/matrix/extract.js';
import { ResearchMatrix } from '../dist/matrix/store.js';
import { WisburgMatrixSync } from '../dist/matrix/sync.js';

test('结论抽取只使用原文，并生成主题、公司与观点标签', () => {
  const analysis = analyzeResearch(
    '富国银行：商业不良贷款下降，维持超配评级',
    '',
    [
      '### 主要观点',
      '资产质量改善，商业不良贷款显著下降。',
      '',
      '### 陈述总结',
      '维持富国银行超配评级，目标价上调至108美元。',
    ].join('\n'),
  );

  assert.match(analysis.conclusion, /维持富国银行超配评级/);
  assert.ok(analysis.tags.some((tag) => tag.dimension === 'company' && tag.value === '富国银行'));
  assert.ok(analysis.tags.some((tag) => tag.dimension === 'stance' && tag.value === '偏多'));
});

test('SQLite Matrix 持久化详情、标签、全文检索和二维聚合', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisburg-matrix-'));
  const file = path.join(dir, 'matrix.sqlite');
  try {
    const matrix = new ResearchMatrix(file);
    matrix.upsertWisburgItem('report:company', {
      id: '97902',
      title: '富国银行：商业不良贷款下降，维持超配评级',
      time: '2026-07-29T11:54:43+08:00',
      category: 'company',
    });
    matrix.upsertDetail('report:company:97902', {
      id: '97902',
      title: '富国银行：商业不良贷款下降，维持超配评级',
      time: '2026-07-29T11:54:43+08:00',
      content: '### 陈述总结\n维持富国银行超配评级，商业不良贷款下降，资产质量改善。',
      fields: {},
    });

    assert.equal(matrix.stats().documents, 1);
    assert.equal(matrix.search({ query: '商业不良贷款' }).total, 1);
    assert.ok(matrix.facets('company').some((facet) => facet.value === '富国银行'));
    assert.ok(matrix.facets(undefined, Number.NaN).length > 0);
    assert.equal(matrix.search({ limit: Number.NaN, offset: Number.NaN }).total, 1);
    assert.ok(matrix.grid('company', 'stance').some((cell) => cell.row === '富国银行' && cell.column === '偏多'));
    matrix.close();

    const restored = new ResearchMatrix(file);
    assert.equal(restored.getDocument('report:company:97902', true)?.detailStatus, 'complete');
    restored.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('批量同步按游标写检查点，第二次只检查头页且不会重复抓详情', async () => {
  const matrix = new ResearchMatrix(':memory:');
  const ledger = new QuotaLedger(20, 0, 24);
  const fakeWisburg = {
    async listReports(category) {
      assert.equal(category, 'company');
      return {
        items: [
          { id: '1', title: '苹果：维持买入评级', time: '2026-07-29T10:00:00+08:00', category: 'company' },
          { id: '2', title: '特斯拉：需求短期承压', time: '2026-07-29T09:00:00+08:00', category: 'company' },
        ],
        next_cursor: null,
        has_more: false,
      };
    },
    async getReport(id) {
      return {
        id,
        title: id === '1' ? '苹果：维持买入评级' : '特斯拉：需求短期承压',
        time: '2026-07-29T10:00:00+08:00',
        content: id === '1' ? '### 结论\n维持买入评级，长期增长。' : '### 结论\n短期需求承压，维持中性。',
        fields: {},
      };
    },
  };
  const sync = new WisburgMatrixSync(fakeWisburg, ledger, matrix);
  const options = {
    pageSize: 100,
    maxPagesPerSource: 10,
    maxTotalDetails: 10,
    maxReportDetails: 10,
    maxArticleDetails: 0,
    concurrency: 2,
    sources: ['report:company', 'report-detail'],
  };

  const first = await sync.run(options);
  assert.equal(first.listCalls, 1);
  assert.equal(first.reportDetails, 2);
  assert.equal(matrix.stats().documents, 2);

  const second = await sync.run(options);
  assert.equal(second.listCalls, 1);
  assert.equal(second.reportDetailCalls, 0);
  matrix.close();
});

test('详情接口出现 429 时立即熔断共享额度，避免继续空打', async () => {
  const matrix = new ResearchMatrix(':memory:');
  const ledger = new QuotaLedger(20, 0, 24);
  const fakeWisburg = {
    async listReports() {
      return {
        items: Array.from({ length: 10 }, (_, index) => ({
          id: String(index + 1),
          title: `公司${index + 1}：测试报告`,
          time: '2026-07-29T10:00:00+08:00',
          category: 'company',
        })),
        next_cursor: null,
        has_more: false,
      };
    },
    async getReport() {
      throw new Error('429 Too Many Requests');
    },
  };
  const sync = new WisburgMatrixSync(fakeWisburg, ledger, matrix);
  const result = await sync.run({
    pageSize: 100,
    maxPagesPerSource: 1,
    maxTotalDetails: 10,
    maxReportDetails: 10,
    maxArticleDetails: 0,
    concurrency: 4,
    sources: ['report:company', 'report-detail'],
  });

  assert.ok(result.reportDetailCalls <= 4);
  assert.equal(ledger.isBlocked('get-report-detail'), true);
  assert.equal(ledger.isBlocked('get-article-detail'), true);
  assert.equal(ledger.isBlocked('list-articles'), true);
  matrix.close();
});

test('任一列表入口出现 429 时熔断整个智堡账户额度', async () => {
  const matrix = new ResearchMatrix(':memory:');
  const ledger = new QuotaLedger(20, 0, 24);
  const fakeWisburg = {
    async listReports() {
      throw new Error('429 Too Many Requests');
    },
    async listFeed() {
      throw new Error('429 Too Many Requests');
    },
  };
  const sync = new WisburgMatrixSync(fakeWisburg, ledger, matrix);
  const result = await sync.run({
    pageSize: 100,
    maxPagesPerSource: 1,
    maxTotalDetails: 0,
    maxReportDetails: 0,
    maxArticleDetails: 0,
    concurrency: 4,
    sources: ['report:company', 'feed'],
  });

  assert.ok(result.listCalls <= 2);
  assert.equal(ledger.isBlocked('list-company-reports'), true);
  assert.equal(ledger.isBlocked('list-feed'), true);
  assert.equal(ledger.isBlocked('get-report-detail'), true);
  matrix.close();
});

test('账户限流不会耗尽单篇文档的内容重试次数', async () => {
  const matrix = new ResearchMatrix(':memory:');
  let limited = true;
  const fakeWisburg = {
    async listReports() {
      return {
        items: [{ id: '1', title: '苹果：测试报告', time: '2026-07-29T10:00:00+08:00', category: 'company' }],
        next_cursor: null,
        has_more: false,
      };
    },
    async getReport() {
      if (limited) throw new Error('429 Too Many Requests');
      return {
        id: '1',
        title: '苹果：测试报告',
        time: '2026-07-29T10:00:00+08:00',
        content: '### 结论\n维持买入评级。',
        fields: {},
      };
    },
  };
  const options = {
    pageSize: 100,
    maxPagesPerSource: 1,
    maxTotalDetails: 1,
    maxReportDetails: 1,
    maxArticleDetails: 0,
    concurrency: 1,
    sources: ['report:company', 'report-detail'],
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sync = new WisburgMatrixSync(fakeWisburg, new QuotaLedger(20, 0, 24), matrix);
    const result = await sync.run(options);
    assert.equal(result.reportDetails, 0);
  }

  limited = false;
  const recovery = new WisburgMatrixSync(fakeWisburg, new QuotaLedger(20, 0, 24), matrix);
  const result = await recovery.run(options);
  assert.equal(result.reportDetails, 1);
  assert.equal(matrix.getDocument('report:company:1')?.detailStatus, 'complete');
  matrix.close();
});
