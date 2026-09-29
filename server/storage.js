const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createCampaignStore(databasePath) {
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new Database(path.resolve(databasePath));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pending_registrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
      password_hash TEXT NOT NULL, requested_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS campaign_recipients (id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      wpp_number_id TEXT REFERENCES wpp_numbers(id) ON DELETE SET NULL,
      phone TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', sent_at TEXT, delivered_at TEXT, read_at TEXT,
      replied_at TEXT, reply_text TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS campaign_recipients_campaign ON campaign_recipients(campaign_id);
    CREATE INDEX IF NOT EXISTS campaign_recipients_message ON campaign_recipients(message_id);
    CREATE INDEX IF NOT EXISTS campaign_recipients_lookup ON campaign_recipients(owner_user_id, wpp_number_id, phone);
  `);

  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const columns = (name) => db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
  const schema = `
    CREATE TABLE campaigns_v2 (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id),
      payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE wpp_numbers_v2 (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id),
      session_key TEXT NOT NULL, session TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_user_id, session_key), UNIQUE(id, owner_user_id));
    CREATE TABLE contacts_v2 (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, phone TEXT NOT NULL, region TEXT NOT NULL DEFAULT 'Brasil', wpp_number_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_user_id, phone),
      FOREIGN KEY(wpp_number_id, owner_user_id) REFERENCES wpp_numbers_v2(id, owner_user_id));
  `;
  if (tableExists('campaigns') && !columns('campaigns').includes('owner_user_id')) {
    const owner = db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get()?.id;
    const existing = ['campaigns', 'contacts', 'wpp_numbers'].reduce((sum, table) => sum + (tableExists(table) ? db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count : 0), 0);
    if (existing && !owner) throw new Error('A migracao de dados antigos exige um usuario cadastrado.');
    db.transaction(() => {
      db.exec(schema);
      db.prepare('INSERT INTO campaigns_v2 (id, owner_user_id, payload, created_at, updated_at) SELECT id, ?, payload, created_at, updated_at FROM campaigns').run(owner);
      if (tableExists('wpp_numbers')) db.prepare('INSERT INTO wpp_numbers_v2 (id, owner_user_id, session_key, session, label, created_at) SELECT id, ?, session, session, label, created_at FROM wpp_numbers').run(owner);
      if (tableExists('contacts')) {
        const numberColumn = columns('contacts').includes('wpp_number_id') ? 'wpp_number_id' : 'NULL';
        db.prepare(`INSERT INTO contacts_v2 (id, owner_user_id, name, phone, wpp_number_id, created_at, updated_at) SELECT id, ?, name, phone, ${numberColumn}, created_at, updated_at FROM contacts`).run(owner);
      }
      db.exec(`
        DROP TABLE IF EXISTS contacts; DROP TABLE IF EXISTS wpp_numbers; DROP TABLE campaigns;
        ALTER TABLE campaigns_v2 RENAME TO campaigns;
        ALTER TABLE wpp_numbers_v2 RENAME TO wpp_numbers;
        ALTER TABLE contacts_v2 RENAME TO contacts;
      `);
    })();
  } else if (!tableExists('campaigns')) {
    db.exec(schema);
    db.exec(`ALTER TABLE campaigns_v2 RENAME TO campaigns;
      ALTER TABLE wpp_numbers_v2 RENAME TO wpp_numbers;
      ALTER TABLE contacts_v2 RENAME TO contacts;`);
  }
  if (tableExists('contacts') && !columns('contacts').includes('region')) {
    db.exec("ALTER TABLE contacts ADD COLUMN region TEXT NOT NULL DEFAULT 'Brasil'");
  }
  db.pragma('foreign_keys = ON');
  if (db.pragma('foreign_key_check').length) throw new Error('Falha de integridade apos migracao.');
  db.exec(`CREATE INDEX IF NOT EXISTS campaigns_owner_created ON campaigns(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS contacts_owner ON contacts(owner_user_id);
    CREATE INDEX IF NOT EXISTS wpp_numbers_owner ON wpp_numbers(owner_user_id);`);

  const campaignRows = (rows) => rows.map((row) => ({ ...JSON.parse(row.payload), ownerUserId: row.owner_user_id }));
  return {
    hasUsers() { return Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get()); },
    createUser(user, firstOnly = false) {
      return db.transaction(() => {
        if (firstOnly && db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
        db.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)').run(user.id, user.name, user.email, user.passwordHash);
        return { id: user.id, name: user.name, email: user.email };
      })();
    },
    findUserByEmail(email) { return db.prepare('SELECT id, name, email, password_hash AS passwordHash FROM users WHERE email = ?').get(email); },
    createPendingRegistration({ id, name, email, passwordHash, requestedBy }) {
      db.prepare('INSERT INTO pending_registrations (id, name, email, password_hash, requested_by) VALUES (?, ?, ?, ?, ?)').run(id, name, email, passwordHash, requestedBy || null);
    },
    findPendingByEmail(email) { return db.prepare('SELECT id, password_hash AS passwordHash FROM pending_registrations WHERE email = ?').get(email); },
    findPendingRegistration(id) {
      return db.prepare('SELECT id, name, email, password_hash AS passwordHash, requested_by AS requestedBy FROM pending_registrations WHERE id = ?').get(id);
    },
    deletePendingRegistration(id) { db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(id); },
    approvePendingRegistration(id) {
      return db.transaction(() => {
        const pending = this.findPendingRegistration(id);
        if (!pending) return null;
        db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(id);
        db.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)').run(pending.id, pending.name, pending.email, pending.passwordHash);
        return { id: pending.id, name: pending.name, email: pending.email };
      })();
    },
    saveSession(tokenHash, userId, expiresAt) { db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt); },
    findSession(tokenHash) {
      return db.prepare(`SELECT users.id, users.name, users.email FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(tokenHash, Date.now());
    },
    deleteSession(tokenHash) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); },
    listContacts(ownerId) {
      return db.prepare('SELECT id, name, phone, region, wpp_number_id AS wppNumberId FROM contacts WHERE owner_user_id = ? ORDER BY name COLLATE NOCASE, phone').all(ownerId);
    },
    saveContacts(ownerId, contacts) {
      const insert = db.prepare(`INSERT INTO contacts (id, owner_user_id, name, phone, region) VALUES (@id, @ownerId, @name, @phone, @region)
        ON CONFLICT(owner_user_id, phone) DO UPDATE SET name = excluded.name, region = excluded.region, updated_at = datetime('now')`);
      db.transaction((items) => items.forEach((contact) => insert.run({ ...contact, ownerId, region: contact.region || 'Brasil' })))(contacts);
      return this.listContacts(ownerId);
    },
    listWppNumbers(ownerId) {
      return db.prepare(`SELECT wpp_numbers.id, wpp_numbers.session, wpp_numbers.session_key AS sessionKey, wpp_numbers.label,
        (SELECT COUNT(*) FROM contacts WHERE contacts.wpp_number_id = wpp_numbers.id AND contacts.owner_user_id = wpp_numbers.owner_user_id) AS contactCount
        FROM wpp_numbers WHERE wpp_numbers.owner_user_id = ? ORDER BY created_at, rowid`).all(ownerId);
    },
    findWppNumberBySession(ownerId, session) { return db.prepare('SELECT id FROM wpp_numbers WHERE owner_user_id = ? AND session = ?').get(ownerId, session); },
    addWppNumber(ownerId, { id, sessionKey, label }) {
      const key = String(sessionKey || '').trim();
      if (!/^[a-zA-Z0-9_-]{1,26}$/.test(key)) throw new Error('A sessao precisa ter ate 26 caracteres, sem espacos ou acentos.');
      const session = `u${ownerId.replace(/-/g, '')}-${key}`;
      db.prepare('INSERT INTO wpp_numbers (id, owner_user_id, session_key, session, label) VALUES (?, ?, ?, ?, ?)').run(id, ownerId, key, session, label);
      return this.listWppNumbers(ownerId);
    },
    removeWppNumber(ownerId, id) {
      db.transaction(() => {
        db.prepare('UPDATE contacts SET wpp_number_id = NULL WHERE owner_user_id = ? AND wpp_number_id = ?').run(ownerId, id);
        db.prepare('DELETE FROM wpp_numbers WHERE owner_user_id = ? AND id = ?').run(ownerId, id);
      })();
      return this.listWppNumbers(ownerId);
    },
    assignContactsRoundRobin(ownerId, phones) {
      const numbers = db.prepare('SELECT id FROM wpp_numbers WHERE owner_user_id = ? ORDER BY created_at, rowid').all(ownerId);
      if (!numbers.length || !phones.length) return this.listWppNumbers(ownerId);
      const assign = db.prepare("UPDATE contacts SET wpp_number_id = ?, updated_at = datetime('now') WHERE owner_user_id = ? AND phone = ?");
      db.transaction((items) => items.forEach((phone, index) => assign.run(numbers[index % numbers.length].id, ownerId, phone)))(phones);
      return this.listWppNumbers(ownerId);
    },
    assignContactToLeastLoadedNumber(ownerId, phone) {
      const target = db.prepare(`SELECT wpp_numbers.id FROM wpp_numbers
        LEFT JOIN contacts ON contacts.wpp_number_id = wpp_numbers.id AND contacts.owner_user_id = wpp_numbers.owner_user_id
        WHERE wpp_numbers.owner_user_id = ? GROUP BY wpp_numbers.id
        ORDER BY COUNT(contacts.id) ASC, wpp_numbers.created_at ASC, wpp_numbers.rowid ASC LIMIT 1`).get(ownerId);
      if (target) db.prepare("UPDATE contacts SET wpp_number_id = ?, updated_at = datetime('now') WHERE owner_user_id = ? AND phone = ?").run(target.id, ownerId, phone);
    },
    list(ownerId) { return campaignRows(db.prepare('SELECT owner_user_id, payload FROM campaigns WHERE owner_user_id = ? ORDER BY created_at DESC, rowid DESC').all(ownerId)); },
    listAll() { return campaignRows(db.prepare('SELECT owner_user_id, payload FROM campaigns ORDER BY created_at DESC, rowid DESC').all()); },
    save(campaign) {
      if (!campaign?.id || !campaign.ownerUserId) throw new Error('Campanha sem dono nao pode ser persistida.');
      const result = db.prepare(`INSERT INTO campaigns (id, owner_user_id, payload, updated_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        WHERE campaigns.owner_user_id = excluded.owner_user_id`).run(String(campaign.id), campaign.ownerUserId, JSON.stringify(campaign));
      if (!result.changes) throw new Error('Campanha pertence a outro usuario.');
    },
    findNumberBySession(session) {
      return db.prepare(`SELECT id, owner_user_id AS ownerUserId, label, session, session_key AS sessionKey
        FROM wpp_numbers WHERE session = ?`).get(session);
    },
    createRecipient({ id, campaignId, ownerId, wppNumberId, phone, name }) {
      db.prepare(`INSERT INTO campaign_recipients (id, campaign_id, owner_user_id, wpp_number_id, phone, name, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(id, campaignId, ownerId, wppNumberId || null, phone, String(name || '').slice(0, 80));
    },
    markRecipientSent(id, { messageId, sentAt }) {
      db.prepare(`UPDATE campaign_recipients SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?`).run(messageId || null, sentAt, id);
    },
    markRecipientFailed(id, error) {
      db.prepare(`UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?`).run(String(error || '').slice(0, 300), id);
    },
    recordAckByMessageId(messageId, ack, at) {
      const row = db.prepare(`SELECT id, delivered_at AS deliveredAt, read_at AS readAt FROM campaign_recipients WHERE message_id = ?`).get(messageId);
      if (!row) return null;
      const deliveredAt = row.deliveredAt || (ack >= 2 ? at : null);
      const readAt = row.readAt || (ack >= 3 ? at : null);
      const status = readAt ? 'read' : deliveredAt ? 'delivered' : 'sent';
      db.prepare(`UPDATE campaign_recipients SET delivered_at = ?, read_at = ?, status = ? WHERE id = ?`).run(deliveredAt, readAt, status, row.id);
      return row.id;
    },
    recordReply({ ownerUserId, wppNumberId, phone, repliedAt, replyText }) {
      const row = db.prepare(`SELECT id FROM campaign_recipients
        WHERE owner_user_id = ? AND phone = ? AND (wpp_number_id = ? OR ? IS NULL)
          AND sent_at IS NOT NULL AND replied_at IS NULL
        ORDER BY sent_at DESC LIMIT 1`).get(ownerUserId, phone, wppNumberId || null, wppNumberId || null);
      if (!row) return null;
      db.prepare(`UPDATE campaign_recipients SET replied_at = ?, reply_text = ?, status = 'replied' WHERE id = ?`).run(repliedAt, replyText || null, row.id);
      return row.id;
    },
    listCampaignRecipients(ownerId, campaignId) {
      return db.prepare(`SELECT campaign_recipients.id, campaign_recipients.phone, campaign_recipients.name,
          campaign_recipients.status, campaign_recipients.message_id AS messageId,
          campaign_recipients.sent_at AS sentAt, campaign_recipients.delivered_at AS deliveredAt,
          campaign_recipients.read_at AS readAt, campaign_recipients.replied_at AS repliedAt,
          campaign_recipients.reply_text AS replyText, campaign_recipients.error,
          campaign_recipients.wpp_number_id AS wppNumberId, wpp_numbers.label AS numberLabel
        FROM campaign_recipients LEFT JOIN wpp_numbers ON wpp_numbers.id = campaign_recipients.wpp_number_id
        WHERE campaign_recipients.owner_user_id = ? AND campaign_recipients.campaign_id = ?
        ORDER BY campaign_recipients.sent_at IS NULL, campaign_recipients.sent_at DESC, campaign_recipients.created_at DESC`).all(ownerId, campaignId);
    },
    listCampaignNumberStats(ownerId) {
      return db.prepare(`SELECT campaign_recipients.campaign_id AS campaignId, campaign_recipients.wpp_number_id AS wppNumberId,
          wpp_numbers.label AS numberLabel, COUNT(*) AS total,
          SUM(CASE WHEN campaign_recipients.sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sentCount,
          MAX(campaign_recipients.sent_at) AS lastSentAt,
          SUM(CASE WHEN campaign_recipients.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS deliveredCount,
          MAX(campaign_recipients.delivered_at) AS lastDeliveredAt,
          SUM(CASE WHEN campaign_recipients.read_at IS NOT NULL THEN 1 ELSE 0 END) AS readCount,
          MAX(campaign_recipients.read_at) AS lastReadAt,
          SUM(CASE WHEN campaign_recipients.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS repliedCount,
          MAX(campaign_recipients.replied_at) AS lastRepliedAt
        FROM campaign_recipients LEFT JOIN wpp_numbers ON wpp_numbers.id = campaign_recipients.wpp_number_id
        WHERE campaign_recipients.owner_user_id = ?
        GROUP BY campaign_recipients.campaign_id, campaign_recipients.wpp_number_id
        ORDER BY lastSentAt DESC`).all(ownerId);
    },
    close() { if (db.open) db.close(); }
  };
}

module.exports = { createCampaignStore };
