const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const readXlsxFile = require('read-excel-file/node');
require('dotenv').config();
process.env.TZ = String(process.env.APP_TIMEZONE || 'America/Sao_Paulo');
const { createCampaignStore } = require('./storage');
const { createWppTokenProvider } = require('./wpp-token');
const { installAuth } = require('./auth');
const { createTelegramBot } = require('./telegram');
const { isMissingRecipientError, skipPreviouslyRejectedRecipients } = require('./campaign-errors');

const app = express();
// Atrás do proxy reverso (Caddy/Nginx) só há um salto até o processo Node, então confiamos
// em X-Forwarded-For apenas desse salto: sem isso req.ip fica sempre igual ao IP do proxy,
// o que faria o rate limit de login (server/auth.js) valer para todo mundo de uma vez só.
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const demoMode = process.env.DEMO_MODE !== 'false';
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'major-neto.sqlite');
const campaignStore = createCampaignStore(databasePath);
const campaigns = campaignStore.listAll();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const aiConfigured = Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);
const wppTokenFor = createWppTokenProvider({
  baseUrl: process.env.WPP_CONNECT_URL,
  secretKey: process.env.SECRET_KEY,
  defaultSession: process.env.WPP_CONNECT_SESSION,
  defaultToken: process.env.WPP_CONNECT_TOKEN
});

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '24mb' }));
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origem não permitida.' });
      } catch { return res.status(403).json({ error: 'Origem não permitida.' }); }
    }
  }
  next();
});
const telegramBot = createTelegramBot({
  token: process.env.TELEGRAM_BOT_TOKEN,
  adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID,
  store: campaignStore
});
const webhookSecret = process.env.WPP_WEBHOOK_SECRET || '';

function extractWebhookMessageId(id) {
  if (!id) return null;
  if (typeof id === 'string') return id;
  return id._serialized || id.id || null;
}

// Endpoint chamado pelo WPPConnect Server (fora da sessão do usuário), por isso é registrado
// antes do middleware de autenticação em installAuth, que protege as demais rotas /api.
app.post('/api/integrations/wppconnect/webhook', (req, res) => {
  if (webhookSecret && req.query.secret !== webhookSecret) return res.status(401).json({ error: 'Não autorizado.' });
  const body = req.body || {};
  const session = String(body.session || '').trim();
  const numberRow = session && campaignStore.findNumberBySession(session);
  if (!numberRow) return res.status(202).json({ ignored: true });
  const eventType = String(body.event || body.type || '').toLowerCase();
  const now = new Date().toISOString();
  try {
    if (eventType.includes('ack')) {
      const messageId = extractWebhookMessageId(body.id);
      const ack = Number(body.ack);
      if (messageId && Number.isFinite(ack)) campaignStore.recordAckByMessageId(messageId, ack, now);
    } else if (eventType.includes('message') && body.fromMe !== true) {
      const phone = onlyDigits(String(body.from || body.sender?.id || '').split('@')[0]);
      if (phone) {
        campaignStore.recordReply({
          ownerUserId: numberRow.ownerUserId,
          wppNumberId: numberRow.id,
          phone,
          repliedAt: now,
          replyText: String(body.body || body.content || '').slice(0, 500)
        });
      }
    }
  } catch (_error) { /* eventos de webhook não devem derrubar o servidor */ }
  res.json({ ok: true });
});

installAuth(app, campaignStore, telegramBot);
app.use(express.static(path.join(__dirname, '..', 'public')));

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeRecipients(recipients) {
  if (!Array.isArray(recipients)) return [];
  return recipients
    .map((recipient) => {
      if (typeof recipient === 'string') return { phone: onlyDigits(recipient), name: 'Contato', region: 'Brasil', wppNumberId: null };
      return {
        phone: onlyDigits(recipient.phone),
        name: String(recipient.name || 'Contato').slice(0, 80),
        region: String(recipient.region || 'Brasil').trim().slice(0, 80) || 'Brasil',
        wppNumberId: String(recipient.wppNumberId || '').trim() || null
      };
    })
    .filter((recipient) => recipient.phone.length >= 8 && recipient.phone.length <= 15);
}
function normalizeContact(name, phone, { nameFallback = 'Contato', region } = {}) {
  const normalizedPhone = onlyDigits(phone);
  if (!normalizedPhone || normalizedPhone.length < 8 || normalizedPhone.length > 15) return null;
  return {
    id: crypto.randomUUID(),
    name: String(name || '').trim().slice(0, 80) || nameFallback,
    phone: normalizedPhone,
    region: String(region || '').trim().slice(0, 80) || 'Brasil'
  };
}

const IMPORT_NAME_HEADERS = ['nome', 'name', 'cliente'];
const IMPORT_PHONE_HEADERS = ['telefone', 'phone', 'whatsapp', 'celular', 'numero', 'fone', 'contato'];
const IMPORT_REGION_HEADERS = ['regiao', 'cidade', 'city', 'estado', 'bairro'];

function normalizeHeader(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

// Aceita o termo exato ou cabeçalhos compostos (ex.: "Nome do cliente", "Número").
function findHeaderIndex(headers, terms) {
  const exact = headers.findIndex((header) => terms.includes(header));
  if (exact >= 0) return exact;
  return headers.findIndex((header) => header.split(/[^a-z0-9]+/).some((word) => terms.includes(word)));
}

function contactsFromRows(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(normalizeHeader);
  const phoneIndex = findHeaderIndex(headers, IMPORT_PHONE_HEADERS);
  const nameIndex = findHeaderIndex(headers, IMPORT_NAME_HEADERS);
  const regionIndex = findHeaderIndex(headers, IMPORT_REGION_HEADERS);
  if (nameIndex < 0 || phoneIndex < 0) throw new Error('A planilha precisa ter as colunas nome e telefone.');
  return rows.slice(1).map((values) => normalizeContact(values[nameIndex], values[phoneIndex], {
    nameFallback: 'Delivery',
    region: regionIndex >= 0 ? values[regionIndex] : ''
  })).filter(Boolean);
}

function parseCsv(buffer) {
  const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
  const rows = lines.map((line) => line.split(/[;,]/).map((value) => value.trim().replace(/^"|"$/g, '')));
  return contactsFromRows(rows);
}

async function parseSpreadsheet(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === '.csv') return parseCsv(file.buffer);
  let sheets;
  try {
    sheets = await readXlsxFile(file.buffer);
  } catch {
    throw new Error('Não foi possível ler a planilha. Salve como .xlsx ou .csv e tente novamente.');
  }
  const rows = (sheets[0]?.data || []).map((row) => row.map((cell) => (cell instanceof Date ? '' : cell)));
  return contactsFromRows(rows);
}

function isKnownSession(ownerId, session) {
  return Boolean(campaignStore.findWppNumberBySession(ownerId, session));
}

function unwrapWppResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.response)) return payload.response;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function normalizeWppContact(contact) {
  const rawId = typeof contact.id === 'string' ? contact.id : contact.id?.user;
  const phone = contact.phone || contact.number || rawId;
  const name = contact.name || contact.formattedName || contact.pushname || contact.shortName || 'Contato';
  return normalizeContact(name, String(phone || '').split('@')[0]);
}

const MAX_MESSAGE_VARIANTS = 5;
// Anti-ban safety valve: a number that never stops sending looks automated, so every lane
// takes a longer break after a burst of messages, independent of the daily send window.
const BURST_LIMIT = 40;
const BURST_PAUSE_MS = 15 * 60 * 1000;

// Older campaigns stored the next daily-window opening in nextSendAt. Move only those
// legacy timestamps forward while preserving the configured interval and burst pause.
for (const campaign of campaigns) {
  if (!campaign.dailyStartMinutes && !campaign.dailyEndMinutes) continue;
  let changed = false;
  const resumesSending = campaign.status === 'sending' || (campaign.status === 'paused' && campaign.pausedFrom === 'sending');
  if (resumesSending && Array.isArray(campaign.lanes)) {
    for (const lane of campaign.lanes) {
      if (lane.done) continue;
      const gapMs = lane.sentSinceBreak === 0 ? BURST_PAUSE_MS : (campaign.delayMs || 3000);
      const nextAllowed = Date.now() + gapMs;
      if (!Number.isFinite(Number(lane.nextSendAt)) || Number(lane.nextSendAt) > nextAllowed) {
        lane.nextSendAt = nextAllowed;
        changed = true;
      }
    }
  }
  delete campaign.dailyStartMinutes;
  delete campaign.dailyEndMinutes;
  if (changed) campaignStore.save(campaign);
}

function validateCampaign(input, ownerId) {
  const name = String(input.name || '').trim().slice(0, 120);
  const aiPersonalization = Boolean(input.aiPersonalization);
  const whatsapp = input.channels?.whatsapp || input;
  const type = ['text', 'image', 'video'].includes(whatsapp.type) ? whatsapp.type : 'text';
  const rawMessages = Array.isArray(whatsapp.messages) && whatsapp.messages.length ? whatsapp.messages : (whatsapp.message ? [whatsapp.message] : []);
  const messages = rawMessages.map((item) => String(item || '').trim().slice(0, 4096)).filter(Boolean).slice(0, MAX_MESSAGE_VARIANTS);
  let recipients = normalizeRecipients(input.recipients);
  const availableNumbers = campaignStore.listWppNumbers(ownerId);
  const requestedNumberIds = Array.isArray(input.numberIds) ? [...new Set(input.numberIds)] : [];
  const numberIds = requestedNumberIds.filter((id) => availableNumbers.some((number) => number.id === id));
  const groupId = String(input.groupId || '').trim() || null;
  const selectedGroup = groupId ? campaignStore.findContactGroup(ownerId, groupId) : null;

  if (!name) throw new Error('Informe um nome para a campanha.');
  if (!messages.length && !whatsapp.media?.base64) throw new Error('Adicione ao menos uma mensagem ou um arquivo de mídia.');
  if (!recipients.length) throw new Error('Selecione ao menos um contato válido.');
  if (type !== 'text' && !whatsapp.media?.base64) throw new Error('Envie o arquivo da campanha.');
  if (numberIds.length !== requestedNumberIds.length) throw new Error('Um dos números selecionados não pertence ao seu acesso.');
  if (!numberIds.length) throw new Error('Cadastre e selecione ao menos um número para o disparo.');

  if (groupId && !selectedGroup) throw new Error('O grupo selecionado não pertence ao seu acesso.');
  if (selectedGroup) {
    const groupPhones = new Set(campaignStore.listContactsInGroup(ownerId, groupId).map((contact) => contact.phone));
    if (recipients.some((recipient) => !groupPhones.has(recipient.phone))) throw new Error('Todos os contatos da campanha precisam pertencer ao grupo selecionado.');
  }

  const recipientsByNumber = new Map(numberIds.map((numberId) => [numberId, []]));
  recipients.forEach((recipient, index) => {
    const numberId = recipient.wppNumberId || numberIds[index % numberIds.length];
    const group = recipientsByNumber.get(numberId);
    if (!group) throw new Error('Cada contato precisa estar associado a um número selecionado da sua conta.');
    group.push({ ...recipient, wppNumberId: numberId });
  });
  recipients = [];
  const maxGroupLength = Math.max(0, ...[...recipientsByNumber.values()].map((group) => group.length));
  for (let recipientIndex = 0; recipientIndex < maxGroupLength; recipientIndex += 1) {
    numberIds.forEach((numberId) => {
      const recipient = recipientsByNumber.get(numberId)[recipientIndex];
      if (recipient) recipients.push(recipient);
    });
  }
  if (aiPersonalization && !aiConfigured) throw new Error('Configure AI_API_KEY no .env para ativar a personalização por IA.');

  const startAt = new Date(input.startAt);
  if (Number.isNaN(startAt.getTime())) throw new Error('Informe a data e hora de início da campanha.');

  const intervalValue = Number(input.messageIntervalValue);
  const intervalUnit = input.messageIntervalUnit || 'seconds';
  if (!Number.isSafeInteger(intervalValue) || intervalValue < 1 || !['seconds', 'minutes'].includes(intervalUnit) || intervalValue > (intervalUnit === 'minutes' ? 60 : 3600)) {
    throw new Error('Escolha um intervalo de 1 a 3600 segundos ou de 1 a 60 minutos.');
  }
  const delayMs = intervalValue * (intervalUnit === 'minutes' ? 60000 : 1000);

  return {
    name, type, message: messages[0] || '', messages, recipients, delayMs, aiPersonalization, numberIds,
    groupId, groupName: selectedGroup?.name || null,
    scheduledAt: startAt.toISOString(),
    channels: { whatsapp: { type, message: messages[0] || '', messages, media: whatsapp.media || null }, instagram: null }
  };
}

async function wppFetch(endpoint, { method = 'GET', headers = {}, body, timeoutMs } = {}, sessionOverride) {
  const base = String(process.env.WPP_CONNECT_URL || '').replace(/\/$/, '');
  const sessionName = sessionOverride || process.env.WPP_CONNECT_SESSION || '';
  if (!base || !sessionName) {
    throw new Error('WPPConnect não está configurado.');
  }
  const request = async (refresh = false) => {
    const token = await wppTokenFor(sessionName, { refresh });
    return fetch(`${base}/api/${encodeURIComponent(sessionName)}/${endpoint}`, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
  };
  let response = await request();
  if (response.status === 401) response = await request(true);
  return response;
}

async function wppRequest(endpoint, body, sessionOverride) {
  const response = await wppFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, sessionOverride);
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`WPPConnect respondeu ${response.status}: ${detail.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  return response.json().catch(() => ({}));
}

async function wppGet(endpoint, sessionOverride) {
  const response = await wppFetch(endpoint, {}, sessionOverride);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`WPPConnect respondeu ${response.status}: ${detail.slice(0, 160)}`);
  }
  return response.json().catch(() => ({}));
}

function isWppSessionConnected(status) {
  if (status === true) return true;
  const normalized = String(status || '').trim().toUpperCase().replace(/[\s_-]+/g, '');
  return new Set(['CONNECTED', 'OPEN', 'AUTHENTICATED', 'LOGGED', 'ISLOGGED', 'INCHAT', 'MAIN', 'QRREADSUCCESS']).has(normalized);
}

function wppConnectionStatus(result) {
  const connected = isWppSessionConnected(result?.status) || isWppSessionConnected(result?.message);
  const status = result?.message || result?.status || 'UNKNOWN';
  return { connected, status: String(status).toUpperCase() };
}

function extractAiText(result) {
  if (typeof result.output_text === 'string') return result.output_text.trim();
  return (result.output || []).flatMap((item) => item.content || []).filter((item) => item.type === 'output_text').map((item) => item.text).join('').trim();
}

function applyTemplate(message, recipient) {
  return message
    .replace(/\{\{\s*nome\s*\}\}/gi, recipient.name || '')
    .replace(/\{\{\s*regi[ãa]o\s*\}\}/gi, recipient.region || 'Brasil');
}

async function personalizeMessage(message, recipient) {
  const withName = applyTemplate(message, recipient);
  if (!aiConfigured) return withName;
  const baseUrl = String(process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      instructions: 'Personalize a mensagem para um contato que autorizou receber comunicações. Preserve oferta, valores, links, fatos e instruções de opt-out. Use o nome e a região apenas quando natural. Não crie urgência falsa, não faça alegações novas e não tente contornar filtros ou políticas de plataformas. Retorne somente a mensagem final em português.',
      input: `Nome do contato: ${recipient.name || 'cliente'}\nRegião do contato: ${recipient.region || 'Brasil'}\nMensagem-base:\n${withName}`,
      max_output_tokens: 300,
      temperature: 0.4
    }),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || 'A IA não conseguiu personalizar a mensagem.');
  const personalized = extractAiText(result);
  if (!personalized || personalized.length > 4096) throw new Error('A IA retornou uma mensagem inválida.');
  return personalized;
}

function extractWppMessageId(result) {
  const candidate = result?.response?.id ?? result?.id ?? result?.response?.messageId;
  if (!candidate) return null;
  if (typeof candidate === 'string') return candidate;
  return candidate._serialized || candidate.id || null;
}

// No modo demonstração não há WhatsApp real, então simulamos a progressão
// enviado → entregue → lido → respondido para o dashboard ter algo para mostrar.
function simulateDemoDeliveryAndReply({ messageId, ownerId, wppNumberId, phone }) {
  setTimeout(() => {
    campaignStore.recordAckByMessageId(messageId, 2, new Date().toISOString());
    if (Math.random() < 0.6) {
      setTimeout(() => {
        campaignStore.recordAckByMessageId(messageId, 3, new Date().toISOString());
        if (Math.random() < 0.35) {
          setTimeout(() => {
            campaignStore.recordReply({ ownerUserId: ownerId, wppNumberId, phone, repliedAt: new Date().toISOString(), replyText: 'Ok, obrigado!' });
          }, 2000 + Math.random() * 6000);
        }
      }, 1000 + Math.random() * 4000);
    }
  }, 1500 + Math.random() * 2500);
}

// Each number in numberIds runs its own lane: lane L owns recipients at indexes L, L+laneCount, L+2*laneCount, ...
// so each selected sender owns a lane with its own interval and burst pause.
async function sendLaneMessage(campaign, lane) {
  const content = campaign.channels?.whatsapp || campaign;
  const messages = content.messages && content.messages.length ? content.messages : [content.message || ''];
  const numbersById = new Map(campaignStore.listWppNumbers(campaign.ownerUserId).map((number) => [number.id, number.session]));
  const session = numbersById.get(lane.numberId);
  if (!session) throw new Error('Número da campanha removido ou indisponível.');
  const recipient = campaign.recipients[lane.nextIndex];
  const baseMessage = messages[lane.nextIndex % messages.length] || '';
  let message = baseMessage;
  if (campaign.aiPersonalization && baseMessage) {
    try { message = await personalizeMessage(baseMessage, recipient); } catch (_error) { campaign.aiFallbacks = (campaign.aiFallbacks || 0) + 1; message = applyTemplate(baseMessage, recipient); }
  } else {
    message = applyTemplate(baseMessage, recipient);
  }
  const recipientRowId = crypto.randomUUID();
  campaignStore.createRecipient({ id: recipientRowId, campaignId: campaign.id, ownerId: campaign.ownerUserId, wppNumberId: lane.numberId, phone: recipient.phone, name: recipient.name });
  try {
    let messageId = null;
    if (demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      messageId = `demo-${recipientRowId}`;
    } else if (content.type === 'text') {
      const result = await wppRequest('send-message', { phone: recipient.phone, message }, session);
      messageId = extractWppMessageId(result);
    } else {
      const result = await wppRequest(content.type === 'image' ? 'send-image' : 'send-file', {
        phone: recipient.phone,
        filename: content.media.name || `campanha.${content.type === 'image' ? 'jpg' : 'mp4'}`,
        caption: message,
        base64: content.media.base64
      }, session);
      messageId = extractWppMessageId(result);
    }
    campaignStore.markRecipientSent(recipientRowId, { messageId, sentAt: new Date().toISOString() });
    if (demoMode) simulateDemoDeliveryAndReply({ messageId, ownerId: campaign.ownerUserId, wppNumberId: lane.numberId, phone: recipient.phone });
  } catch (error) {
    campaignStore.markRecipientFailed(recipientRowId, error.message);
    throw error;
  }
}

async function advanceLane(campaign, lane) {
  let sent = false;
  try {
    await sendLaneMessage(campaign, lane);
    campaign.sent = (campaign.sent || 0) + 1;
    sent = true;
  } catch (error) {
    if (!isMissingRecipientError(error)) {
      campaign.status = 'error';
      campaign.statusLabel = 'Falhou';
      campaign.error = error.message;
      return;
    }
    campaign.failed = (campaign.failed || 0) + 1;
    campaign.lastError = error.message;
  }
  lane.nextIndex += campaign.numberIds.length;
  if (sent) lane.sentSinceBreak = (lane.sentSinceBreak || 0) + 1;
  if (lane.nextIndex >= campaign.recipients.length) {
    lane.done = true;
    return;
  }
  const takeBreak = lane.sentSinceBreak >= BURST_LIMIT;
  if (takeBreak) lane.sentSinceBreak = 0;
  const gapMs = takeBreak ? BURST_PAUSE_MS : (campaign.delayMs || 3000);
  lane.nextSendAt = Date.now() + gapMs;
}

async function publishToMeta(campaign) {
  if (demoMode) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return { id: `demo-meta-${Date.now()}` };
  }
  const content = campaign.channels?.instagram || campaign;
  if (content.type === 'text') throw new Error('A publicação do Instagram precisa de uma imagem ou vídeo.');
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const userId = process.env.META_IG_USER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  const publicUrl = content.media?.publicUrl;
  if (!userId || !accessToken || !publicUrl) {
    throw new Error('Meta exige META_IG_USER_ID, META_ACCESS_TOKEN e uma URL pública para a mídia.');
  }
  const params = new URLSearchParams({
    access_token: accessToken,
    caption: content.message || ''
  });
  params.set(content.type === 'video' ? 'media_type' : 'image_url', content.type === 'video' ? 'REELS' : publicUrl);
  if (content.type === 'video') params.set('video_url', publicUrl);
  const createResponse = await fetch(`https://graph.facebook.com/${graphVersion}/${userId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const container = await createResponse.json();
  if (!createResponse.ok || !container.id) throw new Error(container.error?.message || 'Não foi possível criar a publicação no Meta.');
  const publishParams = new URLSearchParams({ creation_id: container.id, access_token: accessToken });
  const publishResponse = await fetch(`https://graph.facebook.com/${graphVersion}/${userId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishParams
  });
  const published = await publishResponse.json();
  if (!publishResponse.ok || !published.id) throw new Error(published.error?.message || 'Não foi possível publicar no Meta.');
  return published;
}

function startCampaign(campaign) {
  campaign.status = 'sending';
  campaign.statusLabel = 'Enviando';
  campaign.sent = campaign.sent || 0;
  const scheduledAt = Date.parse(campaign.scheduledAt);
  const initialReference = new Date(Math.max(Number.isFinite(scheduledAt) ? scheduledAt : 0, Date.now()));
  const initial = initialReference.getTime();
  campaign.lanes = campaign.numberIds.map((numberId, laneIndex) => ({
    numberId, nextIndex: laneIndex, nextSendAt: initial, done: laneIndex >= campaign.recipients.length, sentSinceBreak: 0
  }));
  campaignStore.save(campaign);
}

let tickRunning = false;

// Ticks every campaign that's due: starts scheduled ones whose start time has passed, then lets
// each lane of every 'sending' campaign send its next message once its nextSendAt has arrived.
// Progress lives in campaign.lanes, persisted on every save, so a server restart resumes correctly.
async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const now = Date.now();
    campaigns
      .filter((campaign) => campaign.status === 'scheduled' && campaign.scheduledAt && Date.parse(campaign.scheduledAt) <= now)
      .forEach((campaign) => startCampaign(campaign));

    const active = campaigns.filter((campaign) => campaign.status === 'sending' && campaign.lanes);
    await Promise.all(active.map(async (campaign) => {
      const dueLanes = campaign.lanes.filter((lane) => !lane.done && lane.nextSendAt <= now);
      if (!dueLanes.length) return;
      await Promise.all(dueLanes.map((lane) => advanceLane(campaign, lane)));
      if (campaign.status === 'sending' && campaign.lanes.every((lane) => lane.done)) {
        try {
          if (campaign.publishedMeta) await publishToMeta(campaign);
          campaign.status = 'completed';
          campaign.statusLabel = campaign.failed ? `Concluída com ${campaign.failed} falha${campaign.failed === 1 ? '' : 's'}` : 'Concluída';
          campaign.completedAt = new Date().toISOString();
        } catch (error) {
          campaign.status = 'error';
          campaign.statusLabel = 'Falhou';
          campaign.error = error.message;
        }
      }
      campaignStore.save(campaign);
    }));
  } finally {
    tickRunning = false;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    demoMode,
    wppconnect: demoMode || Boolean(process.env.WPP_CONNECT_URL && process.env.WPP_CONNECT_TOKEN),
    wppSession: String(process.env.WPP_CONNECT_SESSION || '').trim(),
    meta: demoMode || Boolean(process.env.META_IG_USER_ID && process.env.META_ACCESS_TOKEN),
    ai: aiConfigured
  });
});

app.get('/api/contacts', (req, res) => res.json(campaignStore.listContacts(req.user.id)));

app.get('/api/contact-groups', (req, res) => res.json(campaignStore.listContactGroups(req.user.id)));

app.post('/api/contact-groups', (req, res) => {
  try {
    const group = campaignStore.createContactGroup(req.user.id, req.body?.name);
    res.status(201).json({ group, groups: campaignStore.listContactGroups(req.user.id) });
  } catch (error) {
    res.status(422).json({ error: error.message });
  }
});

app.get('/api/wpp-numbers', (req, res) => res.json(campaignStore.listWppNumbers(req.user.id)));

app.post('/api/wpp-numbers', (req, res) => {
  const sessionKey = String(req.body.session || '').trim();
  const label = String(req.body.label || '').trim().slice(0, 60) || sessionKey;
  if (!/^[a-zA-Z0-9_-]{1,26}$/.test(sessionKey)) return res.status(422).json({ error: 'Informe uma sessão de até 26 caracteres, sem espaços ou acentos.' });
  try {
    const numbers = campaignStore.addWppNumber(req.user.id, { id: crypto.randomUUID(), sessionKey, label });
    res.status(201).json({ numbers });
  } catch (error) {
    res.status(422).json({ error: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Essa sessão já está cadastrada.' : error.message });
  }
});

app.delete('/api/wpp-numbers/:id', (req, res) => {
  res.json({ numbers: campaignStore.removeWppNumber(req.user.id, req.params.id) });
});

app.post('/api/contacts', (req, res) => {
  const contact = normalizeContact(req.body?.name, req.body?.phone, { region: req.body?.region });
  if (!contact || !String(req.body?.name || '').trim()) return res.status(422).json({ error: 'Informe nome e WhatsApp válido.' });
  const groupId = String(req.body?.groupId || '').trim();
  const group = groupId ? campaignStore.findContactGroup(req.user.id, groupId) : campaignStore.createContactGroup(req.user.id, 'Contatos manuais');
  if (!group) return res.status(422).json({ error: 'O grupo selecionado não pertence ao seu acesso.' });
  campaignStore.saveContacts(req.user.id, [contact]);
  campaignStore.assignContactToLeastLoadedNumber(req.user.id, contact.phone);
  campaignStore.addContactsToGroup(req.user.id, group.id, [contact.phone]);
  res.status(201).json({ contact: campaignStore.listContacts(req.user.id).find((item) => item.phone === contact.phone), contacts: campaignStore.listContacts(req.user.id), groups: campaignStore.listContactGroups(req.user.id) });
});

app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'Selecione uma planilha.' });
    const requestedGroupId = String(req.body?.groupId || '').trim();
    const groupName = String(req.body?.groupName || '').trim().slice(0, 80);
    let group = requestedGroupId ? campaignStore.findContactGroup(req.user.id, requestedGroupId) : null;
    if (requestedGroupId && !group) return res.status(422).json({ error: 'O grupo escolhido não pertence ao seu acesso.' });
    if (!requestedGroupId && !groupName) return res.status(422).json({ error: 'Escolha um grupo existente ou informe o nome do novo grupo.' });
    const imported = await parseSpreadsheet(req.file);
    const unique = imported.filter((contact, index, list) => list.findIndex((item) => item.phone === contact.phone) === index);
    if (!unique.length) return res.status(422).json({ error: 'A planilha não tem contatos válidos para importar.' });
    if (!group) {
      const duplicateName = campaignStore.listContactGroups(req.user.id).some((item) => item.name.localeCompare(groupName, 'pt-BR', { sensitivity: 'accent' }) === 0);
      if (duplicateName) return res.status(409).json({ error: 'Já existe um grupo com esse nome. Escolha o grupo existente na lista.' });
      group = campaignStore.createContactGroup(req.user.id, groupName);
    }
    const accountPhones = new Set(campaignStore.listContacts(req.user.id).map((contact) => contact.phone));
    const groupPhones = new Set(campaignStore.listContactsInGroup(req.user.id, group.id).map((contact) => contact.phone));
    const fresh = unique.filter((contact) => !accountPhones.has(contact.phone));
    const addedToGroup = unique.filter((contact) => !groupPhones.has(contact.phone));
    const skipped = unique.length - addedToGroup.length;
    campaignStore.saveContacts(req.user.id, fresh);
    campaignStore.addContactsToGroup(req.user.id, group.id, unique.map((contact) => contact.phone));
    const numbers = campaignStore.assignContactsRoundRobin(req.user.id, fresh.map((contact) => contact.phone));
    res.json({ count: addedToGroup.length, newContacts: fresh.length, skipped, group, groups: campaignStore.listContactGroups(req.user.id), contacts: campaignStore.listContacts(req.user.id), numbers });
  } catch (error) {
    res.status(422).json({ error: `Não foi possível ler a planilha: ${error.message}` });
  }
});

app.post('/api/integrations/wppconnect/connect', async (req, res) => {
  const session = String(req.body.session || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  if (!session) return res.status(422).json({ error: 'Informe o nome da sessão.' });
  if (!isKnownSession(req.user.id, session)) {
    return res.status(422).json({ error: 'Cadastre este número em "Números do WhatsApp" antes de conectar.' });
  }
  if (demoMode) return res.json({ status: 'awaiting_qr', demoMode: true, message: 'Modo demonstração: nenhum WhatsApp foi conectado.' });
  try {
    const current = wppConnectionStatus(await wppGet('check-connection-session', session));
    if (current.connected) return res.json({ status: 'CONNECTED', qrCode: null });
    const webhookUrl = process.env.PUBLIC_BASE_URL
      ? `${String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '')}/api/integrations/wppconnect/webhook${webhookSecret ? `?secret=${encodeURIComponent(webhookSecret)}` : ''}`
      : null;
    const response = await wppFetch('start-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waitQrCode: true, ...(webhookUrl ? { webhook: webhookUrl } : {}) }),
      timeoutMs: 60000
    }, session);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: result.message || 'Não foi possível iniciar a sessão do WhatsApp.' });
    res.json({ status: result.status || 'awaiting_qr', qrCode: result.qrcode || result.qrCode || result.response?.qrcode || result.response?.qrCode || null });
  } catch (error) { res.status(502).json({ error: `WPPConnect indisponível: ${error.message}` }); }
});

app.get('/api/integrations/wppconnect/qr', async (req, res) => {
  const session = String(req.query.session || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  if (!session) return res.status(422).json({ error: 'Informe o nome da sessÃ£o.' });
  if (!isKnownSession(req.user.id, session)) return res.status(422).json({ error: 'Cadastre este número antes de gerar o QR Code.' });
  if (demoMode) return res.json({ qrCode: null, demoMode: true });
  try {
    const response = await wppFetch('qrcode-session', { timeoutMs: 10000 }, session);
    if (!response.ok) return res.status(502).json({ error: 'Não foi possível obter o QR Code do WhatsApp.' });
    if (response.headers.get('content-type')?.startsWith('image/')) {
      const image = Buffer.from(await response.arrayBuffer());
      return res.json({ qrCode: `data:image/png;base64,${image.toString('base64')}` });
    }
    const result = await response.json().catch(() => ({}));
    res.json({ qrCode: result.qrcode || result.qrCode || result.base64QrCode || null });
  } catch (error) { res.status(502).json({ error: `NÃ£o foi possÃ­vel obter o QR Code: ${error.message}` }); }
});

app.get('/api/integrations/wppconnect/status', async (req, res) => {
  const session = String(req.query.session || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  if (!session) return res.status(422).json({ error: 'Informe o nome da sessão.' });
  if (!isKnownSession(req.user.id, session)) {
    return res.status(422).json({ error: 'Cadastre este número em "Números do WhatsApp" antes de consultar o status.' });
  }
  if (demoMode) return res.json({ connected: false, status: 'DEMO', demoMode: true });
  try {
    const status = wppConnectionStatus(await wppGet('check-connection-session', session));
    res.json({ ...status, session });
  } catch (error) { res.status(502).json({ error: `Não foi possível consultar o WhatsApp: ${error.message}` }); }
});

app.get('/api/integrations/wppconnect/contacts', async (req, res) => {
  const session = String(req.query.session || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  if (!session) return res.status(422).json({ error: 'Informe o nome da sessÃ£o.' });
  if (!isKnownSession(req.user.id, session)) return res.status(422).json({ error: 'Este número não pertence ao seu acesso.' });
  if (demoMode) return res.json({ count: 0, contacts: [], demoMode: true });
  try {
    const result = await wppGet('all-contacts', session);
    const extracted = unwrapWppResponse(result).map(normalizeWppContact).filter(Boolean);
    const unique = extracted.filter((contact, index, list) => list.findIndex((item) => item.phone === contact.phone) === index);
    campaignStore.saveContacts(req.user.id, unique);
    const number = campaignStore.listWppNumbers(req.user.id).find((item) => item.session === session);
    const group = campaignStore.createContactGroup(req.user.id, `WhatsApp - ${number?.label || 'Contatos'}`);
    campaignStore.addContactsToGroup(req.user.id, group.id, unique.map((contact) => contact.phone));
    campaignStore.assignContactsRoundRobin(req.user.id, unique.map((contact) => contact.phone));
    res.json({ count: unique.length, group, groups: campaignStore.listContactGroups(req.user.id), contacts: campaignStore.listContacts(req.user.id) });
  } catch (error) { res.status(502).json({ error: `NÃ£o foi possÃ­vel extrair os contatos: ${error.message}` }); }
});

app.post('/api/integrations/instagram/connect', async (req, res) => {
  const userId = String(req.body.userId || '').trim();
  const token = String(req.body.token || '').trim();
  if (!userId || !token) return res.status(422).json({ error: 'Informe o ID da conta e o token do Meta.' });
  if (demoMode) return res.json({ status: 'connected', demoMode: true, username: 'conta-demo' });
  try {
    const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
    const params = new URLSearchParams({ fields: 'id,username', access_token: token });
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(userId)}?${params}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.id) return res.status(422).json({ error: result.error?.message || 'O Meta não validou esta conta ou token.' });
    res.json({ status: 'connected', username: result.username || result.id });
  } catch (error) { res.status(502).json({ error: `Meta indisponível: ${error.message}` }); }
});

app.get('/api/campaigns', (req, res) => res.json(campaigns.filter((campaign) => campaign.ownerUserId === req.user.id).map(({ recipients, media, channels, ownerUserId, ...campaign }) => campaign)));

app.get('/api/dashboard/campaign-numbers', (req, res) => {
  const campaignById = new Map(campaigns.filter((campaign) => campaign.ownerUserId === req.user.id).map((campaign) => [campaign.id, campaign]));
  const rows = campaignStore.listCampaignNumberStats(req.user.id)
    .filter((row) => campaignById.has(row.campaignId))
    .map((row) => {
      const campaign = campaignById.get(row.campaignId);
      return {
        campaignId: row.campaignId,
        campaignName: campaign.name,
        campaignStatus: campaign.status,
        campaignStatusLabel: campaign.statusLabel,
        campaignSent: campaign.sent || 0,
        campaignAudience: campaign.audience || 0,
        wppNumberId: row.wppNumberId,
        numberLabel: row.numberLabel || 'Sem número',
        total: row.total,
        sentCount: row.sentCount,
        lastSentAt: row.lastSentAt,
        deliveredCount: row.deliveredCount,
        lastDeliveredAt: row.lastDeliveredAt,
        readCount: row.readCount,
        lastReadAt: row.lastReadAt,
        repliedCount: row.repliedCount,
        lastRepliedAt: row.lastRepliedAt
      };
    });
  res.json(rows);
});

app.get('/api/campaigns/:id/recipients', (req, res) => {
  const campaign = campaigns.find((item) => item.id === req.params.id && item.ownerUserId === req.user.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
  const recipients = campaignStore.listCampaignRecipients(req.user.id, req.params.id)
    .filter((recipient) => !req.query.numberId || recipient.wppNumberId === req.query.numberId);
  res.json({ campaign: { id: campaign.id, name: campaign.name, status: campaign.status, statusLabel: campaign.statusLabel }, recipients });
});

app.post('/api/campaigns/test-send', async (req, res) => {
  try {
    const number = campaignStore.listWppNumbers(req.user.id).find((item) => item.id === req.body?.numberId);
    if (!number) return res.status(422).json({ error: 'Selecione um número válido para o teste.' });
    const phone = onlyDigits(req.body?.phone);
    if (phone.length < 8 || phone.length > 15) return res.status(422).json({ error: 'Informe um WhatsApp válido com DDI.' });
    const type = ['text', 'image', 'video'].includes(req.body?.type) ? req.body.type : 'text';
    const media = req.body?.media || null;
    const rawMessage = String(req.body?.message || '').trim().slice(0, 4096);
    if (!rawMessage && !media?.base64) return res.status(422).json({ error: 'Escreva uma mensagem ou anexe uma mídia para testar.' });
    if (type !== 'text' && !media?.base64) return res.status(422).json({ error: 'Envie o arquivo para testar esse tipo de mensagem.' });
    const recipient = { name: 'Teste', region: 'Brasil', phone };
    const message = applyTemplate(rawMessage, recipient);
    if (demoMode) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    } else if (type === 'text') {
      await wppRequest('send-message', { phone, message }, number.session);
    } else {
      await wppRequest(type === 'image' ? 'send-image' : 'send-file', {
        phone, filename: media.name || `teste.${type === 'image' ? 'jpg' : 'mp4'}`, caption: message, base64: media.base64
      }, number.session);
    }
    res.json({ ok: true, demoMode });
  } catch (error) {
    res.status(422).json({ error: error.message });
  }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const requestId = String(req.body?.requestId || '').trim();
    if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return res.status(422).json({ error: 'Identificador de publicação inválido.' });
    }
    if (requestId) {
      const existing = campaigns.find((item) => item.id === requestId);
      if (existing && existing.ownerUserId !== req.user.id) {
        return res.status(409).json({ error: 'Identificador de publicação já utilizado.' });
      }
      if (existing) {
        return res.json({ id: existing.id, status: existing.status, demoMode, replayed: true });
      }
    }
    const validated = validateCampaign(req.body, req.user.id);
    const campaign = {
      id: requestId || crypto.randomUUID(),
      ownerUserId: req.user.id,
      ...validated,
      media: req.body.media || null,
      audience: validated.recipients.length,
      sent: 0,
      publishedMeta: false,
      status: 'scheduled',
      statusLabel: 'Agendada',
      createdAt: 'Agora',
      color: req.body.type === 'image' ? '#d7f3ed' : req.body.type === 'video' ? '#eee5ff' : '#fff0d4'
    };
    campaigns.unshift(campaign);
    campaignStore.save(campaign);
    if (Date.parse(campaign.scheduledAt) <= Date.now()) startCampaign(campaign);
    res.status(201).json({ id: campaign.id, status: campaign.status, demoMode });
  } catch (error) {
    res.status(422).json({ error: error.message });
  }
});

app.post('/api/campaigns/:id/launch', async (req, res) => {
  const campaign = campaigns.find((item) => item.id === req.params.id && item.ownerUserId === req.user.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
  if (campaign.status === 'scheduled') {
    campaign.scheduledAt = new Date().toISOString();
    startCampaign(campaign);
  }
  await tick();
  res.json({ id: campaign.id, status: campaign.status, sent: campaign.sent, error: campaign.error });
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaign = campaigns.find((item) => item.id === req.params.id && item.ownerUserId === req.user.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
  const { ownerUserId, ...safe } = campaign;
  res.json(safe);
});

app.put('/api/campaigns/:id', (req, res) => {
  const campaign = campaigns.find((item) => item.id === req.params.id && item.ownerUserId === req.user.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
  if (!['scheduled', 'paused'].includes(campaign.status)) {
    return res.status(422).json({ error: 'Só é possível editar campanhas agendadas ou pausadas.' });
  }
  try {
    const validated = validateCampaign(req.body, req.user.id);
    Object.assign(campaign, validated, { media: req.body.media || null, audience: validated.recipients.length });
    campaignStore.save(campaign);
    res.json({ id: campaign.id, status: campaign.status });
  } catch (error) {
    res.status(422).json({ error: error.message });
  }
});

app.delete('/api/campaigns/:id', (req, res) => {
  const index = campaigns.findIndex((item) => item.id === req.params.id && item.ownerUserId === req.user.id);
  if (index === -1) return res.status(404).json({ error: 'Campanha não encontrada.' });
  campaignStore.remove(req.user.id, req.params.id);
  campaigns.splice(index, 1);
  res.json({ ok: true });
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  const campaign = campaigns.find((item) => item.id === req.params.id && item.ownerUserId === req.user.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
  if (!['scheduled', 'sending'].includes(campaign.status)) {
    return res.status(422).json({ error: 'Esta campanha não pode ser pausada.' });
  }
  campaign.pausedFrom = campaign.status;
  campaign.status = 'paused';
  campaign.statusLabel = 'Pausada';
  campaignStore.save(campaign);
  res.json({ id: campaign.id, status: campaign.status });
});

app.post('/api/campaigns/:id/resume', async (req, res) => {
  const campaign = campaigns.find((item) => item.id === req.params.id && item.ownerUserId === req.user.id);
  if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada.' });
  if (!['paused', 'error'].includes(campaign.status)) return res.status(422).json({ error: 'Esta campanha não pode ser retomada.' });

  if (campaign.status === 'error' && campaign.lanes) {
    const failures = campaignStore.listCampaignRecipients(req.user.id, campaign.id);
    const skipped = skipPreviouslyRejectedRecipients(campaign, failures);
    campaign.failed = (campaign.failed || 0) + skipped;
    campaign.lanes.filter((lane) => !lane.done).forEach((lane) => {
      const gapMs = lane.sentSinceBreak === 0 ? BURST_PAUSE_MS : (campaign.delayMs || 3000);
      lane.nextSendAt = Math.min(Number(lane.nextSendAt) || Infinity, Date.now() + gapMs);
    });
    campaign.status = 'sending';
    campaign.statusLabel = 'Enviando';
    delete campaign.error;
    campaignStore.save(campaign);
    await tick();
    return res.json({ id: campaign.id, status: campaign.status, skipped });
  }

  const resumeTo = campaign.pausedFrom || 'scheduled';
  delete campaign.pausedFrom;
  if (resumeTo === 'sending' && campaign.lanes) {
    campaign.status = 'sending';
    campaign.statusLabel = 'Enviando';
  } else {
    campaign.status = 'scheduled';
    campaign.statusLabel = 'Agendada';
    if (Date.parse(campaign.scheduledAt) <= Date.now()) startCampaign(campaign);
  }
  campaignStore.save(campaign);
  await tick();
  res.json({ id: campaign.id, status: campaign.status });
});

setInterval(() => {
  tick().catch((error) => console.error('Falha ao processar disparos:', error));
}, 500);

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(port, host, () => {
  console.log(`Info Connect rodando em http://localhost:${port} (${demoMode ? 'modo demonstração' : 'modo conectado'})`);
});
