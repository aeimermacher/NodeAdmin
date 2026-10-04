import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = 'nodeadmin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

const sessions = new Map(); // token -> expiry timestamp
const failedLogins = new Map(); // ip -> { count, resetAt }

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split(':');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}

export function getSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return null;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function startSession(req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  const secure = req.secure || process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  );
}

export function endSession(req, res) {
  const token = getSession(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export function isRateLimited(ip) {
  const entry = failedLogins.get(ip);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILED_LOGINS);
}

export function recordFailedLogin(ip) {
  const now = Date.now();
  let entry = failedLogins.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + FAILED_LOGIN_WINDOW_MS };
    failedLogins.set(ip, entry);
  }
  entry.count++;
}

export function clearFailedLogins(ip) {
  failedLogins.delete(ip);
}
