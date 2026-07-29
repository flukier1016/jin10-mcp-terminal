/**
 * 默认走同源 API；需要把 Vite 前端单独部署到 CDN/静态站点时，只需在构建时
 * 设置 VITE_API_BASE_URL=https://terminal-api.example.com。
 */
const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';

export const API_BASE_URL = configuredBase.replace(/\/+$/, '');

export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}/api${normalized}`;
}
