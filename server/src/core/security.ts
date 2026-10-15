import type { RequestHandler } from 'express';

/**
 * 浏览器安全响应头：禁止被别的网页嵌入、不嗅探内容类型、只走 HTTPS。
 * 不限制脚本来源：首页有一段内联启动脚本，严格的 script-src 会把它拦掉。
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
};
