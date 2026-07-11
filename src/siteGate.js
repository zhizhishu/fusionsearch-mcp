import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Site-wide access gate. When SITE_GATE_PASSWORD is set, every browser-facing
// route (homepage, search proxy, /status, /admin) is hidden behind a single
// access code and a neutral cover page. Programmatic MCP traffic (Bearer / token)
// and the container health check stay open so clients and HF keep working.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_DIR = path.resolve(__dirname, '../public/gate');
const COOKIE_NAME = 'cloudspace_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Paths that must never be gated: container health, the MCP families (Bearer
// guarded), legacy SSE endpoints, and the gate's own cover assets + login API.
const EXEMPT_PATH_RE =
  /^\/(health$|mcp(\/|$)|libresearch\/mcp|fusion\/mcp|sse(\/|$)|messages(\/|$)|gate(\/|$)|api\/gate\/|api\/perplexity\/sync-token$)/;

function safeEqual(left = '', right = '') {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function createSessionCookieValue(secret) {
  const payload = JSON.stringify({
    nonce: randomBytes(16).toString('base64url'),
    exp: Date.now() + SESSION_TTL_MS
  });
  const encodedPayload = Buffer.from(payload).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

function verifySessionCookieValue(value, secret) {
  if (!value || !value.includes('.')) return false;
  const [encodedPayload, signature] = value.split('.', 2);
  if (!safeEqual(signature, sign(encodedPayload, secret))) return false;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// Cross-site cookie so the gate keeps working inside the HF Space iframe
// (SameSite=None;Secure on HTTPS); fall back to Lax on plain local HTTP.
function cookieOptions(req) {
  const secure = isSecureRequest(req);
  return [
    'Path=/',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? 'Secure' : ''
  ]
    .filter(Boolean)
    .join('; ');
}

function clearCookieOptions(req) {
  const secure = isSecureRequest(req);
  return [
    'Path=/',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : ''
  ]
    .filter(Boolean)
    .join('; ');
}

// Any request that carries an MCP-style credential is a programmatic client,
// not a browser, so it bypasses the cover regardless of path.
function carriesMachineToken(req) {
  const authorization = String(req.headers.authorization || '');
  if (authorization.toLowerCase().startsWith('bearer ')) return true;
  if (req.headers['x-mcp-token']) return true;
  if (req.query && req.query.token) return true;
  if ((req.path || '').includes('/ApiKey=')) return true;
  return false;
}

let coverHtmlCache = null;
function loadCover() {
  if (coverHtmlCache !== null) return coverHtmlCache;
  try {
    coverHtmlCache = fs.readFileSync(path.join(GATE_DIR, 'index.html'), 'utf8');
  } catch {
    coverHtmlCache =
      '<!doctype html><meta charset="utf-8"><title>CloudSpace</title>' +
      '<body style="background:#0a0e17;color:#e8edf6;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
      '<form onsubmit="event.preventDefault();fetch(\'/api/gate/login\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},credentials:\'same-origin\',body:JSON.stringify({password:this.p.value})}).then(r=>r.ok&&location.replace(\'/\'))">' +
      '<div style="text-align:center"><h1>CloudSpace</h1><p>网站演示动画参考 · 请输入访问口令</p>' +
      '<input name="p" type="password" placeholder="访问口令" style="padding:10px;border-radius:8px;border:1px solid #333;background:#11161f;color:#fff">' +
      '<button style="padding:10px 16px;margin-left:8px;border:0;border-radius:8px;background:#6ea8ff;color:#08101f">进入</button></div></form></body>';
  }
  return coverHtmlCache;
}

export function createSiteGate({ password = '', secret = '' } = {}) {
  const code = String(password || '');
  const enabled = code.length > 0;
  const sessionSecret = String(secret || code || randomBytes(32).toString('base64url'));

  const isAuthenticated = (req) =>
    verifySessionCookieValue(parseCookies(req.headers.cookie).cloudspace_session ?? '', sessionSecret);

  const middleware = (req, res, next) => {
    if (!enabled) return next();
    if (EXEMPT_PATH_RE.test(req.path || '/')) return next();
    if (carriesMachineToken(req)) return next();
    if (isAuthenticated(req)) return next();

    res.setHeader('Cache-Control', 'no-store');
    const accept = String(req.headers.accept || '');
    if (req.method === 'GET' && accept.includes('text/html')) {
      res.status(200).type('html').send(loadCover());
      return;
    }
    res.status(401).json({ error: { code: 'GATE_REQUIRED', message: 'Restricted preview.' } });
  };

  const login = (req, res) => {
    if (!enabled) {
      res.json({ ok: true, gateEnabled: false });
      return;
    }
    const supplied = String(req.body?.password ?? req.body?.token ?? '');
    if (!supplied || !safeEqual(supplied, code)) {
      res.status(401).json({ ok: false, error: { code: 'GATE_INVALID', message: '访问口令无效' } });
      return;
    }
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(createSessionCookieValue(sessionSecret))}; ${cookieOptions(req)}`
    );
    res.json({ ok: true });
  };

  const logout = (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${clearCookieOptions(req)}`);
    res.json({ ok: true });
  };

  return { enabled, middleware, login, logout, gateDir: GATE_DIR };
}
