const crypto = require('node:crypto');

const COOKIE = 'major_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const reference = Buffer.from(expected, 'hex');
  return actual.length === reference.length && crypto.timingSafeEqual(actual, reference);
}

function installAuth(app, store, telegramBot) {
  const attempts = new Map();
  const secure = process.env.NODE_ENV === 'production';
  const cookieOptions = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
  const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const sessionToken = (req) => (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email });

  function signIn(res, user) {
    const token = crypto.randomBytes(32).toString('hex');
    store.saveSession(tokenHash(token), user.id, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions}`);
    res.json({ user: publicUser(user) });
  }

  app.get('/api/auth/state', (req, res) => {
    const token = sessionToken(req);
    const user = token && store.findSession(tokenHash(token));
    res.json({ user: user ? publicUser(user) : null });
  });

  app.post('/api/auth/register', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (name.length < 2 || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 128) {
      return res.status(422).json({ error: 'Informe nome, e-mail válido e senha de 12 a 128 caracteres.' });
    }
    if (store.findUserByEmail(email)) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    if (store.findPendingByEmail(email)) return res.status(409).json({ error: 'Este e-mail já tem um cadastro pendente de aprovação.' });
    const token = sessionToken(req);
    const currentUser = token && store.findSession(tokenHash(token));
    const pendingId = crypto.randomUUID();
    store.createPendingRegistration({ id: pendingId, name, email, passwordHash: hashPassword(password), requestedBy: currentUser?.id || null });
    telegramBot?.notifyPendingRegistration({ id: pendingId, name, email, requestedByName: currentUser?.name });
    return res.status(202).json({ pending: true, message: 'Cadastro enviado para aprovação.' });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(req.body?.password || '');
    const key = req.ip;
    const entry = attempts.get(key) || { count: 0, until: 0 };
    if (entry.until > Date.now()) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em 15 minutos.' });
    const user = store.findUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const pending = store.findPendingByEmail(email);
      if (pending && verifyPassword(password, pending.passwordHash)) {
        return res.status(403).json({ error: 'Cadastro pendente de aprovação.' });
      }
      entry.count += 1;
      entry.until = entry.count >= 10 ? Date.now() + 15 * 60 * 1000 : 0;
      attempts.set(key, entry);
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    attempts.delete(key);
    return signIn(res, user);
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) store.deleteSession(tokenHash(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOptions}; Max-Age=0`);
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    const token = sessionToken(req);
    const user = token && store.findSession(tokenHash(token));
    if (!user) return res.status(401).json({ error: 'Faça login para continuar.' });
    req.user = user;
    next();
  });
}

module.exports = { installAuth, hashPassword, verifyPassword };
