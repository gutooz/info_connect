const fs = require('node:fs');
const Database = require('/app/node_modules/better-sqlite3');

async function main() {
  const database = new Database(process.env.DATABASE_PATH, { readonly: true });
  const campaigns = database.prepare('SELECT payload FROM campaigns').all().map((row) => JSON.parse(row.payload));
  const summary = {
    users: database.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    contacts: database.prepare('SELECT COUNT(*) AS count FROM contacts').get().count,
    campaigns: campaigns.length,
    activeCampaigns: campaigns.filter((campaign) => ['sending', 'scheduled'].includes(campaign.status)).length
  };
  const target = '/data/predeploy-release.sqlite';
  if (fs.existsSync(target)) throw new Error('O backup temporário já existe.');
  await database.backup(target);
  database.close();
  console.log(JSON.stringify(summary));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
