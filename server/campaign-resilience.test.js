const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createCampaignStore } = require('./storage');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function approvePendingByEmail(databasePath, email) {
  const store = createCampaignStore(databasePath);
  const pending = store.findPendingByEmail(email);
  store.approvePendingRegistration(pending.id);
  store.close();
}

test('número inexistente falha individualmente e a campanha continua no próximo contato', async () => {
  const sentPhones = [];
  const wppServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/generate-token')) {
      res.end(JSON.stringify({ token: 'test-token' }));
      return;
    }
    if (req.url.endsWith('/send-message')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sentPhones.push(body.phone);
      if (body.phone === '1111111111') {
        res.statusCode = 400;
        res.end(JSON.stringify({ response: null, status: 'Connected', message: 'O número 1111111111 não existe.' }));
        return;
      }
      res.end(JSON.stringify({ response: { id: `message-${body.phone}` } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => wppServer.listen(0, '127.0.0.1', resolve));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-resilience-'));
  const port = await freePort();
  const databasePath = path.join(directory, 'test.sqlite');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: {
      ...process.env,
      APP_TIMEZONE: 'UTC',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      WPP_CONNECT_URL: `http://127.0.0.1:${wppServer.address().port}`,
      WPP_CONNECT_TOKEN: '',
      WPP_CONNECT_SESSION: '',
      SECRET_KEY: 'test-secret'
    },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options) => fetch(`${base}${url}`, options);

  try {
    assert.ok(await waitUntil(async () => {
      try { return (await request('/api/health')).ok; } catch { return false; }
    }));

    await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: 'correct-password' })
    });
    approvePendingByEmail(databasePath, 'ana@example.com');
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const numberResponse = await request('/api/wpp-numbers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ label: 'Principal', session: 'principal' })
    });
    const number = (await numberResponse.json()).numbers[0];
    const campaignResponse = await request('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Campanha resiliente',
        type: 'text',
        messages: ['Olá'],
        recipients: [
          { name: 'Inexistente', phone: '1111111111' },
          { name: 'Válido', phone: '5511999999999' }
        ],
        numberIds: [number.id],
        startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        dailyStartTime: '00:00',
        dailyEndTime: '23:59',
        messageIntervalValue: '1',
        messageIntervalUnit: 'seconds'
      })
    });
    const campaign = await campaignResponse.json();
    await request(`/api/campaigns/${campaign.id}/launch`, { method: 'POST', headers: { Cookie: cookie } });

    const completed = await waitUntil(async () => {
      const response = await request(`/api/campaigns/${campaign.id}`, { headers: { Cookie: cookie } });
      const detail = await response.json();
      return detail.status === 'completed' ? detail : null;
    });
    assert.ok(completed, 'a campanha deveria concluir depois de pular o número inexistente');

    const recipients = await (await request(`/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } })).json();
    assert.equal(recipients.recipients.length, 2);
    assert.equal(recipients.recipients.filter((recipient) => recipient.status === 'failed').length, 1);
    assert.equal(recipients.recipients.filter((recipient) => recipient.status === 'sent').length, 1);
    assert.deepEqual(sentPhones, ['1111111111', '5511999999999']);
    assert.equal(completed.sent, 1);
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    });
    await new Promise((resolve) => wppServer.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('retoma campanha antiga no contato seguinte sem reenviar os anteriores', async () => {
  const sentPhones = [];
  const wppServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/generate-token')) {
      res.end(JSON.stringify({ token: 'test-token' }));
      return;
    }
    if (req.url.endsWith('/send-message')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sentPhones.push(body.phone);
      res.end(JSON.stringify({ response: { id: `message-${body.phone}` } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => wppServer.listen(0, '127.0.0.1', resolve));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-resume-'));
  const port = await freePort();
  const databasePath = path.join(directory, 'test.sqlite');
  const appEnv = {
    ...process.env,
    APP_TIMEZONE: 'UTC',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_PATH: databasePath,
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    WPP_CONNECT_URL: `http://127.0.0.1:${wppServer.address().port}`,
    WPP_CONNECT_TOKEN: '',
    WPP_CONNECT_SESSION: '',
    SECRET_KEY: 'test-secret'
  };
  let child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env: appEnv, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options) => fetch(`${base}${url}`, options);

  try {
    assert.ok(await waitUntil(async () => {
      try { return (await request('/api/health')).ok; } catch { return false; }
    }));
    await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: 'correct-password' })
    });
    approvePendingByEmail(databasePath, 'ana@example.com');
    let login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' })
    });
    let cookie = login.headers.get('set-cookie').split(';')[0];
    const ownerId = (await login.json()).user.id;
    const numberResponse = await request('/api/wpp-numbers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ label: 'Principal', session: 'principal' })
    });
    const number = (await numberResponse.json()).numbers[0];
    const campaignResponse = await request('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Campanha interrompida',
        type: 'text',
        messages: ['Olá'],
        recipients: [
          { name: 'Inexistente', phone: '1111111111' },
          { name: 'Próximo', phone: '5511999999999' }
        ],
        numberIds: [number.id],
        startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        dailyStartTime: '00:00',
        dailyEndTime: '23:59',
        messageIntervalValue: '1',
        messageIntervalUnit: 'seconds'
      })
    });
    const campaignId = (await campaignResponse.json()).id;

    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
    const store = createCampaignStore(databasePath);
    const campaign = store.listAll().find((item) => item.id === campaignId);
    campaign.status = 'error';
    campaign.statusLabel = 'Falhou';
    campaign.error = 'WPPConnect respondeu 400: {"message":"O número 1111111111 não existe."}';
    campaign.lanes = [{ numberId: number.id, nextIndex: 0, nextSendAt: Date.now(), done: false, sentSinceBreak: 7 }];
    campaign.sent = 7;
    store.save(campaign);
    store.createRecipient({ id: 'failed-recipient', campaignId, ownerId, wppNumberId: number.id, phone: '1111111111', name: 'Inexistente' });
    store.markRecipientFailed('failed-recipient', campaign.error);
    store.close();

    child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env: appEnv, stdio: 'ignore' });
    assert.ok(await waitUntil(async () => {
      try { return (await request('/api/health')).ok; } catch { return false; }
    }));
    login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' })
    });
    cookie = login.headers.get('set-cookie').split(';')[0];
    const resume = await request(`/api/campaigns/${campaignId}/resume`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(resume.status, 200);
    assert.equal((await resume.json()).skipped, 1);

    const completed = await waitUntil(async () => {
      const response = await request(`/api/campaigns/${campaignId}`, { headers: { Cookie: cookie } });
      const detail = await response.json();
      return detail.status === 'completed' ? detail : null;
    });
    assert.ok(completed);
    assert.equal(completed.sent, 8);
    assert.deepEqual(sentPhones, ['5511999999999']);
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    });
    await new Promise((resolve) => wppServer.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
