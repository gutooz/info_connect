const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { createCampaignStore } = require('./storage');

test('persiste campanhas depois de fechar e reabrir o banco', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-'));
  const databasePath = path.join(directory, 'campaigns.sqlite');
  const campaign = {
    id: 'campaign-1',
    ownerUserId: 'u1',
    name: 'Campanha persistida',
    status: 'sending',
    statusLabel: 'Enviando',
    sent: 1,
    audience: 2,
    recipients: [{ name: 'Ana', phone: '5511999999999' }],
    channels: { whatsapp: { type: 'text', message: 'Olá {{nome}}', media: null } },
    createdAt: 'Agora'
  };

  const firstStore = createCampaignStore(databasePath);
  firstStore.createUser({ id: 'u1', name: 'Ana', email: 'ana@example.com', passwordHash: 'hash' });
  firstStore.save(campaign);
  firstStore.close();

  const secondStore = createCampaignStore(databasePath);
  assert.deepEqual(secondStore.list('u1'), [campaign]);
  secondStore.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('persiste usuários, sessões e contatos sem duplicar telefones', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-'));
  const databasePath = path.join(directory, 'data.sqlite');
  const first = createCampaignStore(databasePath);
  assert.equal(first.hasUsers(), false);
  first.createUser({ id: 'u1', name: 'Ana', email: 'ana@example.com', passwordHash: 'hash' }, true);
  assert.equal(first.createUser({ id: 'u2', name: 'Bia', email: 'bia@example.com', passwordHash: 'hash' }, true), null);
  first.saveSession('token-hash', 'u1', Date.now() + 10000);
  first.saveContacts('u1', [{ id: 'c1', name: 'Contato', phone: '5511999999999' }]);
  first.saveContacts('u1', [{ id: 'c2', name: 'Contato atualizado', phone: '5511999999999' }]);
  first.close();

  const second = createCampaignStore(databasePath);
  assert.equal(second.findUserByEmail('ana@example.com').name, 'Ana');
  assert.equal(second.findSession('token-hash').id, 'u1');
  assert.deepEqual(second.listContacts('u1'), [{ id: 'c1', name: 'Contato atualizado', phone: '5511999999999', region: 'Brasil', wppNumberId: null }]);
  second.deleteSession('token-hash');
  assert.equal(second.findSession('token-hash'), undefined);
  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('divide contatos importados entre os números do WhatsApp cadastrados', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-'));
  const databasePath = path.join(directory, 'wpp-numbers.sqlite');
  const store = createCampaignStore(databasePath);
  store.createUser({ id: 'u1', name: 'Ana', email: 'ana@example.com', passwordHash: 'hash' });

  store.addWppNumber('u1', { id: 'n1', sessionKey: 'vendas-1', label: 'Vendas 1' });
  store.addWppNumber('u1', { id: 'n2', sessionKey: 'vendas-2', label: 'Vendas 2' });

  const phones = ['5511900000001', '5511900000002', '5511900000003', '5511900000004'];
  store.saveContacts('u1', phones.map((phone, index) => ({ id: `c${index}`, name: `Contato ${index}`, phone })));
  store.assignContactsRoundRobin('u1', phones);

  const contacts = store.listContacts('u1');
  assert.deepEqual(contacts.map((contact) => contact.wppNumberId), ['n1', 'n2', 'n1', 'n2']);

  const numbers = store.listWppNumbers('u1');
  assert.deepEqual(numbers.map((number) => number.contactCount), [2, 2]);

  store.removeWppNumber('u1', 'n1');
  assert.equal(store.listContacts('u1').find((contact) => contact.phone === phones[0]).wppNumberId, null);

  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('aprova ou recusa cadastros pendentes de aprovação', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-pending-'));
  const databasePath = path.join(directory, 'pending.sqlite');
  const store = createCampaignStore(databasePath);
  store.createUser({ id: 'admin', name: 'Admin', email: 'admin@example.com', passwordHash: 'hash' }, true);

  store.createPendingRegistration({ id: 'p1', name: 'Bia', email: 'bia@example.com', passwordHash: 'hash', requestedBy: 'admin' });
  assert.equal(store.findPendingByEmail('bia@example.com').id, 'p1');
  assert.equal(store.findUserByEmail('bia@example.com'), undefined);

  store.approvePendingRegistration('p1');
  assert.equal(store.findUserByEmail('bia@example.com').name, 'Bia');
  assert.equal(store.findPendingRegistration('p1'), undefined);

  store.createPendingRegistration({ id: 'p2', name: 'Caio', email: 'caio@example.com', passwordHash: 'hash', requestedBy: 'admin' });
  store.deletePendingRegistration('p2');
  assert.equal(store.findPendingRegistration('p2'), undefined);
  assert.equal(store.findUserByEmail('caio@example.com'), undefined);

  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('migra dados globais para o primeiro usuário sem compartilhá-los', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'major-neto-migration-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, password_hash TEXT, created_at TEXT);
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT, updated_at TEXT);
    CREATE TABLE wpp_numbers (id TEXT PRIMARY KEY, session TEXT UNIQUE, label TEXT, created_at TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, phone TEXT UNIQUE, wpp_number_id TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO users VALUES ('u1', 'Ana', 'ana@example.com', 'hash', '2026-01-01');
    INSERT INTO users VALUES ('u2', 'Bia', 'bia@example.com', 'hash', '2026-01-02');
    INSERT INTO campaigns VALUES ('campaign-1', '{"id":"campaign-1","name":"Antiga"}', '2026-01-01', '2026-01-01');
    INSERT INTO wpp_numbers VALUES ('n1', 'major', 'Principal', '2026-01-01');
    INSERT INTO contacts VALUES ('c1', 'Cliente', '5511999999999', 'n1', '2026-01-01', '2026-01-01');
  `);
  db.close();

  const store = createCampaignStore(databasePath);
  assert.equal(store.list('u1').length, 1);
  assert.deepEqual(store.list('u2'), []);
  assert.equal(store.listContacts('u1')[0].wppNumberId, 'n1');
  assert.deepEqual(store.listContacts('u2'), []);
  assert.equal(store.listWppNumbers('u1')[0].session, 'major');
  assert.deepEqual(store.listWppNumbers('u2'), []);
  store.saveContacts('u2', [{ id: 'c2', name: 'Outro cliente', phone: '5511999999999' }]);
  assert.equal(store.listContacts('u1')[0].name, 'Cliente');
  assert.equal(store.listContacts('u2')[0].name, 'Outro cliente');
  store.close();
  const reopened = createCampaignStore(databasePath);
  assert.equal(reopened.list('u1').length, 1);
  reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
