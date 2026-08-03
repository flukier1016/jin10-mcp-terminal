import crypto from 'node:crypto';
import { Router } from 'express';
import type { ResearchMatrix } from '../matrix/store.js';

/** 智堡 Matrix 只读 API；默认不向公网返回缓存的完整正文。 */
export function createMatrixRouter(
  matrix: ResearchMatrix,
  options: { publicContent: boolean; adminToken: string },
): Router {
  const router = Router();
  const ok = <T>(data: T) => ({ ok: true as const, data });

  router.get('/stats', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json(ok(matrix.stats()));
  });

  router.get('/facets', (req, res) => {
    const dimension = String(req.query.dimension ?? '').trim() || undefined;
    const limit = Number(req.query.limit ?? 40);
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json(ok(matrix.facets(dimension, limit)));
  });

  router.get('/grid', (req, res) => {
    const row = String(req.query.row ?? 'topic');
    const column = String(req.query.column ?? 'stance');
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json(ok({ row, column, cells: matrix.grid(row, column) }));
  });

  router.get('/search', (req, res) => {
    const data = matrix.search({
      ...(req.query.q ? { query: String(req.query.q) } : {}),
      ...(req.query.kind ? { kind: String(req.query.kind) } : {}),
      ...(req.query.category ? { category: String(req.query.category) } : {}),
      ...(req.query.topic ? { topic: String(req.query.topic) } : {}),
      ...(req.query.company ? { company: String(req.query.company) } : {}),
      ...(req.query.stance ? { stance: String(req.query.stance) } : {}),
      limit: Number(req.query.limit ?? 30),
      offset: Number(req.query.offset ?? 0),
    });
    res.setHeader('Cache-Control', 'public, max-age=15');
    res.json(ok(data));
  });

  router.get('/document/:docKey', (req, res) => {
    const wantsContent = /^(1|true|yes)$/i.test(String(req.query.content ?? ''));
    const includeContent = wantsContent && (options.publicContent || authorized(req.headers.authorization, options.adminToken));
    if (wantsContent && !includeContent) {
      return res.status(403).json({
        ok: false,
        error: { kind: 'forbidden', message: '完整正文未公开；请使用 MATRIX_ADMIN_TOKEN' },
      });
    }
    const document = matrix.getDocument(String(req.params.docKey), includeContent);
    if (!document) return res.status(404).json({ ok: false, error: { kind: 'not_found', message: '文档不存在' } });
    res.setHeader('Cache-Control', includeContent ? 'private, no-store' : 'public, max-age=30');
    res.json(ok(document));
  });

  return router;
}

function authorized(header: string | undefined, token: string): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
