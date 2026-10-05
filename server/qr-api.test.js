const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createCampaignStore } = require('./storage');

test('gera QR Code e reconhece os estados de conexão devolvidos pelo WPPConnect', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-qr-'));
  const image = Buffer.from('89504e470d0a1a0a', 'hex');
  let sessionStatus = 'inChat';
  let issuedTokens = 0;
  let rejectCurrentToken = false;
  const wpp = http.createServer((req, res) => {
    if (/^\/api\/[^/]+\/test-secret\/generate-token$/.test(req.url)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token: `test-token-${++issuedTokens}` }));
    } else if (/^\/api\/[^/]+\/start-session$/.test(req.url)) {
      assert.equal(req.headers.authorization, 'Bearer test-token-1');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'QRCODE', qrcode: null }));
    } else if (/^\/api\/[^/]+\/qrcode-session$/.test(req.url)) {
      assert.equal(req.headers.authorization, 'Bearer test-token-1');
      res.setHeader('Content-Type', 'image/png');
      res.end(image);
    } else if (/^\/api\/[^/]+\/status-session$/.test(req.url)) {
      if (rejectCurrentToken && req.headers.authorization === 'Bearer test-token-1') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Check that the Session and Token are correct' }));
        return;
      }
      assert.equal(req.headers.authorization, rejectCurrentToken ? 'Bearer test-token-2' : 'Bearer test-token-1');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: sessionStatus }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => wpp.listen(0, '127.0.0.1', resolve));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const databasePath = path.join(directory, 'test.sqlite');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: databasePath,
      NODE_ENV: 'test', DEMO_MODE: 'false', WPP_CONNECT_URL: `http://127.0.0.1:${wpp.address().port}`,
      WPP_CONNECT_SESSION: 'major', WPP_CONNECT_TOKEN: 'test-token', SECRET_KEY: 'test-secret'
    },
    stdio: 'ignore'
  });
  const request = (url, options) => fetch(`http://127.0.0.1:${port}${url}`, options);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { ready = (await request('/api/health')).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const registration = await request('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Teste', email: 'qr@example.com', password: 'test-password-123' })
    });
    assert.equal(registration.status, 202);
    // Sem o Telegram configurado em teste, aprova o cadastro pendente diretamente no banco (equivalente a aceitar pelo bot).
    const adminStore = createCampaignStore(databasePath);
    adminStore.approvePendingRegistration(adminStore.findPendingByEmail('qr@example.com').id);
    adminStore.close();
    const login = await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'qr@example.com', password: 'test-password-123' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const number = await request('/api/wpp-numbers', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ label: 'Principal', session: 'major' })
    });
    assert.equal(number.status, 201);
    const session = (await number.json()).numbers[0].session;
    const connect = await request('/api/integrations/wppconnect/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ session })
    });
    assert.equal(connect.status, 200);
    assert.equal((await connect.json()).status, 'QRCODE');
    const qr = await request(`/api/integrations/wppconnect/qr?session=${encodeURIComponent(session)}`, { headers: { Cookie: cookie } });
    assert.equal(qr.status, 200);
    assert.equal((await qr.json()).qrCode, `data:image/png;base64,${image.toString('base64')}`);
    rejectCurrentToken = true;
    const status = await request(`/api/integrations/wppconnect/status?session=${encodeURIComponent(session)}`, { headers: { Cookie: cookie } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).connected, true);
    sessionStatus = 'notLogged';
    const disconnected = await request(`/api/integrations/wppconnect/status?session=${encodeURIComponent(session)}`, { headers: { Cookie: cookie } });
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).connected, false);
    assert.equal((await request('/api/integrations/wppconnect/qr?session=other', { headers: { Cookie: cookie } })).status, 422);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    await new Promise((resolve) => wpp.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
