const state = {
  type: 'text',
  recipients: [],
  media: null,
  campaigns: [],
  health: { demoMode: true },
  contactsFile: null,
  wppNumbers: [],
  wppNumberStatus: {},
  activeQrNumberId: null,
  qrPendingNumberId: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const toast = (message) => { const element = $('#toast'); element.textContent = message; element.classList.add('show'); setTimeout(() => element.classList.remove('show'), 3200); };
let wppStatusTimer = null;
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  const register = mode !== 'login';
  $('#auth-title').textContent = register ? 'Cadastrar' : 'Entrar';
  $('#auth-description').textContent = mode === 'invite' ? 'Cadastre outra pessoa. O acesso depende de aprovação.' : register ? 'Seu cadastro será enviado para aprovação.' : 'Acesse suas campanhas e contatos.';
  $('#auth-name-label').classList.toggle('hidden', !register);
  $('#auth-name').classList.toggle('hidden', !register);
  $('#auth-name').required = register;
  $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-password').minLength = register ? 12 : 1;
  $('#auth-submit').textContent = register ? 'Cadastrar' : 'Entrar';
  $('#auth-cancel').classList.toggle('hidden', mode !== 'invite');
  $('#auth-toggle').classList.toggle('hidden', mode === 'invite');
  $('#auth-toggle').textContent = mode === 'login' ? 'Não tem conta? Cadastre-se' : 'Já tem conta? Entrar';
  $('#auth-error').textContent = '';
}

function showApp(user) {
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#current-user-name').textContent = user.name;
  void loadData();
}

async function initializeAuth() {
  try {
    const response = await fetch('/api/auth/state');
    const result = await response.json();
    if (result.user) showApp(result.user);
    else setAuthMode('login');
  } catch { $('#auth-error').textContent = 'Não foi possível conectar ao servidor.'; }
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#auth-submit');
  button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const response = await fetch(authMode === 'login' ? '/api/auth/login' : '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#auth-name').value.trim(), email: $('#auth-email').value.trim(), password: $('#auth-password').value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível continuar.');
    $('#auth-form').reset();
    if (authMode === 'invite') {
      $('#auth-screen').classList.add('hidden');
      $('#app-shell').classList.remove('hidden');
      toast('Cadastro enviado para aprovação.');
    } else if (authMode === 'register') {
      setAuthMode('login');
      toast('Cadastro enviado! Você poderá entrar assim que for aprovado.');
    } else {
      showApp(result.user);
    }
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#create-user').addEventListener('click', () => { setAuthMode('invite'); $('#app-shell').classList.add('hidden'); $('#auth-screen').classList.remove('hidden'); });
$('#auth-cancel').addEventListener('click', () => { $('#auth-screen').classList.add('hidden'); $('#app-shell').classList.remove('hidden'); });
$('#auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
$('#logout-button').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); });

function renderWppNumbers() {
  const list = $('#wpp-number-list');
  if (!list) return;
  if (!state.wppNumbers.length) {
    list.innerHTML = '<div class="empty-state"><strong>Nenhum número cadastrado</strong><span>Clique em Gerar QR Code para conectar um WhatsApp.</span></div>';
  } else {
    list.innerHTML = state.wppNumbers.map((number) => {
      const connected = Boolean(state.wppNumberStatus[number.id]);
      const pending = state.qrPendingNumberId === number.id;
      return `<div class="wpp-number-row" data-id="${number.id}">
        <div class="service-logo whatsapp-logo mini">◌</div>
        <div><strong>${escapeHtml(number.label)}</strong><small>sessão: ${escapeHtml(number.sessionKey || number.session)} · ${number.contactCount || 0} contato${number.contactCount === 1 ? '' : 's'}</small></div>
        <span class="integration-badge ${connected ? 'connected' : 'pending'}"><i></i> ${connected ? 'Conectado' : 'Não conectado'}</span>
        <button class="button button-secondary" data-action="connect" type="button" ${connected || pending ? 'disabled' : ''}>${connected ? 'Conectado' : pending ? 'Gerando...' : 'Gerar QR Code'}</button>
        <button class="icon-button" data-action="remove" type="button" aria-label="Remover número">×</button>
      </div>`;
    }).join('');
  }
  const anyConnected = state.wppNumbers.some((number) => state.wppNumberStatus[number.id]);
  const pageBadge = $('#whatsapp-page .integration-badge');
  if (pageBadge) {
    pageBadge.classList.toggle('pending', !anyConnected);
    pageBadge.classList.toggle('connected', anyConnected);
    pageBadge.innerHTML = `<i></i> ${anyConnected ? 'Conectado' : 'Não conectado'}`;
  }
  const previewStatus = $('#preview-whatsapp-status');
  if (previewStatus) previewStatus.textContent = anyConnected ? 'conectado' : 'não conectado';
  renderNumberChecklist();
  renderContactsPage();
}

function renderNumberChecklist() {
  const container = $('#campaign-number-checklist');
  if (!container) return;
  if (!state.wppNumbers.length) {
    container.innerHTML = '<div class="empty-state"><strong>Nenhum número cadastrado</strong><span>Cadastre um número na aba WhatsApp antes de criar uma campanha.</span></div>';
    return;
  }
  const previouslyChecked = new Set([...container.querySelectorAll('input:checked')].map((input) => input.value));
  container.innerHTML = state.wppNumbers.map((number) => `
    <label class="number-check-row">
      <input type="checkbox" value="${number.id}" ${previouslyChecked.size === 0 || previouslyChecked.has(number.id) ? 'checked' : ''} />
      <span><strong>${escapeHtml(number.label)}</strong><small>sessão: ${escapeHtml(number.sessionKey || number.session)}</small></span>
    </label>
  `).join('');
}

async function checkWppStatuses() {
  if (state.health.demoMode || !state.wppNumbers.length) return;
  await Promise.all(state.wppNumbers.map(async (number) => {
    try {
      const response = await fetch(`/api/integrations/wppconnect/status?session=${encodeURIComponent(number.session)}`);
      const result = await response.json();
      state.wppNumberStatus[number.id] = response.ok && result.connected === true;
    } catch { state.wppNumberStatus[number.id] = false; }
  }));
  renderWppNumbers();
}

function startWhatsAppStatusPolling() {
  if (wppStatusTimer) clearInterval(wppStatusTimer);
  void checkWppStatuses();
  wppStatusTimer = setInterval(checkWppStatuses, 5000);
}

async function loadWppNumbers() {
  try {
    const response = await fetch('/api/wpp-numbers');
    state.wppNumbers = response.ok ? await response.json() : [];
  } catch { state.wppNumbers = []; }
  renderWppNumbers();
  startWhatsAppStatusPolling();
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function formatCampaignType(type) { return type === 'image' ? ['▧', 'Imagem', 'type-image'] : type === 'video' ? ['▶', 'Vídeo', 'type-video'] : ['☷', 'Texto', 'type-text']; }
function formatStatus(status) { return status === 'completed' ? 'completed' : status === 'sending' ? 'sending' : status === 'scheduled' ? 'scheduled' : 'error'; }

function renderMetrics() {
  const campaigns = state.campaigns;
  const totalSent = campaigns.reduce((sum, campaign) => sum + (campaign.sent || 0), 0);
  const totalAudience = campaigns.reduce((sum, campaign) => sum + (campaign.audience || 0), 0);
  const scheduledCampaigns = campaigns.filter((campaign) => campaign.status === 'scheduled').length;
  const deliveryRate = totalAudience ? Math.round((totalSent / totalAudience) * 100) : null;

  $('#sent-metric').textContent = totalSent;
  $('#sent-metric-caption').textContent = campaigns.length ? `Em ${campaigns.length} campanha${campaigns.length === 1 ? '' : 's'}` : 'Sem dados ainda';

  $('#delivery-metric').textContent = deliveryRate === null ? '—' : `${deliveryRate}%`;
  $('#delivery-metric-caption').textContent = deliveryRate === null ? 'Sem dados ainda' : `${totalSent} de ${totalAudience} contatos`;

  $('#scheduled-metric').textContent = scheduledCampaigns;
  $('#scheduled-metric-caption').textContent = scheduledCampaigns ? 'Aguardando o horário' : 'Nenhum agendamento';
}

function renderCampaigns() {
  $('#campaign-count').textContent = state.campaigns.length;
  renderMetrics();
  if (!state.campaigns.length) {
    $('#campaign-table-body').innerHTML = '<tr><td colspan="6"><div class="empty-state"><strong>Nenhuma campanha criada</strong><span>Crie sua primeira campanha para acompanhar os disparos aqui.</span></div></td></tr>';
    return;
  }
  $('#campaign-table-body').innerHTML = state.campaigns.map((campaign) => {
    const [icon, label, typeClass] = formatCampaignType(campaign.type);
    return `<tr><td><div class="campaign-name-cell"><span class="campaign-thumb ${typeClass}">${icon}</span>${escapeHtml(campaign.name)}</div></td><td><div class="channel-cell"><span class="channel-dot">◉</span> WhatsApp ${campaign.publishedMeta ? '<span class="channel-dot meta">∞</span>' : ''}</div></td><td>${campaign.audience || 0} contatos</td><td>${campaign.sent || 0} / ${campaign.audience || 0}</td><td><span class="status-pill status-${formatStatus(campaign.status)}">${escapeHtml(campaign.statusLabel || label)}</span></td><td>${escapeHtml(campaign.createdAt || 'Agora')}</td></tr>`;
  }).join('');
}

function renderAudience() {
  const count = state.recipients.length;
  $('#audience-count').textContent = count ? `${count} contato${count === 1 ? '' : 's'} selecionado${count === 1 ? '' : 's'}` : 'Nenhum contato selecionado';
  $('#audience-subtitle').textContent = count ? 'Contatos salvos' : 'Adicione contatos para começar';
  $('#contacts-metric').textContent = count;
  $('#audience-footnote').textContent = count ? `${count} contato${count === 1 ? '' : 's'} pronto${count === 1 ? '' : 's'} para receber` : 'Nenhum contato cadastrado';
  $('#audience-list').innerHTML = state.recipients.slice(0, 4).map((recipient, index) => `<span class="contact-avatar a${(index % 3) + 1}">${escapeHtml((recipient.name || '?').slice(0, 2).toUpperCase())}</span>`).join('');
  $('#audience-progress-bar').style.width = `${Math.min(count * 25, 100)}%`;
  $('#publish-button').disabled = !count;
  $('#contact-list').innerHTML = state.recipients.map((recipient) => `<div class="contact-row"><span class="list-icon">♧</span><span><strong>${escapeHtml(recipient.name)}</strong><small>${escapeHtml(recipient.phone)}</small></span></div>`).join('');
  renderContactsPage();
}

function renderContactsPage() {
  const body = $('#contacts-table-body');
  if (!body) return;
  const count = state.recipients.length;
  const navCount = $('#contacts-nav-count');
  if (navCount) navCount.textContent = count;
  if (!count) {
    body.innerHTML = '<tr><td colspan="3"><div class="empty-state"><strong>Nenhum contato cadastrado</strong><span>Importe uma planilha ou adicione contatos abaixo.</span></div></td></tr>';
    return;
  }
  body.innerHTML = [...state.recipients]
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    .map((contact) => `<tr><td>${escapeHtml(contact.name)}</td><td>${escapeHtml(contact.phone)}</td><td>${escapeHtml(contact.region || 'Brasil')}</td></tr>`)
    .join('');
}

function setType(type) {
  state.type = type;
  $$('.content-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.type === type));
  $('#upload-area').classList.toggle('hidden', type === 'text');
  if (type !== 'text' && !$('#public-url')) $('#upload-area').insertAdjacentHTML('beforeend', '<label class="field-label" for="public-url">URL pública da mídia <span style="color:#9aa5aa;font-weight:400">(necessária para o Meta conectado)</span></label><input class="text-input" id="public-url" type="url" placeholder="https://cdn.seusite.com/campanha.jpg" />');
  $('#message').placeholder = type === 'text' ? 'Escreva sua mensagem...' : 'Adicione uma legenda para sua mídia...';
  updatePreview();
}

function updatePreview() {
  const message = ($('#message').value || 'Escreva uma mensagem...').replace(/\\n/g, '\n');
  $('#char-count').textContent = `${message.length} / 4096`;
  const plain = escapeHtml(message).replace(/\n/g, '<br>');
  const media = state.media ? `<div style="background:#bde5da;border-radius:5px;padding:8px;margin-bottom:6px;color:#28796c;font-size:9px">${state.type === 'video' ? '▶ Vídeo anexado' : '▧ Imagem anexada'}</div>` : '';
  const bubble = $('#preview-bubble');
  if (bubble) bubble.innerHTML = `${media}<span>${plain}</span><small>09:42 ✓✓</small>`;
}

const MAX_MESSAGE_VARIANTS = 5;

function variantLabel(index) { return index === 0 ? 'Mensagem principal' : `Variação ${index + 1}`; }

function addMessageVariant() {
  const container = $('#message-variant-list');
  const count = container.children.length;
  if (count >= MAX_MESSAGE_VARIANTS) return;
  const index = count;
  const block = document.createElement('div');
  block.className = 'message-variant';
  block.innerHTML = `<label class="field-label variant-label">${variantLabel(index)}</label>
    <div class="message-editor">
      <textarea class="variant-textarea" maxlength="4096" placeholder="Escreva outra versão da mensagem..."></textarea>
      <div class="editor-footer"><span class="variant-char-count">0 / 4096</span><button type="button" class="editor-action remove-variant" aria-label="Remover variação">×</button></div>
    </div>`;
  container.appendChild(block);
  const textarea = block.querySelector('textarea');
  textarea.addEventListener('input', () => { block.querySelector('.variant-char-count').textContent = `${textarea.value.length} / 4096`; });
  block.querySelector('.remove-variant').addEventListener('click', () => { block.remove(); renumberVariants(); });
  $('#add-message-variant').disabled = container.children.length >= MAX_MESSAGE_VARIANTS;
}

function renumberVariants() {
  const container = $('#message-variant-list');
  [...container.children].forEach((block, index) => { block.querySelector('.variant-label').textContent = variantLabel(index); });
  $('#add-message-variant').disabled = container.children.length >= MAX_MESSAGE_VARIANTS;
}

function getMessageVariants() {
  return $$('#message-variant-list .variant-textarea').map((textarea) => textarea.value.trim()).filter(Boolean);
}

function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }

async function handleFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) return toast('O arquivo precisa ter no máximo 15 MB.');
  const allowed = state.type === 'image' ? file.type.startsWith('image/') : file.type.startsWith('video/');
  if (!allowed) return toast(`Selecione um arquivo de ${state.type === 'image' ? 'imagem' : 'vídeo'}.`);
  state.media = { name: file.name, base64: await fileToDataUrl(file), mimeType: file.type };
  $('#upload-trigger').classList.add('hidden');
  $('#file-preview').classList.remove('hidden');
  $('#file-name').textContent = file.name;
  $('.file-type').textContent = state.type === 'image' ? 'IMG' : 'MP4';
  updatePreview();
}

async function loadData() {
  try {
    const [healthResponse, campaignsResponse, contactsResponse] = await Promise.all([fetch('/api/health'), fetch('/api/campaigns'), fetch('/api/contacts')]);
    if (!campaignsResponse.ok || !contactsResponse.ok) throw new Error('Sessão expirada.');
    state.health = await healthResponse.json();
    state.campaigns = await campaignsResponse.json();
    state.recipients = await contactsResponse.json();
    renderAudience();
    await loadWppNumbers();
    const aiToggle = $('#ai-personalization');
    if (aiToggle) {
      aiToggle.disabled = !state.health.ai;
      $('#ai-status').textContent = state.health.ai ? 'Token configurado no servidor' : 'Configure AI_API_KEY no .env';
    }
    $('#status-text').textContent = state.health.demoMode ? 'Modo demonstração' : 'Tudo operando';
  } catch { $('#status-text').textContent = 'Modo local'; }
  renderCampaigns();
}

async function publishCampaign() {
  const name = $('#campaign-name').value.trim();
  const messages = getMessageVariants();
  const publicUrlInput = $('#public-url');
  if (publicUrlInput && state.media) state.media.publicUrl = publicUrlInput.value.trim();
  const startAt = $('#campaign-start').value;
  const endAt = $('#campaign-end').value;
  const messageIntervalValue = $('#message-interval').value.trim();
  const messageIntervalUnit = $('#message-interval-unit').value;
  const numberIds = $$('#campaign-number-checklist input:checked').map((input) => input.value);
  if (!state.recipients.length) return toast('Adicione ao menos um contato ao público.');
  if (!name || (!messages.length && !state.media)) return toast('Preencha o nome e ao menos uma mensagem (ou mídia).');
  if (!startAt || !endAt) return toast('Informe o horário de início e término.');
  if (new Date(endAt) <= new Date(startAt)) return toast('O término precisa ser depois do início.');
  if (messageIntervalValue) {
    const value = Number(messageIntervalValue);
    if (!Number.isSafeInteger(value) || value < 1 || value > (messageIntervalUnit === 'minutes' ? 60 : 3600)) {
      return toast('Escolha de 1 a 3600 segundos ou de 1 a 60 minutos.');
    }
  }
  if (state.wppNumbers.length && !numberIds.length) return toast('Selecione ao menos um número para o disparo.');
  const button = $('#publish-button'); button.disabled = true; button.innerHTML = '<span>◌</span> Publicando...';
  try {
    const response = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type: state.type, messages, recipients: state.recipients, media: state.media, startAt, endAt, numberIds, messageIntervalValue, messageIntervalUnit, aiPersonalization: $('#ai-personalization').checked }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível criar a campanha.');
    toast(state.health.demoMode ? 'Campanha simulada com sucesso.' : 'Campanha agendada com sucesso.');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await loadData();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.innerHTML = '<span>↗</span> Publicar campanha'; }
}

function showPage(view) {
  $$('.page-view').forEach((page) => page.classList.toggle('hidden', page.id !== `${view}-page`));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  const labels = { dashboard: 'Dashboard', campaigns: 'Campanhas', whatsapp: 'WhatsApp', contacts: 'Contatos' };
  $('#breadcrumb-current').textContent = labels[view];
}

function handleContactsFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast('A planilha precisa ter no máximo 10 MB.');
  state.contactsFile = file;
  $('#contacts-file-name').textContent = file.name;
  $('#imported-file').classList.remove('hidden');
  $('#contacts-upload').classList.add('hidden');
  $('#import-contacts').disabled = false;
}

async function importContacts() {
  if (!state.contactsFile) return;
  const formData = new FormData();
  formData.append('file', state.contactsFile);
  const button = $('#import-contacts'); button.disabled = true; button.textContent = 'Importando...';
  try {
    const response = await fetch('/api/contacts/import', { method: 'POST', body: formData });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível importar os contatos.');
    state.recipients = result.contacts || [];
    renderAudience();
    if (result.numbers) { state.wppNumbers = result.numbers; renderWppNumbers(); }
    const split = (result.numbers || []).length > 1
      ? ` Dividido entre ${result.numbers.length} números: ${result.numbers.map((number) => `${escapeHtml(number.label)} (${number.contactCount})`).join(', ')}.`
      : '';
    toast(`${result.count} contato${result.count === 1 ? '' : 's'} importado${result.count === 1 ? '' : 's'}.${split}`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Importar contatos'; }
}

async function connectWppNumber(id) {
  const number = state.wppNumbers.find((item) => item.id === id);
  if (!number || state.qrPendingNumberId) return;
  state.activeQrNumberId = id;
  state.qrPendingNumberId = id;
  renderWppNumbers();
  try {
    const response = await fetch('/api/integrations/wppconnect/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: number.session }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível conectar o WhatsApp.');
    if (result.demoMode) {
      renderQr(null, true, number.label);
      return;
    }
    if (result.qrCode) {
      renderQr(result.qrCode, false, number.label);
      toast(`QR Code gerado para ${number.label}.`);
      return;
    }
    if (String(result.status).toUpperCase().includes('CONNECTED')) {
      renderConnectedNumber(number.label);
      toast(`${number.label} já está conectado.`);
      return;
    }
    renderQr(null, false, number.label);
    for (let attempt = 0; attempt < 20 && state.activeQrNumberId === id; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const qrResponse = await fetch(`/api/integrations/wppconnect/qr?session=${encodeURIComponent(number.session)}`);
      if (!qrResponse.ok) continue;
      const qr = await qrResponse.json();
      if (qr.qrCode) {
        renderQr(qr.qrCode, false, number.label);
        toast(`QR Code gerado para ${number.label}.`);
        return;
      }
      const statusResponse = await fetch(`/api/integrations/wppconnect/status?session=${encodeURIComponent(number.session)}`);
      if (statusResponse.ok && (await statusResponse.json()).connected) {
        renderConnectedNumber(number.label);
        toast(`${number.label} já está conectado.`);
        return;
      }
    }
    toast('O QR Code ainda não está pronto. Clique novamente em Gerar QR Code.');
    void checkWppStatuses();
  } catch (error) { toast(error.message); }
  finally { state.qrPendingNumberId = null; renderWppNumbers(); }
}

function renderConnectedNumber(label) {
  const container = $('#qr-placeholder');
  container.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = `${label} já está conectado`;
  const detail = document.createElement('small');
  detail.textContent = 'Para conectar outro WhatsApp, use Gerar QR Code para novo número.';
  container.append(title, detail);
}

function renderQr(qrCode, isDemo = false, label = '') {
  const container = $('#qr-placeholder');
  container.replaceChildren();
  if (qrCode && String(qrCode).startsWith('data:image/')) {
    const image = document.createElement('img');
    image.src = qrCode;
    image.alt = 'QR Code para conectar o WhatsApp';
    image.className = 'qr-image';
    const detail = document.createElement('small');
    detail.textContent = `${label ? `${label} · ` : ''}QR gerado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Se aparecer "verificar", atualize e escaneie novamente.`;
    container.append(image, detail);
    return;
  }
  const icon = document.createElement('span');
  icon.textContent = isDemo ? '✓' : '¦';
  const title = document.createElement('strong');
  title.textContent = isDemo ? 'Sessão iniciada' : 'QR Code aguardando';
  const detail = document.createElement('small');
  detail.textContent = `${label ? `${label} · ` : ''}${isDemo ? 'Modo demonstração: nenhuma conta foi conectada.' : 'Aguarde o QR Code aparecer nesta área.'}`;
  container.append(icon, title, detail);
}

async function addWppNumber() {
  const label = $('#wpp-number-label').value.trim();
  const session = $('#wpp-number-session').value.trim();
  if (!session) return toast('Informe a sessão do número.');
  const button = $('#add-wpp-number'); button.disabled = true; button.textContent = 'Adicionando...';
  try {
    const response = await fetch('/api/wpp-numbers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, session }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível adicionar o número.');
    state.wppNumbers = result.numbers;
    renderWppNumbers();
    $('#wpp-number-label').value = '';
    $('#wpp-number-session').value = '';
    toast('Número adicionado.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = '＋ Adicionar número'; }
}

async function generateNewWppQr() {
  if (state.qrPendingNumberId) return;
  let index = 1;
  while (state.wppNumbers.some((number) => (number.sessionKey || number.session) === `whatsapp-${index}`)) index += 1;
  const label = $('#wpp-number-label').value.trim() || `WhatsApp ${index}`;
  const session = $('#wpp-number-session').value.trim() || `whatsapp-${index}`;
  const button = $('#generate-wpp-qr');
  button.disabled = true;
  button.textContent = 'Gerando QR Code...';
  try {
    const response = await fetch('/api/wpp-numbers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, session })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível adicionar o número.');
    state.wppNumbers = result.numbers;
    renderWppNumbers();
    $('#wpp-number-label').value = '';
    $('#wpp-number-session').value = '';
    const number = state.wppNumbers.find((item) => (item.sessionKey || item.session) === session);
    await connectWppNumber(number.id);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = '▦ Gerar QR Code para novo número'; }
}

async function removeWppNumber(id) {
  try {
    const response = await fetch(`/api/wpp-numbers/${id}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível remover o número.');
    state.wppNumbers = result.numbers;
    delete state.wppNumberStatus[id];
    renderWppNumbers();
    const contactsResponse = await fetch('/api/contacts');
    if (contactsResponse.ok) { state.recipients = await contactsResponse.json(); renderAudience(); }
    toast('Número removido. Os contatos dele voltam a ficar sem número atribuído.');
  } catch (error) { toast(error.message); }
}

async function extractContacts() {
  const numberId = state.activeQrNumberId || state.wppNumbers[0]?.id;
  const number = state.wppNumbers.find((item) => item.id === numberId);
  if (!number) return toast('Cadastre e conecte um número do WhatsApp primeiro.');
  const button = $('#extract-contacts'); button.disabled = true; button.textContent = 'Extraindo...';
  try {
    const response = await fetch(`/api/integrations/wppconnect/contacts?session=${encodeURIComponent(number.session)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível extrair os contatos.');
    state.recipients = result.contacts || [];
    renderAudience();
    toast(result.demoMode ? 'Nenhum contato extraído no modo demonstração.' : `${result.count} contato${result.count === 1 ? '' : 's'} extraído${result.count === 1 ? '' : 's'} de ${number.label}.`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Extrair contatos do WhatsApp'; }
}

const campaignControls = document.createElement('div');
campaignControls.className = 'campaign-controls';
const aiLabel = document.createElement('label');
aiLabel.className = 'ai-option';
const aiToggle = document.createElement('input');
aiToggle.type = 'checkbox';
aiToggle.id = 'ai-personalization';
aiLabel.append(aiToggle, document.createTextNode(' Personalizar a mensagem com IA'));
const aiStatus = document.createElement('small');
aiStatus.id = 'ai-status';
aiStatus.textContent = 'Configure AI_API_KEY no .env';
campaignControls.append(aiLabel, aiStatus);
$('#publish-button').insertAdjacentElement('beforebegin', campaignControls);

const extractButton = document.createElement('button');
extractButton.type = 'button';
extractButton.id = 'extract-contacts';
extractButton.className = 'button button-primary full-width';
extractButton.textContent = 'Extrair contatos do WhatsApp';
$('#import-contacts').insertAdjacentElement('afterend', extractButton);

$$('.content-tab').forEach((tab) => tab.addEventListener('click', () => setType(tab.dataset.type)));
$('#message').addEventListener('input', updatePreview);
$('#new-campaign-button').addEventListener('click', () => { showPage('campaigns'); $('#campaign-name').focus(); });
$('#add-message-variant').addEventListener('click', addMessageVariant);
$('#publish-button').addEventListener('click', publishCampaign);
$('#upload-trigger').addEventListener('click', () => $('#media-file').click());
$('#media-file').addEventListener('change', (event) => handleFile(event.target.files[0]));
$('#remove-file').addEventListener('click', () => { state.media = null; $('#media-file').value = ''; $('#upload-trigger').classList.remove('hidden'); $('#file-preview').classList.add('hidden'); updatePreview(); });
['dragenter', 'dragover'].forEach((eventName) => $('#upload-area').addEventListener(eventName, (event) => { event.preventDefault(); $('#upload-area').classList.add('dragging'); }));
['dragleave', 'drop'].forEach((eventName) => $('#upload-area').addEventListener(eventName, (event) => { event.preventDefault(); $('#upload-area').classList.remove('dragging'); }));
$('#upload-area').addEventListener('drop', (event) => handleFile(event.dataTransfer.files[0]));
$('#open-contacts').addEventListener('click', () => $('#contacts-modal').classList.remove('hidden'));
$('#edit-audience').addEventListener('click', () => $('#contacts-modal').classList.remove('hidden'));
$('#close-contacts').addEventListener('click', () => $('#contacts-modal').classList.add('hidden'));
$('#add-contact').addEventListener('click', async () => {
  const name = $('#contact-name').value.trim();
  const phone = $('#contact-phone').value.replace(/\D/g, '');
  if (!name || phone.length < 8) return toast('Informe nome e WhatsApp com DDI.');
  if (state.recipients.some((recipient) => recipient.phone === phone)) return toast('Este contato já foi adicionado.');
  try {
    const response = await fetch('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível salvar o contato.');
    state.recipients = result.contacts;
    $('#contact-name').value = '';
    $('#contact-phone').value = '';
    renderAudience();
    toast('Contato salvo.');
  } catch (error) { toast(error.message); }
});
$('#save-contacts').addEventListener('click', () => { $('#contacts-modal').classList.add('hidden'); toast(state.recipients.length ? 'Público atualizado.' : 'Nenhum contato foi selecionado.'); });
$$('.nav-item').forEach((item) => item.addEventListener('click', () => showPage(item.dataset.view)));
$('#contacts-upload').addEventListener('click', () => $('#contacts-file').click());
$('#contacts-file').addEventListener('change', (event) => handleContactsFile(event.target.files[0]));
$('#remove-contacts-file').addEventListener('click', () => { state.contactsFile = null; $('#contacts-file').value = ''; $('#contacts-upload').classList.remove('hidden'); $('#imported-file').classList.add('hidden'); $('#import-contacts').disabled = true; });
$('#import-contacts').addEventListener('click', importContacts);
$('#extract-contacts').addEventListener('click', extractContacts);
$('#add-wpp-number').addEventListener('click', addWppNumber);
$('#generate-wpp-qr').addEventListener('click', generateNewWppQr);
$('#wpp-number-list').addEventListener('click', (event) => {
  const row = event.target.closest('.wpp-number-row');
  if (!row) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'connect') connectWppNumber(row.dataset.id);
  if (action === 'remove') removeWppNumber(row.dataset.id);
});
if ($('#message').value.includes('\\n')) $('#message').value = $('#message').value.replace(/\\n/g, '\n');
renderAudience(); updatePreview(); initializeAuth();
