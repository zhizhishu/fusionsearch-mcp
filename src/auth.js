import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'fusionsearch_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeEqual(left = '', right = '') {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
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

function createSessionCookie(secret) {
  const payload = JSON.stringify({
    nonce: randomBytes(16).toString('base64url'),
    exp: Date.now() + SESSION_TTL_MS
  });
  const encodedPayload = Buffer.from(payload).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

function verifySessionCookie(value, secret) {
  if (!value || !value.includes('.')) return false;
  const [encodedPayload, signature] = value.split('.', 2);
  const expected = sign(encodedPayload, secret);
  if (!safeEqual(signature, expected)) return false;

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

function cookieOptions(req) {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    isSecureRequest(req) ? 'Secure' : ''
  ]
    .filter(Boolean)
    .join('; ');
}

function clearCookieOptions(req) {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    isSecureRequest(req) ? 'Secure' : ''
  ]
    .filter(Boolean)
    .join('; ');
}

function extractMcpToken(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return req.headers['x-mcp-token'] || req.query?.token || '';
}

export function createAuth({
  adminAuthEnabled = false,
  adminToken = '',
  sessionSecret = '',
  mcpAuthToken = ''
} = {}) {
  let state = {};

  const update = (next = {}) => {
    const nextAdminToken = String(next.adminToken ?? '');
    state = {
      adminEnabled: Boolean(next.adminAuthEnabled && nextAdminToken),
      adminToken: nextAdminToken,
      secret: String(next.sessionSecret || nextAdminToken || randomBytes(32).toString('base64url')),
      mcpEnabled: Boolean(next.mcpAuthToken),
      mcpAuthToken: String(next.mcpAuthToken ?? '')
    };
  };

  update({ adminAuthEnabled, adminToken, sessionSecret, mcpAuthToken });

  const isAdminAuthenticated = (req) => {
    if (!state.adminEnabled) return true;
    const cookies = parseCookies(req.headers.cookie);
    return verifySessionCookie(cookies[COOKIE_NAME], state.secret);
  };

  const verifyAdminToken = (token) => {
    if (!state.adminEnabled) return true;
    return safeEqual(String(token ?? ''), state.adminToken);
  };

  const requireAdmin = (req, res, next) => {
    if (isAdminAuthenticated(req)) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        code: 'ADMIN_AUTH_REQUIRED',
        message: '需要先登录管理后台'
      }
    });
  };

  const requireMcp = (req, res, next) => {
    if (!state.mcpEnabled || safeEqual(String(extractMcpToken(req)), state.mcpAuthToken)) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        code: 'MCP_AUTH_REQUIRED',
        message: '需要有效的 MCP Token'
      }
    });
  };

  const sessionInfo = (req) => ({
    adminAuthEnabled: state.adminEnabled,
    adminAuthenticated: isAdminAuthenticated(req),
    mcpAuthEnabled: state.mcpEnabled
  });

  const login = (req, res) => {
    if (!state.adminEnabled) {
      res.json(sessionInfo(req));
      return;
    }

    const token = String(req.body?.token ?? '');
    if (!verifyAdminToken(token)) {
      res.status(401).json({
        error: {
          code: 'ADMIN_LOGIN_FAILED',
          message: '管理口令无效'
        }
      });
      return;
    }

    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(createSessionCookie(state.secret))}; ${cookieOptions(req)}`);
    res.json({ ...sessionInfo(req), adminAuthenticated: true });
  };

  const clearSession = (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${clearCookieOptions(req)}`);
  };

  const logout = (req, res) => {
    clearSession(req, res);
    res.json({ ...sessionInfo(req), adminAuthenticated: false });
  };

  return {
    get adminAuthEnabled() {
      return state.adminEnabled;
    },
    get mcpAuthEnabled() {
      return state.mcpEnabled;
    },
    sessionInfo,
    verifyAdminToken,
    update,
    clearSession,
    login,
    logout,
    requireAdmin,
    requireMcp
  };
}
