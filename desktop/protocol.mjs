import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_URL = 'hoc://app/';
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: https://hoc-platform.house-of-chances.workers.dev/v1/events https://hoc-events.10170923.xyz/v1/events",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

const mediaTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.zip': 'application/zip', '.hocpkg': 'application/zip'
};

export function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'hoc:' && url.hostname === 'app'
      && !url.port && !url.username && !url.password;
  } catch { return false; }
}

export function resolveAssetPath(root, value) {
  if (!isAppUrl(value)) return null;
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    // Reject platform-specific separators, NTFS streams and decoded traversal.
    if (/[\\\0:]/.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.')) return null;
    const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const path = relative(root, target);
    return !path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep) ? null : target;
  } catch { return null; }
}

export function createAssetHandler(root, fetchFile) {
  return async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const file = resolveAssetPath(root, request.url);
    if (!file) return new Response(null, { status: 403 });
    try {
      const response = await fetchFile(pathToFileURL(file).href, { method: request.method });
      const headers = new Headers(response.headers);
      headers.set('Content-Type', mediaTypes[extname(file).toLowerCase()] ?? 'application/octet-stream');
      headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-cache');
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    } catch { return new Response(null, { status: 404 }); }
  };
}
