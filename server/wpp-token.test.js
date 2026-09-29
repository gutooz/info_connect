const assert = require('node:assert/strict');
const test = require('node:test');
const { createWppTokenProvider } = require('./wpp-token');

test('usa o token existente para a sessão principal e gera um por sessão adicional', async () => {
  const calls = [];
  const tokenFor = createWppTokenProvider({
    baseUrl: 'http://wppconnect:21465/',
    secretKey: 'private-secret',
    defaultSession: 'major',
    defaultToken: 'existing-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return { ok: true, json: async () => ({ token: 'second-token' }) };
    }
  });
  assert.equal(await tokenFor('major'), 'existing-token');
  assert.equal(await tokenFor('vendas-2'), 'second-token');
  assert.equal(await tokenFor('vendas-2'), 'second-token');
  assert.deepEqual(calls, [{ url: 'http://wppconnect:21465/api/vendas-2/private-secret/generate-token', method: 'POST' }]);
  await assert.rejects(() => tokenFor('../invalid'), /inválida/);
});
