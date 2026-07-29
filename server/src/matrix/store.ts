import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { WisburgDetail, WisburgItem } from '../mcp/wisburg.js';
import { analyzeResearch, type MatrixTag } from './extract.js';

export type MatrixKind = 'report' | 'article' | 'feed' | 'daily' | 'image';

export interface MatrixDocumentInput {
  docKey: string;
  kind: MatrixKind;
  category: string;
  externalId: string;
  title: string;
  publishedAt: string;
  summary?: string;
  image?: string;
}

export interface MatrixSearchOptions {
  query?: string;
  kind?: string;
  category?: string;
  topic?: string;
  company?: string;
  stance?: string;
  limit?: number;
  offset?: number;
}

export interface MatrixSyncState {
  source: string;
  cursor: string | null;
  completed: boolean;
  pages: number;
  items: number;
  calls: number;
  lastSyncedAt: number;
  lastError: string | null;
}

interface PendingDetail {
  doc_key: string;
  kind: 'report' | 'article';
  category: string;
  external_id: string;
}

interface DocumentRow {
  doc_key: string;
  kind: MatrixKind;
  category: string;
  external_id: string;
  title: string;
  published_at: string;
  summary: string;
  conclusion: string;
  content: string;
  image: string;
  url: string;
  fields_json: string;
  detail_status: string;
  char_count: number;
  fetched_at: number;
  updated_at: number;
  error: string;
}

/** 可迁移的智堡研究 SQLite 矩阵。数据库文件只落在 STATE_DIR，不进入 Git。 */
export class ResearchMatrix {
  private readonly db: Database.Database;
  private readonly upsertMetadataTx: (input: MatrixDocumentInput) => void;
  private readonly upsertDetailTx: (docKey: string, detail: WisburgDetail) => void;

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();

    this.upsertMetadataTx = this.db.transaction((input: MatrixDocumentInput) => this.upsertMetadataInner(input));
    this.upsertDetailTx = this.db.transaction((docKey: string, detail: WisburgDetail) =>
      this.upsertDetailInner(docKey, detail),
    );
  }

  close(): void {
    this.db.close();
  }

  reindex(): number {
    const rows = this.db
      .prepare('SELECT doc_key, title, summary, content FROM matrix_documents ORDER BY rowid')
      .all() as Array<{ doc_key: string; title: string; summary: string; content: string }>;
    const run = this.db.transaction(() => {
      for (const row of rows) {
        const analysis = analyzeResearch(row.title, row.summary, row.content);
        this.db.prepare('UPDATE matrix_documents SET conclusion = ? WHERE doc_key = ?').run(analysis.conclusion, row.doc_key);
        this.replaceTags(row.doc_key, analysis.tags);
        this.refreshFts(row.doc_key);
      }
    });
    run();
    return rows.length;
  }

  upsertMetadata(input: MatrixDocumentInput): void {
    this.upsertMetadataTx(input);
  }

  hasDocument(docKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM matrix_documents WHERE doc_key = ?').get(docKey));
  }

  upsertWisburgItem(source: string, item: WisburgItem): string {
    const descriptor = sourceDescriptor(source, item.id);
    this.upsertMetadata({
      ...descriptor,
      externalId: item.id,
      title: item.title,
      publishedAt: item.time,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.image ? { image: item.image } : {}),
    });
    return descriptor.docKey;
  }

  upsertDetail(docKey: string, detail: WisburgDetail): void {
    this.upsertDetailTx(docKey, detail);
  }

  markDetailError(docKey: string, error: string, countAttempt = true): void {
    this.db
      .prepare(
        `UPDATE matrix_documents
         SET detail_status = 'error',
             detail_attempts = detail_attempts + ?,
             error = ?,
             updated_at = ?
         WHERE doc_key = ?`,
      )
      .run(countAttempt ? 1 : 0, error.slice(0, 1_000), Date.now(), docKey);
  }

  pendingDetails(kind: 'report' | 'article', limit: number): PendingDetail[] {
    return this.db
      .prepare(
        `SELECT doc_key, kind, category, external_id
         FROM matrix_documents
         WHERE kind = ?
           AND detail_status != 'complete'
           AND detail_attempts < 3
         ORDER BY
           CASE category
             WHEN 'company' THEN 0
             WHEN 'ib' THEN 1
             WHEN 'ec' THEN 2
             WHEN 'am' THEN 3
             WHEN 'archive' THEN 4
             ELSE 5
           END,
           published_at DESC,
           rowid DESC
         LIMIT ?`,
      )
      .all(kind, Math.max(1, Math.trunc(limit))) as PendingDetail[];
  }

  getSyncState(source: string): MatrixSyncState {
    const row = this.db.prepare('SELECT * FROM matrix_sync_state WHERE source = ?').get(source) as
      | {
          source: string;
          cursor: string | null;
          completed: number;
          pages: number;
          items: number;
          calls: number;
          last_synced_at: number;
          last_error: string | null;
        }
      | undefined;
    return row
      ? {
          source: row.source,
          cursor: row.cursor,
          completed: Boolean(row.completed),
          pages: row.pages,
          items: row.items,
          calls: row.calls,
          lastSyncedAt: row.last_synced_at,
          lastError: row.last_error,
        }
      : {
          source,
          cursor: null,
          completed: false,
          pages: 0,
          items: 0,
          calls: 0,
          lastSyncedAt: 0,
          lastError: null,
        };
  }

  saveSyncState(state: MatrixSyncState): void {
    this.db
      .prepare(
        `INSERT INTO matrix_sync_state
          (source, cursor, completed, pages, items, calls, last_synced_at, last_error)
         VALUES
          (@source, @cursor, @completed, @pages, @items, @calls, @lastSyncedAt, @lastError)
         ON CONFLICT(source) DO UPDATE SET
          cursor = excluded.cursor,
          completed = excluded.completed,
          pages = excluded.pages,
          items = excluded.items,
          calls = excluded.calls,
          last_synced_at = excluded.last_synced_at,
          last_error = excluded.last_error`,
      )
      .run({ ...state, completed: state.completed ? 1 : 0 });
  }

  resetSyncState(source?: string): void {
    if (source) this.db.prepare('DELETE FROM matrix_sync_state WHERE source = ?').run(source);
    else this.db.prepare('DELETE FROM matrix_sync_state').run();
  }

  startRun(options: Record<string, unknown>): number {
    const result = this.db
      .prepare(
        `INSERT INTO matrix_runs (started_at, status, options_json)
         VALUES (?, 'running', ?)`,
      )
      .run(Date.now(), JSON.stringify(options));
    return Number(result.lastInsertRowid);
  }

  finishRun(
    id: number,
    status: 'complete' | 'partial' | 'failed',
    result: Record<string, unknown>,
    error: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE matrix_runs
         SET finished_at = ?, status = ?, result_json = ?, error = ?
         WHERE id = ?`,
      )
      .run(Date.now(), status, JSON.stringify(result), error, id);
  }

  stats(): Record<string, unknown> {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS documents,
           SUM(CASE WHEN detail_status = 'complete' THEN 1 ELSE 0 END) AS complete,
           SUM(char_count) AS characters,
           MIN(NULLIF(published_at, '')) AS oldest,
           MAX(NULLIF(published_at, '')) AS newest
         FROM matrix_documents`,
      )
      .get() as Record<string, unknown>;
    const byKind = this.groupCount('kind');
    const byCategory = this.groupCount('category');
    const sync = this.db
      .prepare(
        `SELECT source, cursor, completed, pages, items, calls, last_synced_at AS lastSyncedAt, last_error AS lastError
         FROM matrix_sync_state
         ORDER BY source`,
      )
      .all();
    const lastRun = this.db
      .prepare(
        `SELECT id, started_at AS startedAt, finished_at AS finishedAt, status, result_json AS resultJson, error
         FROM matrix_runs
         ORDER BY id DESC LIMIT 1`,
      )
      .get();
    const databaseBytes = this.file !== ':memory:' && fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    return { ...totals, databaseBytes, byKind, byCategory, sync, lastRun: lastRun ?? null };
  }

  facets(dimension?: string, limit = 40): Array<{ dimension: string; value: string; count: number }> {
    const cap = boundedInteger(limit, 40, 1, 200);
    if (dimension) {
      return this.db
        .prepare(
          `SELECT dimension, value, COUNT(DISTINCT doc_key) AS count
           FROM matrix_tags
           WHERE dimension = ?
           GROUP BY dimension, value
           ORDER BY count DESC, value
           LIMIT ?`,
        )
        .all(dimension, cap) as Array<{ dimension: string; value: string; count: number }>;
    }
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT
             dimension,
             value,
             COUNT(DISTINCT doc_key) AS count,
             ROW_NUMBER() OVER (
               PARTITION BY dimension
               ORDER BY COUNT(DISTINCT doc_key) DESC, value
             ) AS rank
           FROM matrix_tags
           GROUP BY dimension, value
         )
         SELECT dimension, value, count
         FROM ranked
         WHERE rank <= ?
         ORDER BY dimension, count DESC, value`,
      )
      .all(cap) as Array<{ dimension: string; value: string; count: number }>;
  }

  grid(
    rowDimension = 'topic',
    columnDimension = 'stance',
  ): Array<{ row: string; column: string; count: number }> {
    return this.db
      .prepare(
        `SELECT r.value AS row, c.value AS column, COUNT(DISTINCT r.doc_key) AS count
         FROM matrix_tags r
         JOIN matrix_tags c ON c.doc_key = r.doc_key
         WHERE r.dimension = ? AND c.dimension = ?
         GROUP BY r.value, c.value
         ORDER BY count DESC, r.value, c.value`,
      )
      .all(rowDimension, columnDimension) as Array<{ row: string; column: string; count: number }>;
  }

  search(options: MatrixSearchOptions = {}): { items: Array<Record<string, unknown>>; total: number } {
    const limit = boundedInteger(options.limit, 30, 1, 100);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    let from = 'matrix_documents d';

    const query = options.query?.trim();
    if (query) {
      if (query.length >= 3) {
        from += ' JOIN matrix_fts f ON f.doc_key = d.doc_key';
        conditions.push('matrix_fts MATCH ?');
        params.push(`"${query.replace(/"/g, '""')}"`);
      } else {
        conditions.push('(d.title LIKE ? OR d.summary LIKE ? OR d.conclusion LIKE ?)');
        const like = `%${query}%`;
        params.push(like, like, like);
      }
    }

    for (const [column, value] of [
      ['kind', options.kind],
      ['category', options.category],
    ] as const) {
      if (!value) continue;
      conditions.push(`d.${column} = ?`);
      params.push(value);
    }

    for (const [dimension, value] of [
      ['topic', options.topic],
      ['company', options.company],
      ['stance', options.stance],
    ] as const) {
      if (!value) continue;
      conditions.push(
        `EXISTS (
          SELECT 1 FROM matrix_tags tf
          WHERE tf.doc_key = d.doc_key AND tf.dimension = ? AND tf.value = ?
        )`,
      );
      params.push(dimension, value);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = Number(
      (
        this.db.prepare(`SELECT COUNT(DISTINCT d.doc_key) AS count FROM ${from} ${where}`).get(...params) as {
          count: number;
        }
      ).count,
    );

    const rows = this.db
      .prepare(
        `SELECT d.doc_key, d.kind, d.category, d.external_id, d.title, d.published_at,
                d.summary, d.conclusion, d.image, d.url, d.detail_status, d.char_count,
                d.fetched_at, d.updated_at
         FROM ${from}
         ${where}
         ORDER BY d.published_at DESC, d.updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Omit<DocumentRow, 'content' | 'fields_json' | 'error'>>;

    const items = rows.map((row) => ({ ...camelDocument(row), tags: this.tagsFor(row.doc_key) }));
    return { items, total };
  }

  getDocument(docKey: string, includeContent = false): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM matrix_documents WHERE doc_key = ?').get(docKey) as
      | DocumentRow
      | undefined;
    if (!row) return null;
    const document = camelDocument(row);
    if (!includeContent) delete document.content;
    return { ...document, fields: safeJson(row.fields_json), tags: this.tagsFor(docKey) };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matrix_documents (
        doc_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        conclusion TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        fields_json TEXT NOT NULL DEFAULT '{}',
        detail_status TEXT NOT NULL DEFAULT 'metadata',
        detail_attempts INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT '',
        char_count INTEGER NOT NULL DEFAULT 0,
        fetched_at INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_matrix_documents_kind_time
        ON matrix_documents(kind, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_matrix_documents_category_time
        ON matrix_documents(category, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_matrix_documents_detail
        ON matrix_documents(kind, detail_status, published_at DESC);

      CREATE TABLE IF NOT EXISTS matrix_tags (
        doc_key TEXT NOT NULL REFERENCES matrix_documents(doc_key) ON DELETE CASCADE,
        dimension TEXT NOT NULL,
        value TEXT NOT NULL,
        score REAL NOT NULL,
        PRIMARY KEY (doc_key, dimension, value)
      );
      CREATE INDEX IF NOT EXISTS idx_matrix_tags_facet
        ON matrix_tags(dimension, value, doc_key);

      CREATE TABLE IF NOT EXISTS matrix_sync_state (
        source TEXT PRIMARY KEY,
        cursor TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0,
        items INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        last_synced_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS matrix_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        error TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS matrix_fts USING fts5(
        doc_key UNINDEXED,
        title,
        summary,
        conclusion,
        content,
        tokenize='trigram'
      );
    `);
  }

  private upsertMetadataInner(input: MatrixDocumentInput): void {
    const now = Date.now();
    const summary = input.summary?.trim() ?? '';
    this.db
      .prepare(
        `INSERT INTO matrix_documents (
          doc_key, kind, category, external_id, title, published_at, summary, image,
          first_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_key) DO UPDATE SET
          title = excluded.title,
          published_at = CASE WHEN excluded.published_at != '' THEN excluded.published_at ELSE matrix_documents.published_at END,
          summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE matrix_documents.summary END,
          image = CASE WHEN excluded.image != '' THEN excluded.image ELSE matrix_documents.image END,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.docKey,
        input.kind,
        input.category,
        input.externalId,
        input.title.trim(),
        input.publishedAt,
        summary,
        input.image ?? '',
        now,
        now,
      );

    const current = this.db
      .prepare('SELECT title, summary, content FROM matrix_documents WHERE doc_key = ?')
      .get(input.docKey) as { title: string; summary: string; content: string };
    const analysis = analyzeResearch(current.title, current.summary, current.content);
    this.db
      .prepare('UPDATE matrix_documents SET conclusion = ? WHERE doc_key = ? AND detail_status != ?')
      .run(analysis.conclusion, input.docKey, 'complete');
    this.replaceTags(input.docKey, analysis.tags);
    this.refreshFts(input.docKey);
  }

  private upsertDetailInner(docKey: string, detail: WisburgDetail): void {
    const current = this.db
      .prepare('SELECT title, summary FROM matrix_documents WHERE doc_key = ?')
      .get(docKey) as { title: string; summary: string } | undefined;
    if (!current) throw new Error(`矩阵里不存在文档 ${docKey}`);

    const title = detail.title.trim() || current.title;
    const content = detail.content.trim();
    const analysis = analyzeResearch(title, current.summary, content);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE matrix_documents
         SET title = ?,
             published_at = CASE WHEN ? != '' THEN ? ELSE published_at END,
             conclusion = ?,
             content = ?,
             url = ?,
             fields_json = ?,
             detail_status = 'complete',
             detail_attempts = detail_attempts + 1,
             content_hash = ?,
             char_count = ?,
             fetched_at = ?,
             updated_at = ?,
             error = ''
         WHERE doc_key = ?`,
      )
      .run(
        title,
        detail.time,
        detail.time,
        analysis.conclusion,
        content,
        detail.url ?? '',
        JSON.stringify(detail.fields),
        crypto.createHash('sha256').update(content).digest('hex'),
        content.length,
        now,
        now,
        docKey,
      );
    this.replaceTags(docKey, analysis.tags);
    this.refreshFts(docKey);
  }

  private replaceTags(docKey: string, tags: MatrixTag[]): void {
    this.db.prepare('DELETE FROM matrix_tags WHERE doc_key = ?').run(docKey);
    const insert = this.db.prepare(
      `INSERT INTO matrix_tags (doc_key, dimension, value, score)
       VALUES (?, ?, ?, ?)`,
    );
    for (const tag of tags) insert.run(docKey, tag.dimension, tag.value, tag.score);
  }

  private refreshFts(docKey: string): void {
    const row = this.db
      .prepare('SELECT doc_key, title, summary, conclusion, content FROM matrix_documents WHERE doc_key = ?')
      .get(docKey) as {
      doc_key: string;
      title: string;
      summary: string;
      conclusion: string;
      content: string;
    };
    this.db.prepare('DELETE FROM matrix_fts WHERE doc_key = ?').run(docKey);
    this.db
      .prepare('INSERT INTO matrix_fts (doc_key, title, summary, conclusion, content) VALUES (?, ?, ?, ?, ?)')
      .run(row.doc_key, row.title, row.summary, row.conclusion, row.content);
  }

  private tagsFor(docKey: string): Array<{ dimension: string; value: string; score: number }> {
    return this.db
      .prepare(
        `SELECT dimension, value, score
         FROM matrix_tags
         WHERE doc_key = ?
         ORDER BY dimension, score DESC, value`,
      )
      .all(docKey) as Array<{ dimension: string; value: string; score: number }>;
  }

  private groupCount(column: 'kind' | 'category'): Array<{ key: string; count: number }> {
    return this.db
      .prepare(
        `SELECT ${column} AS key, COUNT(*) AS count
         FROM matrix_documents
         GROUP BY ${column}
         ORDER BY count DESC, key`,
      )
      .all() as Array<{ key: string; count: number }>;
  }
}

export function sourceDescriptor(
  source: string,
  externalId: string,
): Pick<MatrixDocumentInput, 'docKey' | 'kind' | 'category'> {
  if (source.startsWith('report:')) {
    const category = source.slice('report:'.length);
    return { docKey: `report:${category}:${externalId}`, kind: 'report', category };
  }
  if (source === 'article') return { docKey: `article:${externalId}`, kind: 'article', category: 'article' };
  if (source === 'feed') return { docKey: `feed:${externalId}`, kind: 'feed', category: 'feed' };
  if (source === 'daily') return { docKey: `daily:${externalId}`, kind: 'daily', category: 'daily' };
  if (source === 'image') return { docKey: `image:${hashKey(externalId)}`, kind: 'image', category: 'image' };
  throw new Error(`未知矩阵来源 ${source}`);
}

function camelDocument(row: Partial<DocumentRow> & { doc_key: string }): Record<string, unknown> {
  return {
    docKey: row.doc_key,
    kind: row.kind,
    category: row.category,
    externalId: row.external_id,
    title: row.title,
    publishedAt: row.published_at,
    summary: row.summary,
    conclusion: row.conclusion,
    content: row.content,
    image: row.image,
    url: row.url,
    detailStatus: row.detail_status,
    charCount: row.char_count,
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function hashKey(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
