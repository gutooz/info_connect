const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createCampaignStore } = require('./storage');

function approvePendingByEmail(databasePath, email) {
  const store = createCampaignStore(databasePath);
  const pending = store.findPendingByEmail(email);
  store.approvePendingRegistration(pending.id);
  store.close();
}

test('webhook do WPPConnect atualiza entrega e resposta, refletidas no dashboard por número', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-tracking-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const databasePath = path.join(directory, 'test.sqlite');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: databasePath, NODE_ENV: 'test', DEMO_MODE: 'true', WPP_WEBHOOK_SECRET: 'test-secret' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options) => fetch(`${base}${url}`, options);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { ready = (await request('/api/health')).ok; } catch { /* still starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const health = await request('/api/health');
    assert.equal(health.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal(health.headers.get('x-xss-protection'), '0');

    await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: 'correct-password' }) });
    approvePendingByEmail(databasePath, 'ana@example.com');
    const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const numberResponse = await request('/api/wpp-numbers', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ label: 'Principal', session: 'major' }) });
    assert.equal(numberResponse.status, 201);
    const number = (await numberResponse.json()).numbers[0];

    const startAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const campaignResponse = await request('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Campanha rastreada',
        type: 'text',
        messages: ['Olá {{nome}}'],
        recipients: [{ name: 'Cliente', phone: '5511999999999' }],
        numberIds: [number.id],
        startAt,
        dailyStartTime: '08:00',
        dailyEndTime: '20:00',
        messageIntervalValue: '30',
        messageIntervalUnit: 'seconds'
      })
    });
    assert.equal(campaignResponse.status, 201);
    const campaign = await campaignResponse.json();

    const launch = await request(`/api/campaigns/${campaign.id}/launch`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(launch.status, 200);
    let sentRecipient = null;
    for (let attempt = 0; attempt < 50 && !sentRecipient; attempt += 1) {
      const current = await (await request(`/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } })).json();
      sentRecipient = current.recipients.find((recipient) => recipient.sentAt);
      if (!sentRecipient) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(sentRecipient);
    assert.ok(sentRecipient.messageId);

    const wrongSecret = await request('/api/integrations/wppconnect/webhook?secret=wrong', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: number.session, event: 'onack', id: sentRecipient.messageId, ack: 2 })
    });
    assert.equal(wrongSecret.status, 401);

    const ackResponse = await request('/api/integrations/wppconnect/webhook?secret=test-secret', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: number.session, event: 'onack', id: sentRecipient.messageId, ack: 2 })
    });
    assert.equal(ackResponse.status, 200);
    const afterAck = await (await request(`/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } })).json();
    assert.ok(afterAck.recipients[0].deliveredAt, JSON.stringify(afterAck.recipients[0]));

    const replyResponse = await request('/api/integrations/wppconnect/webhook?secret=test-secret', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: number.session, event: 'onmessage', from: '5511999999999@c.us', fromMe: false, body: 'Recebi, obrigado!' })
    });
    assert.equal(replyResponse.status, 200);

    const detail = await (await request(`/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } })).json();
    assert.equal(detail.recipients.length, 1);
    assert.equal(detail.recipients[0].status, 'replied');
    assert.ok(detail.recipients[0].deliveredAt);
    assert.ok(detail.recipients[0].repliedAt);
    assert.equal(detail.recipients[0].replyText, 'Recebi, obrigado!');

    const dashboard = await (await request('/api/dashboard/campaign-numbers', { headers: { Cookie: cookie } })).json();
    const row = dashboard.find((item) => item.campaignId === campaign.id);
    assert.ok(row);
    assert.equal(row.numberLabel, 'Principal');
    assert.equal(row.campaignSent, 1);
    assert.equal(row.campaignAudience, 1);
    assert.equal(row.campaignStatus, 'completed');
    assert.equal(row.sentCount, 1);
    assert.equal(row.deliveredCount, 1);
    assert.equal(row.repliedCount, 1);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('falha de envio fica registrada no destinatário da campanha', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-send-failure-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const databasePath = path.join(directory, 'test.sqlite');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      NODE_ENV: 'test',
      APP_TIMEZONE: 'UTC',
      TZ: 'UTC',
      DEMO_MODE: 'false',
      WPP_CONNECT_URL: '',
      WPP_CONNECT_TOKEN: ''
    },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options) => fetch(`${base}${url}`, options);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { ready = (await request('/api/health')).ok; } catch { /* still starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);

    await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: 'correct-password' }) });
    approvePendingByEmail(databasePath, 'ana@example.com');
    const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const numberResponse = await request('/api/wpp-numbers', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ label: 'Principal', session: 'major' }) });
    const number = (await numberResponse.json()).numbers[0];

    const now = new Date();
    const startMinutes = now.getHours() * 60 + now.getMinutes();
    const dailyStartTime = `${String(Math.max(0, Math.floor(startMinutes / 60) - 1)).padStart(2, '0')}:00`;
    const dailyEndTime = '23:59';
    const campaignResponse = await request('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Campanha com falha',
        type: 'text',
        messages: ['Olá'],
        recipients: [{ name: 'Cliente', phone: '5511999999999' }],
        numberIds: [number.id],
        startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        dailyStartTime,
        dailyEndTime,
        messageIntervalValue: '30',
        messageIntervalUnit: 'seconds'
      })
    });
    assert.equal(campaignResponse.status, 201);
    const campaign = await campaignResponse.json();
    const launch = await request(`/api/campaigns/${campaign.id}/launch`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(launch.status, 200);

    let detail = { recipients: [] };
    for (let attempt = 0; attempt < 20 && detail.recipients.length === 0; attempt += 1) {
      detail = await (await request(`/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } })).json();
      if (detail.recipients.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(detail.recipients.length, 1);
    assert.equal(detail.recipients[0].status, 'failed');
    assert.match(detail.recipients[0].error, /não está configurado/i);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('campanha atrasada dispara mesmo fora da antiga janela diária', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-daily-window-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const databasePath = path.join(directory, 'test.sqlite');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: databasePath, NODE_ENV: 'test', DEMO_MODE: 'true' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options) => fetch(`${base}${url}`, options);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { ready = (await request('/api/health')).ok; } catch { /* still starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);

    await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: 'correct-password' }) });
    approvePendingByEmail(databasePath, 'ana@example.com');
    const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const numberResponse = await request('/api/wpp-numbers', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ label: 'Principal', session: 'major' }) });
    const number = (await numberResponse.json()).numbers[0];

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [dailyStartTime, dailyEndTime] = currentMinutes < 12 * 60 ? ['13:00', '14:00'] : ['00:00', '01:00'];
    const campaignResponse = await request('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Campanha fora da janela',
        type: 'text',
        messages: ['Olá'],
        recipients: [{ name: 'Cliente', phone: '5511999999999' }],
        numberIds: [number.id],
        startAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        dailyStartTime,
        dailyEndTime,
        messageIntervalValue: '30',
        messageIntervalUnit: 'seconds'
      })
    });
    assert.equal(campaignResponse.status, 201);
    const campaign = await campaignResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 750));

    const detail = await (await request(`/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } })).json();
    assert.equal(detail.recipients.length, 1);
    assert.equal(detail.recipients[0].status, 'sent');
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
