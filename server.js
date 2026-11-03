'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { MailWatcher } = require('./mail');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILS = 5;                       // intentos fallidos por IP...
const LOCK_MS = 15 * 60 * 1000;            // ...antes de bloquearla 15 minutos
const FAIL_DELAY_MS = 1000;
const MAX_VIEWS_PER_SESSION = 10;
const MIN_PASSWORD_LENGTH = 12;
const PUBLIC_DIR = path.join(__dirname, 'public');   // solo CSS y JS, sin datos
const PAGES_DIR = path.join(__dirname, 'views');

const APP_CSP = [
  "default-src 'self'",
  "img-src 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// El HTML de un correo es contenido ajeno: se sirve aislado, sin scripts ni formularios.
const MAIL_CSP = [
  "default-src 'none'",
  'img-src https: data:',
  "style-src 'unsafe-inline' https:",
  'font-src https: data:',
  "frame-ancestors 'self'",
  'sandbox allow-popups allow-popups-to-escape-sandbox',
].join('; ');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const randomId = () => crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}

function createApp({ password, watcher }) {
  const expected = sha256(password);
  const sessions = new Map();   // sid -> { expires, views: Map<viewId, firstUid> }
  const fails = new Map();      // ip -> { count, first, until }

  setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) if (s.expires < now) sessions.delete(sid);
    for (const [ip, f] of fails) if (f.until < now && f.first + LOCK_MS < now) fails.delete(ip);
  }, 10 * 60 * 1000).unref();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': APP_CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  function getSession(req) {
    const sid = parseCookies(req.headers.cookie).sid;
    const session = sid && sessions.get(sid);
    if (!session) return null;
    if (session.expires < Date.now()) {
      sessions.delete(sid);
      return null;
    }
    return session;
  }

  function requireSession(req, res, next) {
    req.session = getSession(req);
    if (!req.session) return res.status(401).json({ error: 'no autorizado' });
    next();
  }

  function requireView(req, res, next) {
    req.firstUid = req.session.views.get(req.params.viewId);
    if (req.firstUid === undefined) return res.status(404).json({ error: 'vista no encontrada' });
    next();
  }

  function isLocked(ip) {
    const f = fails.get(ip);
    return Boolean(f && f.until > Date.now());
  }

  function registerFail(ip) {
    const now = Date.now();
    let f = fails.get(ip);
    if (!f || f.first + LOCK_MS < now) f = { count: 0, first: now, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) f.until = now + LOCK_MS;
    fails.set(ip, f);
  }

  app.get('/', (req, res) => {
    if (!getSession(req)) return res.redirect('/login');
    res.sendFile(path.join(PAGES_DIR, 'app.html'));
  });

  app.get('/login', (req, res) => {
    if (getSession(req)) return res.redirect('/');
    res.sendFile(path.join(PAGES_DIR, 'login.html'));
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    if (isLocked(req.ip)) return res.redirect('/login?e=locked');

    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(sha256(given), expected)) {
      registerFail(req.ip);
      await sleep(FAIL_DELAY_MS);
      return res.redirect(isLocked(req.ip) ? '/login?e=locked' : '/login?e=bad');
    }

    fails.delete(req.ip);
    const sid = randomId();
    sessions.set(sid, { expires: Date.now() + SESSION_TTL_MS, views: new Map() });
    res.cookie('sid', sid, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    sessions.delete(parseCookies(req.headers.cookie).sid);
    res.clearCookie('sid', { path: '/' });
    res.redirect('/login');
  });

  // Cada vez que se abre la página se crea una "vista": solo verá correos desde ese momento.
  app.post('/api/views', requireSession, (req, res) => {
    const { views } = req.session;
    if (views.size >= MAX_VIEWS_PER_SESSION) views.delete(views.keys().next().value);
    const viewId = randomId();
    views.set(viewId, watcher.viewStartUid());
    res.json({ viewId });
  });

  app.get('/api/views/:viewId/messages', requireSession, requireView, (req, res) => {
    const after = Number.parseInt(req.query.after, 10) || 0;
    const messages = watcher
      .messagesFrom(Math.max(req.firstUid, after + 1))
      .map(({ uid, receivedAt, from, subject, text, html }) => ({
        uid,
        receivedAt,
        from,
        subject,
        hasHtml: html !== null,
        text: html === null ? text : '',
      }));
    res.json({ connected: watcher.connected, messages });
  });

  app.get('/api/views/:viewId/messages/:uid/html', requireSession, requireView, (req, res) => {
    const uid = Number.parseInt(req.params.uid, 10);
    const message = uid >= req.firstUid && watcher.messagesFrom(uid).find((m) => m.uid === uid);
    if (!message || message.html === null) return res.status(404).end();
    res.set({ 'Content-Security-Policy': MAIL_CSP, 'X-Frame-Options': 'SAMEORIGIN' });
    res.type('html').send(`<!doctype html><meta charset="utf-8"><base target="_blank">${message.html}`);
  });

  app.use(express.static(PUBLIC_DIR, { index: false }));

  return app;
}

function main() {
  const env = process.env;
  const required = ['APP_PASSWORD', 'IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`Faltan variables de entorno: ${missing.join(', ')} (ver .env.example)`);
    process.exit(1);
  }
  if (env.APP_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    console.error(`APP_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    process.exit(1);
  }

  const watcher = new MailWatcher({
    host: env.IMAP_HOST,
    port: Number(env.IMAP_PORT || 993),
    secure: env.IMAP_SECURE !== 'false',
    user: env.IMAP_USER,
    pass: env.IMAP_PASS,
    mailbox: env.IMAP_MAILBOX || 'INBOX',
    lookbackMs: Number(env.LOOKBACK_MINUTES || 0) * 60 * 1000,
    fromFilter: (env.FROM_FILTER || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  });
  watcher.start();

  const port = Number(env.PORT || 3000);
  createApp({ password: env.APP_PASSWORD, watcher }).listen(port, () => {
    console.log(`Listo en http://localhost:${port}`);
  });
}

if (require.main === module) main();

module.exports = { createApp };
