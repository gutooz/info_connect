const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createCampaignStore } = require('./storage');

// Sem o Telegram configurado em teste, aprova o cadastro pendente diretamente no banco (equivalente a aceitar pelo bot).
function approvePendingByEmail(databasePath, email) {
  const store = createCampaignStore(databasePath);
  const pending = store.findPendingByEmail(email);
  store.approvePendingRegistration(pending.id);
  store.close();
}

test('cadastro inicial, login e contatos persistidos', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-api-'));
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
    assert.equal((await request('/api/contacts')).status, 401);
    const registration = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: 'correct-password' }) });
    assert.equal(registration.status, 202);
    assert.equal((await registration.json()).pending, true);
    assert.equal((await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' }) })).status, 403);
    approvePendingByEmail(databasePath, 'ana@example.com');
    const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const contact = await request('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'Cliente', phone: '5511999999999' }) });
    assert.equal(contact.status, 201);
    assert.equal((await contact.json()).contacts.length, 1);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logout.status, 200);
    assert.equal((await request('/api/contacts', { headers: { Cookie: cookie } })).status, 401);
    const relogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ana@example.com', password: 'correct-password' }) });
    assert.equal(relogin.status, 200);
    const newCookie = relogin.headers.get('set-cookie').split(';')[0];
    const contacts = await request('/api/contacts', { headers: { Cookie: newCookie } });
    assert.deepEqual((await contacts.json()).map((item) => item.phone), ['5511999999999']);

    const numberResponse = await request('/api/wpp-numbers', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newCookie }, body: JSON.stringify({ label: 'Principal', session: 'major' }) });
    assert.equal(numberResponse.status, 201);
    const firstNumber = (await numberResponse.json()).numbers[0];
    const numberId = firstNumber.id;
    const startAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const dailyStartTime = '00:00';
    const dailyEndTime = '23:59';
    const campaignResponse = await request('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newCookie }, body: JSON.stringify({ name: 'Teste', type: 'text', messages: ['Olá {{nome}}'], recipients: [{ name: 'Cliente', phone: '5511999999999' }, { name: 'Outro', phone: '5511888888888' }], numberIds: [numberId], startAt, dailyStartTime, dailyEndTime, messageIntervalValue: '2', messageIntervalUnit: 'minutes' }) });
    assert.equal(campaignResponse.status, 201);
    const campaign = await campaignResponse.json();
    assert.equal(campaign.status, 'scheduled');
    const saved = await request('/api/campaigns', { headers: { Cookie: newCookie } });
    assert.equal((await saved.json())[0].delayMs, 120000);
    const invalidInterval = await request('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newCookie }, body: JSON.stringify({ name: 'Intervalo inválido', type: 'text', messages: ['Teste'], recipients: [{ phone: '5511999999999' }, { phone: '5511888888888' }], numberIds: [numberId], startAt, dailyStartTime, dailyEndTime, messageIntervalValue: '61', messageIntervalUnit: 'minutes' }) });
    assert.equal(invalidInterval.status, 422);

    const secondUser = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newCookie }, body: JSON.stringify({ name: 'Bia', email: 'bia@example.com', password: 'second-password-123' }) });
    assert.equal(secondUser.status, 202);
    assert.equal((await secondUser.json()).pending, true);
    approvePendingByEmail(databasePath, 'bia@example.com');
    const secondLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bia@example.com', password: 'second-password-123' }) });
    assert.equal(secondLogin.status, 200);
    const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await (await request('/api/contacts', { headers: { Cookie: secondCookie } })).json(), []);
    assert.deepEqual(await (await request('/api/wpp-numbers', { headers: { Cookie: secondCookie } })).json(), []);
    assert.deepEqual(await (await request('/api/campaigns', { headers: { Cookie: secondCookie } })).json(), []);
    const samePhone = await request('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: secondCookie }, body: JSON.stringify({ name: 'Contato da Bia', phone: '5511999999999' }) });
    assert.equal(samePhone.status, 201);
    assert.equal((await (await request('/api/contacts', { headers: { Cookie: newCookie } })).json())[0].name, 'Cliente');
    const secondNumberResponse = await request('/api/wpp-numbers', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: secondCookie }, body: JSON.stringify({ label: 'Principal', session: 'major' }) });
    assert.equal(secondNumberResponse.status, 201);
    const secondNumber = (await secondNumberResponse.json()).numbers[0];
    assert.notEqual(secondNumber.session, firstNumber.session);
    assert.equal((await request('/api/integrations/wppconnect/qr?session=' + encodeURIComponent(firstNumber.session), { headers: { Cookie: secondCookie } })).status, 422);
    assert.equal((await request('/api/integrations/wppconnect/contacts?session=' + encodeURIComponent(firstNumber.session), { headers: { Cookie: secondCookie } })).status, 422);
    assert.equal((await request(`/api/campaigns/${campaign.id}/launch`, { method: 'POST', headers: { Cookie: secondCookie } })).status, 404);
    const foreignNumber = await request('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: secondCookie }, body: JSON.stringify({ name: 'Indevida', type: 'text', messages: ['Teste'], recipients: [{ phone: '5511999999999' }], numberIds: [numberId], startAt, dailyStartTime, dailyEndTime }) });
    assert.equal(foreignNumber.status, 422);
    await request(`/api/wpp-numbers/${numberId}`, { method: 'DELETE', headers: { Cookie: secondCookie } });
    assert.equal((await (await request('/api/wpp-numbers', { headers: { Cookie: newCookie } })).json()).length, 1);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
