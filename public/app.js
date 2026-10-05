const state = {
  type: 'text',
  recipients: [],
  contacts: [],
  contactGroups: [],
  importGroupMode: 'existing',
  importExistingGroupId: '',
  selectedContactsGroupId: 'all',
  selectedCampaignGroupId: '',
  campaignSenderNumberId: '',
  media: null,
  campaigns: [],
  campaignNumberRows: [],
  health: { demoMode: true },
  contactsFile: null,
  wppNumbers: [],
  wppNumberStatus: {},
  activeQrNumberId: null,
  qrPendingNumberId: null,
  editingCampaignId: null,
  pendingPublishRequestId: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const toast = (message) => {
  const element = $('#toast');
  if (!element) { console.error('Elemento de aviso não encontrado:', message); return; }
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 5000);
};
let wppStatusTimer = null;
let dashboardPollTimer = null;
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

const KNOWN_PAGES = ['dashboard', 'campaigns', 'whatsapp', 'contacts'];

function showApp(user) {
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#current-user-name').textContent = user.name;
  let savedPage = 'dashboard';
  try { savedPage = localStorage.getItem('currentPage') || 'dashboard'; } catch { /* armazenamento indisponível */ }
  showPage(KNOWN_PAGES.includes(savedPage) ? savedPage : 'dashboard');
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
      const status = state.wppNumberStatus[number.id];
      const connected = status === true;
      const checking = status === undefined;
      const unavailable = status === null;
      const pending = state.qrPendingNumberId === number.id;
      const statusLabel = connected ? 'Conectado' : checking ? 'Verificando...' : unavailable ? 'Verificação indisponível' : 'Não conectado';
      const buttonLabel = connected ? 'Conectado' : pending ? 'Gerando...' : checking ? 'Verificando...' : unavailable ? 'Tentar novamente em instantes' : 'Gerar QR Code';
      return `<div class="wpp-number-row" data-id="${number.id}">
        <div class="service-logo whatsapp-logo mini">◌</div>
        <div><strong>${escapeHtml(number.label)}</strong><small>sessão: ${escapeHtml(number.sessionKey || number.session)} · ${number.contactCount || 0} contato${number.contactCount === 1 ? '' : 's'}</small></div>
        <span class="integration-badge ${connected ? 'connected' : 'pending'}"><i></i> ${statusLabel}</span>
        <button class="button button-secondary" data-action="connect" type="button" ${connected || pending || checking || unavailable ? 'disabled' : ''}>${buttonLabel}</button>
        <button class="icon-button" data-action="remove" type="button" aria-label="Remover número">×</button>
      </div>`;
    }).join('');
  }
  const anyConnected = state.wppNumbers.some((number) => state.wppNumberStatus[number.id]);
  const anyChecking = state.wppNumbers.some((number) => state.wppNumberStatus[number.id] === undefined);
  const anyUnavailable = state.wppNumbers.some((number) => state.wppNumberStatus[number.id] === null);
  const pageStatus = anyConnected ? 'Conectado' : anyChecking ? 'Verificando...' : anyUnavailable ? 'Verificação indisponível' : 'Não conectado';
  const pageBadge = $('#whatsapp-page .integration-badge');
  if (pageBadge) {
    pageBadge.classList.toggle('pending', !anyConnected);
    pageBadge.classList.toggle('connected', anyConnected);
    pageBadge.innerHTML = `<i></i> ${pageStatus}`;
  }
  const previewStatus = $('#preview-whatsapp-status');
  if (previewStatus) previewStatus.textContent = anyConnected ? 'conectado' : anyChecking ? 'verificando' : anyUnavailable ? 'verificação indisponível' : 'não conectado';
  renderNumberChecklist();
  renderContactsPage();
}

function renderNumberChecklist() {
  const container = $('#campaign-number-checklist');
  if (!container) return;
  if (!state.wppNumbers.length) {
    container.innerHTML = '<div class="empty-state"><strong>Nenhum número cadastrado</strong><span>Cadastre um número na aba WhatsApp antes de criar uma campanha.</span></div>';
    renderSendEstimate();
    return;
  }
  const numberIds = new Set(state.wppNumbers.map((number) => number.id));
  state.recipients.forEach((recipient, index) => {
    if (!numberIds.has(recipient.wppNumberId)) recipient.wppNumberId = state.wppNumbers[index % state.wppNumbers.length].id;
  });
  const counts = new Map(state.wppNumbers.map((number) => [number.id, 0]));
  state.recipients.forEach((recipient) => counts.set(recipient.wppNumberId, (counts.get(recipient.wppNumberId) || 0) + 1));
  container.innerHTML = state.wppNumbers.map((number) => `
    <div class="number-check-row">
      <span><strong>${escapeHtml(number.label)}</strong><small>${escapeHtml(number.sessionKey || number.session)}</small></span>
      <span class="assigned-contact-count">${counts.get(number.id)} contato${counts.get(number.id) === 1 ? '' : 's'}</span>
    </div>
  `).join('');
  renderSendEstimate();
}

function renderContactGroupSelectors() {
  const options = state.contactGroups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)} (${group.contactCount})</option>`).join('');
  const contactsFilter = $('#contacts-group-filter');
  if (contactsFilter) {
    contactsFilter.innerHTML = `<option value="all">Todos os grupos (${state.contacts.length})</option>${options}`;
    contactsFilter.value = state.selectedContactsGroupId;
    if (contactsFilter.value !== state.selectedContactsGroupId) state.selectedContactsGroupId = 'all';
  }
  const campaignGroup = $('#campaign-group-select');
  if (campaignGroup) {
    campaignGroup.innerHTML = `<option value="">Selecione um grupo</option><option value="all">Todos os contatos (${state.contacts.length})</option>${options}`;
    campaignGroup.value = state.selectedCampaignGroupId;
    if (campaignGroup.value !== state.selectedCampaignGroupId) state.selectedCampaignGroupId = '';
  }
  const campaignSender = $('#campaign-sender-number');
  if (campaignSender) {
    campaignSender.innerHTML = `<option value="">Escolha o número de envio</option>${state.wppNumbers.map((number) => `<option value="${escapeHtml(number.id)}">${escapeHtml(number.label)}</option>`).join('')}`;
    campaignSender.value = state.campaignSenderNumberId;
    if (campaignSender.value !== state.campaignSenderNumberId) state.campaignSenderNumberId = '';
  }
  const importMode = $('#contacts-import-mode');
  const existingGroup = $('#contacts-existing-group');
  const existingField = $('#contacts-existing-group-field');
  const newField = $('#contacts-new-group-field');
  if (importMode && existingGroup && existingField && newField) {
    existingGroup.innerHTML = state.contactGroups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)} (${group.contactCount})</option>`).join('');
    if (!state.contactGroups.length) state.importGroupMode = 'new';
    if (state.importGroupMode === 'existing' && !state.importExistingGroupId && state.contactGroups.length) {
      state.importExistingGroupId = state.contactGroups[0].id;
    }
    importMode.value = state.importGroupMode;
    existingGroup.value = state.importExistingGroupId;
    if (existingGroup.value !== state.importExistingGroupId && state.contactGroups.length) {
      state.importExistingGroupId = state.contactGroups[0].id;
      existingGroup.value = state.importExistingGroupId;
    }
    existingField.classList.toggle('hidden', state.importGroupMode !== 'existing');
    newField.classList.toggle('hidden', state.importGroupMode !== 'new');
    importMode.disabled = !state.contactGroups.length;
  }
}

function setCampaignGroup(groupId) {
  state.selectedCampaignGroupId = groupId;
  state.recipients = state.contacts
    .filter((contact) => !groupId || groupId === 'all' || (contact.groupIds || []).includes(groupId))
    .map((contact) => ({ ...contact, ...(state.campaignSenderNumberId ? { wppNumberId: state.campaignSenderNumberId } : {}) }));
  renderAudience();
}

function setCampaignSender(numberId) {
  state.campaignSenderNumberId = numberId;
  if (numberId) state.recipients.forEach((recipient) => { recipient.wppNumberId = numberId; });
  renderAudience();
}
const BURST_LIMIT = 40;
const BURST_PAUSE_MS = 15 * 60 * 1000;

function computeSendEstimate() {
  const totalContacts = state.recipients.length;
  if (!totalContacts) return { status: 'empty' };

  const intervalRaw = $('#message-interval').value.trim();
  if (!intervalRaw) return { status: 'missing-interval' };
  const intervalValue = Number(intervalRaw);
  const intervalUnit = $('#message-interval-unit').value;
  if (!Number.isFinite(intervalValue) || intervalValue < 1) return { status: 'invalid-interval' };

  const counts = new Map(state.wppNumbers.map((number) => [number.id, 0]));
  state.recipients.forEach((recipient) => {
    if (recipient.wppNumberId && counts.has(recipient.wppNumberId)) counts.set(recipient.wppNumberId, counts.get(recipient.wppNumberId) + 1);
  });
  const contactsPerLane = Math.max(0, ...counts.values());
  const laneCount = [...counts.values()].filter((count) => count > 0).length || 1;
  const delayMs = intervalValue * (intervalUnit === 'minutes' ? 60000 : 1000);
  const breaks = Math.floor(Math.max(0, contactsPerLane - 1) / BURST_LIMIT);
  const estimatedMs = Math.max(0, contactsPerLane - 1) * delayMs + breaks * BURST_PAUSE_MS;
  return { status: 'ok', totalContacts, laneCount, contactsPerLane, estimatedMs };
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.ceil(milliseconds / 60000);
  if (totalMinutes < 1) return 'menos de 1 minuto';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [
    days ? `${days} dia${days === 1 ? '' : 's'}` : '',
    hours ? `${hours} hora${hours === 1 ? '' : 's'}` : '',
    minutes ? `${minutes} minuto${minutes === 1 ? '' : 's'}` : ''
  ].filter(Boolean).join(' e ');
}

function renderSendEstimate() {
  const box = $('#send-estimate');
  if (!box) return;
  const estimate = computeSendEstimate();
  box.classList.remove('warning');
  if (estimate.status === 'empty') {
    box.innerHTML = '<p>Adicione contatos ao público para calcular a previsão de envio.</p>';
    return;
  }
  if (estimate.status === 'missing-interval') {
    box.innerHTML = '<p>Informe o intervalo entre mensagens para calcular a previsão.</p>';
    return;
  }
  if (estimate.status === 'invalid-interval') {
    box.innerHTML = '<p>Informe um intervalo válido entre mensagens.</p>';
    return;
  }
  const { totalContacts, laneCount, contactsPerLane, estimatedMs } = estimate;
  const laneNote = laneCount > 1
    ? `Dividido entre ${laneCount} números: cada um envia cerca de ${contactsPerLane} contato${contactsPerLane === 1 ? '' : 's'}.`
    : 'Conecte mais números para dividir o envio entre eles.';
  box.classList.toggle('warning', estimatedMs > 24 * 60 * 60 * 1000);
  box.innerHTML = `<strong>Previsão: ${formatDuration(estimatedMs)}</strong><p>${totalContacts} contato${totalContacts === 1 ? '' : 's'} · disparos podem iniciar a qualquer horário.</p><p>${laneNote}</p><p>A cada ${BURST_LIMIT} mensagens, cada número pausa 15 minutos automaticamente.</p>`;
}
async function checkWppStatuses() {
  if (state.health.demoMode || !state.wppNumbers.length) return;
  await Promise.all(state.wppNumbers.map(async (number) => {
    try {
      const response = await fetch(`/api/integrations/wppconnect/status?session=${encodeURIComponent(number.session)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível consultar o WhatsApp.');
      state.wppNumberStatus[number.id] = result.connected === true;
    } catch { state.wppNumberStatus[number.id] = null; }
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
  renderAudience();
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
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function recipientStatusLabel(status) {
  return { pending: 'Pendente', sent: 'Enviada', delivered: 'Entregue', read: 'Lida', replied: 'Respondida', failed: 'Falhou' }[status] || status;
}

async function loadCampaignNumberStats() {
  try {
    const response = await fetch('/api/dashboard/campaign-numbers');
    state.campaignNumberRows = response.ok ? await response.json() : [];
  } catch { state.campaignNumberRows = []; }
  renderCampaignNumberTable();
}

function startDashboardPolling() {
  if (dashboardPollTimer) clearInterval(dashboardPollTimer);
  dashboardPollTimer = setInterval(loadCampaignNumberStats, 10000);
}

function campaignActionButtonsHtml(status) {
  const buttons = [];
  if (status === 'paused' || status === 'error') {
    buttons.push('<button class="icon-button" data-action="resume" type="button" aria-label="Retomar campanha" title="Retomar">▶</button>');
  } else if (status === 'scheduled' || status === 'sending') {
    buttons.push('<button class="icon-button" data-action="pause" type="button" aria-label="Pausar campanha" title="Pausar">❚❚</button>');
  }
  if (status === 'scheduled' || status === 'paused') {
    buttons.push('<button class="icon-button" data-action="edit" type="button" aria-label="Editar campanha" title="Editar">✎</button>');
  }
  buttons.push('<button class="icon-button danger" data-action="delete" type="button" aria-label="Excluir campanha" title="Excluir">×</button>');
  return buttons.join('');
}

function renderCampaignNumberTable() {
  const body = $('#campaign-number-table-body');
  if (!body) return;
  const rows = state.campaignNumberRows;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state"><strong>Nenhum disparo registrado</strong><span>Assim que uma campanha começar a enviar, o histórico por número aparece aqui.</span></div></td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => {
    const lastActivity = row.lastRepliedAt || row.lastReadAt || row.lastDeliveredAt || row.lastSentAt;
    return `<tr class="clickable-row" data-campaign-id="${row.campaignId}" data-number-id="${row.wppNumberId || ''}">
      <td>${escapeHtml(row.numberLabel)}</td>
      <td><div class="campaign-name-cell"><span>${escapeHtml(row.campaignName)}</span><span class="status-pill status-${row.campaignStatus}">${escapeHtml(row.campaignStatusLabel || row.campaignStatus)}</span></div></td>
      <td>${row.sentCount}${row.lastSentAt ? `<small class="cell-caption">${formatDateTime(row.lastSentAt)}</small>` : ''}</td>
      <td>${row.deliveredCount}${row.lastDeliveredAt ? `<small class="cell-caption">${formatDateTime(row.lastDeliveredAt)}</small>` : ''}</td>
      <td>${row.repliedCount}${row.lastRepliedAt ? `<small class="cell-caption">${formatDateTime(row.lastRepliedAt)}</small>` : ''}</td>
      <td>${formatDateTime(lastActivity)}</td>
      <td><div class="row-actions">${campaignActionButtonsHtml(row.campaignStatus)}</div></td>
    </tr>`;
  }).join('');
}

async function openCampaignDetail(campaignId, numberId) {
  try {
    const url = `/api/campaigns/${campaignId}/recipients${numberId ? `?numberId=${encodeURIComponent(numberId)}` : ''}`;
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível carregar os detalhes.');
    $('#campaign-detail-title').textContent = result.campaign.name;
    $('#campaign-detail-subtitle').textContent = `${result.recipients.length} contato${result.recipients.length === 1 ? '' : 's'} nesta visão · somente leitura`;
    const summary = { delivered: 0, replied: 0, failed: 0 };
    result.recipients.forEach((recipient) => {
      if (recipient.deliveredAt) summary.delivered += 1;
      if (recipient.repliedAt) summary.replied += 1;
      if (recipient.status === 'failed') summary.failed += 1;
    });
    $('#campaign-detail-summary').innerHTML = `
      <span class="stat-chip">${summary.delivered} entregue${summary.delivered === 1 ? '' : 's'}</span>
      <span class="stat-chip">${summary.replied} respondida${summary.replied === 1 ? '' : 's'}</span>
      ${summary.failed ? `<span class="stat-chip warn">${summary.failed} falhou${summary.failed === 1 ? '' : 'ram'}</span>` : ''}
    `;
    $('#campaign-detail-body').innerHTML = result.recipients.map((recipient) => `<tr>
      <td>${escapeHtml(recipient.name || 'Contato')}</td>
      <td>${escapeHtml(recipient.phone)}</td>
      <td><span class="status-pill status-${recipient.status}">${recipientStatusLabel(recipient.status)}</span></td>
      <td>${formatDateTime(recipient.sentAt)}</td>
      <td>${formatDateTime(recipient.deliveredAt)}</td>
      <td>${formatDateTime(recipient.repliedAt)}</td>
    </tr>`).join('') || '<tr><td colspan="6"><div class="empty-state"><strong>Sem contatos nesta visão</strong></div></td></tr>';
    $('#campaign-detail-modal').classList.remove('hidden');
  } catch (error) { toast(error.message); }
}

async function pauseCampaign(id) {
  try {
    const response = await fetch(`/api/campaigns/${id}/pause`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível pausar a campanha.');
    toast('Campanha pausada.');
    await loadCampaignNumberStats();
  } catch (error) { toast(error.message); }
}

async function resumeCampaign(id) {
  try {
    const response = await fetch(`/api/campaigns/${id}/resume`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível retomar a campanha.');
    toast('Campanha retomada.');
    await loadCampaignNumberStats();
  } catch (error) { toast(error.message); }
}

async function deleteCampaign(id) {
  if (!confirm('Excluir esta campanha? Essa ação não pode ser desfeita.')) return;
  try {
    const response = await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível excluir a campanha.');
    if (state.editingCampaignId === id) cancelEditCampaign();
    toast('Campanha excluída.');
    await loadCampaignNumberStats();
    await loadData();
  } catch (error) { toast(error.message); }
}

function cancelEditCampaign() {
  state.editingCampaignId = null;
  state.selectedCampaignGroupId = '';
  state.campaignSenderNumberId = '';
  state.recipients = [];
  renderAudience();
  $('#composer-title').textContent = 'Nova campanha';
  $('#composer-subtitle').textContent = 'Configure o disparo e publique quando estiver pronto.';
  $('#cancel-edit-campaign').classList.add('hidden');
  $('#publish-button').innerHTML = '<span>↗</span> Publicar campanha';
}

function toDatetimeLocalValue(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function minutesToTimeValue(minutes) {
  const hours = Math.floor((minutes || 0) / 60);
  const mins = (minutes || 0) % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function setMessageVariants(messages) {
  const container = $('#message-variant-list');
  while (container.children.length > 1) container.lastElementChild.remove();
  const list = messages && messages.length ? messages : [''];
  const firstTextarea = $('#message');
  firstTextarea.value = list[0] || '';
  firstTextarea.dispatchEvent(new Event('input', { bubbles: true }));
  for (let index = 1; index < list.length; index += 1) {
    addMessageVariant();
    const textareas = $$('#message-variant-list .variant-textarea');
    textareas[textareas.length - 1].value = list[index];
    textareas[textareas.length - 1].dispatchEvent(new Event('input', { bubbles: true }));
  }
}

async function editCampaign(id) {
  try {
    const response = await fetch(`/api/campaigns/${id}`);
    const campaign = await response.json();
    if (!response.ok) throw new Error(campaign.error || 'Não foi possível carregar a campanha.');
    if (!['scheduled', 'paused'].includes(campaign.status)) {
      return toast('Só é possível editar campanhas agendadas ou pausadas.');
    }
    showPage('campaigns');
    setType(campaign.type || 'text');
    $('#campaign-name').value = campaign.name || '';
    setMessageVariants(campaign.messages && campaign.messages.length ? campaign.messages : [campaign.message || '']);
    state.media = campaign.media || null;
    if (state.media) {
      $('#upload-trigger').classList.add('hidden');
      $('#file-preview').classList.remove('hidden');
      $('#file-name').textContent = state.media.name || 'arquivo selecionado';
      $('.file-type').textContent = campaign.type === 'image' ? 'IMG' : 'MP4';
    } else {
      $('#media-file').value = '';
      $('#upload-trigger').classList.remove('hidden');
      $('#file-preview').classList.add('hidden');
    }
    const publicUrlInput = $('#public-url');
    if (publicUrlInput) publicUrlInput.value = state.media?.publicUrl || '';
    updatePreview();
    $('#campaign-start').value = toDatetimeLocalValue(campaign.scheduledAt);
    const delayMs = campaign.delayMs || 3000;
    if (delayMs % 60000 === 0 && delayMs / 60000 <= 60) {
      $('#message-interval-unit').value = 'minutes';
      $('#message-interval').value = String(delayMs / 60000);
    } else {
      $('#message-interval-unit').value = 'seconds';
      $('#message-interval').value = String(Math.round(delayMs / 1000));
    }
    state.recipients = (campaign.recipients || []).map((recipient) => ({ ...recipient }));
    state.selectedCampaignGroupId = campaign.groupId
      ? (state.contactGroups.some((group) => group.id === campaign.groupId) ? campaign.groupId : '')
      : 'all';
    const campaignSenders = [...new Set(state.recipients.map((recipient) => recipient.wppNumberId).filter(Boolean))];
    state.campaignSenderNumberId = campaignSenders.length === 1 ? campaignSenders[0] : '';
    renderAudience();
    renderSendEstimate();
    state.editingCampaignId = campaign.id;
    $('#composer-title').textContent = 'Editar campanha';
    $('#composer-subtitle').textContent = 'Altere o disparo e salve para atualizar a campanha.';
    $('#cancel-edit-campaign').classList.remove('hidden');
    $('#publish-button').innerHTML = '<span>✎</span> Salvar alterações';
    $('#campaign-name').focus();
  } catch (error) { toast(error.message); }
}

function renderAudience() {
  const count = state.recipients.length;
  renderContactGroupSelectors();
  renderNumberChecklist();
  $('#audience-count').textContent = count ? `${count} contato${count === 1 ? '' : 's'} selecionado${count === 1 ? '' : 's'}` : 'Nenhum contato selecionado';
  $('#audience-subtitle').textContent = count ? 'Público desta campanha' : 'Adicione contatos para começar';
  $('#contacts-metric').textContent = state.contacts.length;
  $('#audience-footnote').textContent = count ? `${count} contato${count === 1 ? '' : 's'} pronto${count === 1 ? '' : 's'} para receber` : 'Nenhum contato cadastrado';
  $('#audience-list').innerHTML = state.recipients.slice(0, 4).map((recipient, index) => `<span class="contact-avatar a${(index % 3) + 1}">${escapeHtml((recipient.name || '?').slice(0, 2).toUpperCase())}</span>`).join('');
  $('#audience-progress-bar').style.width = `${Math.min(count * 25, 100)}%`;
  $('#publish-button').disabled = !count;
  const numberOptions = state.wppNumbers.map((number) => `<option value="${escapeHtml(number.id)}">${escapeHtml(number.label)}</option>`).join('');
  const selectedByPhone = new Map(state.recipients.map((recipient, index) => [recipient.phone, { recipient, index }]));
  const modalContacts = state.contacts.filter((contact) => !state.selectedCampaignGroupId || state.selectedCampaignGroupId === 'all' || (contact.groupIds || []).includes(state.selectedCampaignGroupId));
  const modalPhones = new Set(modalContacts.map((contact) => contact.phone));
  state.recipients.forEach((recipient) => {
    if (!modalPhones.has(recipient.phone)) {
      modalContacts.push(recipient);
      modalPhones.add(recipient.phone);
    }
  });
  $('#contact-list').innerHTML = modalContacts.map((contact) => {
    const selected = selectedByPhone.get(contact.phone);
    const recipient = selected?.recipient || contact;
    const index = selected?.index ?? -1;
    return `
    <div class="contact-row">
      <label class="contact-audience-toggle"><input type="checkbox" data-recipient-selected="${escapeHtml(contact.phone)}" ${selected ? 'checked' : ''} /><span>Incluir</span></label>
      <span class="list-icon">♧</span>
      <span class="contact-row-details"><strong>${escapeHtml(recipient.name)}</strong><small>${escapeHtml(recipient.phone)}</small></span>
      <label class="contact-sender-field"><span>Enviar por</span><select class="text-input contact-sender-select" data-recipient-sender="${index}" aria-label="Celular para ${escapeHtml(recipient.name)}" ${selected ? '' : 'disabled'}>
        <option value="">Selecione um celular</option>${numberOptions}
      </select></label>
    </div>`;
  }).join('');
  $$('#contact-list [data-recipient-sender]').forEach((select) => {
    select.value = state.recipients[Number(select.dataset.recipientSender)]?.wppNumberId || '';
  });
  renderContactsPage();
  renderSendEstimate();
}
function renderContactsPage() {
  const body = $('#contacts-table-body');
  if (!body) return;
  const count = state.contacts.length;
  const navCount = $('#contacts-nav-count');
  if (navCount) navCount.textContent = count;
  const visibleContacts = state.contacts.filter((contact) => state.selectedContactsGroupId === 'all' || (contact.groupIds || []).includes(state.selectedContactsGroupId));
  if (!visibleContacts.length) {
    body.innerHTML = '<tr><td colspan="4"><div class="empty-state"><strong>Nenhum contato neste grupo</strong><span>Escolha outro grupo ou importe uma planilha para cá.</span></div></td></tr>';
    return;
  }
  body.innerHTML = visibleContacts
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    .map((contact) => {
      const groupNames = state.contactGroups.filter((group) => (contact.groupIds || []).includes(group.id)).map((group) => group.name).join(', ');
      return `<tr><td>${escapeHtml(contact.name)}</td><td>${escapeHtml(contact.phone)}</td><td>${escapeHtml(contact.region || 'Brasil')}</td><td>${escapeHtml(groupNames || '—')}</td></tr>`;
    })
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
      <div class="editor-footer"><span class="variant-char-count">0 / 4096</span><div><button class="editor-action insert-variable" type="button" data-variable="nome">{{nome}}</button><button class="editor-action insert-variable" type="button" data-variable="regiao">{{regiao}}</button><button type="button" class="editor-action remove-variant" aria-label="Remover variação">×</button></div></div>
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

function insertVariable(textarea, token) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.setRangeText(token, start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}

$('#message-variant-list').addEventListener('click', (event) => {
  const button = event.target.closest('.insert-variable');
  if (!button) return;
  const textarea = button.closest('.message-editor').querySelector('textarea');
  insertVariable(textarea, `{{${button.dataset.variable}}}`);
});

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
    const [healthResponse, campaignsResponse, contactsResponse, groupsResponse] = await Promise.all([fetch('/api/health'), fetch('/api/campaigns'), fetch('/api/contacts'), fetch('/api/contact-groups')]);
    if (!campaignsResponse.ok || !contactsResponse.ok || !groupsResponse.ok) throw new Error('Sessão expirada.');
    state.health = await healthResponse.json();
    state.campaigns = await campaignsResponse.json();
    state.contacts = await contactsResponse.json();
    state.contactGroups = await groupsResponse.json();
    state.importGroupMode = state.contactGroups.length ? 'existing' : 'new';
    state.importExistingGroupId = state.contactGroups[0]?.id || '';
    state.selectedCampaignGroupId = '';
    state.campaignSenderNumberId = '';
    state.recipients = [];
    renderAudience();
    await loadWppNumbers();
    await loadCampaignNumberStats();
    startDashboardPolling();
  } catch { /* falha ao carregar dados iniciais; a página segue com o estado padrão */ }
  renderCampaigns();
}

async function createCampaignWithRetry(payload) {
  const requestId = state.pendingPublishRequestId || crypto.randomUUID();
  state.pendingPublishRequestId = requestId;
  const retryDelays = [0, 1000, 2500];

  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    let response;
    try {
      response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId })
      });
    } catch {
      if (attempt < retryDelays.length - 1) continue;
      throw new Error('A internet oscilou durante a publicação. Quando a conexão voltar, clique novamente; a campanha não será duplicada.');
    }

    const result = await response.json().catch(() => ({}));
    if (response.ok) {
      state.pendingPublishRequestId = null;
      return result;
    }
    if ([502, 503, 504].includes(response.status) && attempt < retryDelays.length - 1) continue;
    state.pendingPublishRequestId = null;
    throw new Error(result.error || 'Não foi possível criar a campanha.');
  }
  throw new Error('Não foi possível criar a campanha.');
}

async function publishCampaign() {
  const name = $('#campaign-name').value.trim();
  const messages = getMessageVariants();
  const publicUrlInput = $('#public-url');
  if (publicUrlInput && state.media) state.media.publicUrl = publicUrlInput.value.trim();
  const startAtInput = $('#campaign-start').value;
  const messageIntervalValue = $('#message-interval').value.trim();
  const messageIntervalUnit = $('#message-interval-unit').value;
  const numberIds = [...new Set(state.recipients.map((recipient) => recipient.wppNumberId).filter(Boolean))];
  if (!state.recipients.length) return toast('Adicione ao menos um contato ao público.');
  if (!state.selectedCampaignGroupId) return toast('Selecione o grupo de pessoas que receberá a campanha.');
  if (!name || (!messages.length && !state.media)) return toast('Preencha o nome e ao menos uma mensagem (ou mídia).');
  if (state.type !== 'text' && !state.media?.base64) return toast(`Envie o arquivo de ${state.type === 'image' ? 'imagem' : 'vídeo'} da campanha.`);
  if (!startAtInput) return toast('Informe a data e hora de início da campanha.');
  if (!messageIntervalValue) return toast('Informe o intervalo entre mensagens.');
  const intervalValue = Number(messageIntervalValue);
  if (!Number.isSafeInteger(intervalValue) || intervalValue < 1 || intervalValue > (messageIntervalUnit === 'minutes' ? 60 : 3600)) {
    return toast('Escolha de 1 a 3600 segundos ou de 1 a 60 minutos.');
  }
  if (!state.wppNumbers.length || state.recipients.some((recipient) => !recipient.wppNumberId)) return toast('Escolha um celular para cada contato do público.');
  if (!state.campaignSenderNumberId) return toast('Escolha o grupo e o número remetente da campanha.');
  const startDate = new Date(startAtInput);
  if (Number.isNaN(startDate.getTime())) return toast('Informe uma data e hora de início válida.');
  const startAt = startDate.toISOString();
  const estimate = computeSendEstimate();
  const editingId = state.editingCampaignId;
  const button = $('#publish-button'); button.disabled = true; button.innerHTML = editingId ? '<span>◌</span> Salvando...' : '<span>◌</span> Publicando...';
  try {
    const payload = { name, type: state.type, messages, recipients: state.recipients, media: state.media, startAt, numberIds, groupId: state.selectedCampaignGroupId !== 'all' ? state.selectedCampaignGroupId : null, messageIntervalValue, messageIntervalUnit };
    let result;
    if (editingId) {
      const response = await fetch(`/api/campaigns/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível salvar a campanha.');
    } else {
      result = await createCampaignWithRetry(payload);
    }
    if (editingId) {
      cancelEditCampaign();
      toast('Campanha atualizada.');
    } else {
      const forecast = estimate.status === 'ok' ? ` Previsão: ${formatDuration(estimate.estimatedMs)} para concluir o público.` : '';
      toast((state.health.demoMode ? 'Campanha simulada com sucesso.' : 'Campanha agendada com sucesso.') + forecast);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await loadData();
  } catch (error) { toast(error.message); }
  finally {
    button.disabled = false;
    button.innerHTML = state.editingCampaignId ? '<span>✎</span> Salvar alterações' : '<span>↗</span> Publicar campanha';
  }
}

function showPage(view) {
  $$('.page-view').forEach((page) => page.classList.toggle('hidden', page.id !== `${view}-page`));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  const labels = { dashboard: 'Dashboard', campaigns: 'Campanhas', whatsapp: 'WhatsApp', contacts: 'Contatos' };
  $('#breadcrumb-current').textContent = labels[view];
  try { localStorage.setItem('currentPage', view); } catch { /* armazenamento indisponível */ }
}

function handleContactsFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast('A planilha precisa ter no máximo 10 MB.');
  const groupInput = $('#contacts-new-group-name');
  const previousFileGroupName = state.contactsFile?.name.replace(/\.[^.]+$/, '').slice(0, 80) || '';
  if (state.importGroupMode === 'new' && (!groupInput.value.trim() || groupInput.value === previousFileGroupName)) groupInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
  state.contactsFile = file;
  $('#contacts-file-name').textContent = file.name;
  $('#imported-file').classList.remove('hidden');
  $('#contacts-upload').classList.add('hidden');
  $('#import-contacts').disabled = false;
}

async function importContacts() {
  if (!state.contactsFile) return;
  const groupName = $('#contacts-new-group-name').value.trim();
  const groupId = $('#contacts-existing-group').value;
  if (state.importGroupMode === 'existing' && !groupId) return toast('Escolha o grupo que receberá estes contatos.');
  if (state.importGroupMode === 'new' && !groupName) return toast('Informe um nome para o novo grupo.');
  const previousRecipients = new Map(state.recipients.map((recipient) => [recipient.phone, recipient]));
  const formData = new FormData();
  formData.append('file', state.contactsFile);
  if (state.importGroupMode === 'existing') formData.append('groupId', groupId);
  else formData.append('groupName', groupName);
  const button = $('#import-contacts'); button.disabled = true; button.textContent = 'Importando...';
  try {
    const response = await fetch('/api/contacts/import', { method: 'POST', body: formData });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível importar os contatos.');
    state.contacts = result.contacts || [];
    state.contactGroups = result.groups || state.contactGroups;
    if (state.importGroupMode === 'new' && result.group?.id) {
      state.importGroupMode = 'new';
      state.importExistingGroupId = result.group.id;
      $('#contacts-new-group-name').value = '';
    } else if (result.group?.id) {
      state.importExistingGroupId = result.group.id;
    }
    state.selectedContactsGroupId = result.group?.id || 'all';
    state.recipients = state.selectedCampaignGroupId
      ? state.contacts
        .filter((contact) => state.selectedCampaignGroupId === 'all' || previousRecipients.has(contact.phone))
        .filter((contact) => state.selectedCampaignGroupId === 'all' || (contact.groupIds || []).includes(state.selectedCampaignGroupId))
        .map((contact) => ({ ...contact, wppNumberId: previousRecipients.get(contact.phone)?.wppNumberId || state.campaignSenderNumberId || contact.wppNumberId }))
      : [];
    renderAudience();
    if (result.numbers) { state.wppNumbers = result.numbers; renderWppNumbers(); }
    renderAudience();
    const split = (result.numbers || []).length > 1
      ? ` Dividido entre ${result.numbers.length} números: ${result.numbers.map((number) => `${escapeHtml(number.label)} (${number.contactCount})`).join(', ')}.`
      : '';
    const skippedNote = result.skipped ? ` ${result.skipped} já estavam na base e foram ignorados.` : '';
    toast(`${result.count} contato${result.count === 1 ? '' : 's'} adicionado${result.count === 1 ? '' : 's'} ao grupo ${result.group?.name || groupName}.${skippedNote}${split}`);
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
    renderAudience();
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
    renderAudience();
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
    if (contactsResponse.ok) {
      state.contacts = await contactsResponse.json();
      state.recipients = state.selectedCampaignGroupId
        ? state.contacts.filter((contact) => state.selectedCampaignGroupId === 'all' || (contact.groupIds || []).includes(state.selectedCampaignGroupId)).map((contact) => ({ ...contact }))
        : [];
      renderAudience();
    }
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
    state.contacts = result.contacts || [];
    state.contactGroups = result.groups || state.contactGroups;
    state.selectedContactsGroupId = result.group?.id || state.selectedContactsGroupId;
    state.recipients = state.selectedCampaignGroupId
      ? state.contacts.filter((contact) => state.selectedCampaignGroupId === 'all' || (contact.groupIds || []).includes(state.selectedCampaignGroupId)).map((contact) => ({ ...contact }))
      : [];
    renderAudience();
    toast(result.demoMode ? 'Nenhum contato extraído no modo demonstração.' : `${result.count} contato${result.count === 1 ? '' : 's'} extraído${result.count === 1 ? '' : 's'} de ${number.label}.`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Extrair contatos do WhatsApp'; }
}

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
$('#send-test-button').addEventListener('click', async () => {
  const phone = $('#test-phone').value.replace(/\D/g, '');
  if (phone.length < 8) return toast('Informe um WhatsApp válido com DDI.');
  const message = getMessageVariants()[0] || '';
  const publicUrlInput = $('#public-url');
  if (publicUrlInput && state.media) state.media.publicUrl = publicUrlInput.value.trim();
  if (!message && !state.media) return toast('Escreva uma mensagem ou anexe uma mídia para testar.');
  const checkedNumberIds = [...new Set(state.recipients.map((recipient) => recipient.wppNumberId).filter(Boolean))];
  const numberId = checkedNumberIds[0] || state.wppNumbers[0]?.id;
  if (!numberId) return toast('Cadastre um número do WhatsApp antes de testar.');
  const button = $('#send-test-button'); button.disabled = true; button.textContent = 'Enviando...';
  try {
    const response = await fetch('/api/campaigns/test-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: state.type, message, media: state.media, numberId, phone }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível enviar o teste.');
    toast(result.demoMode ? 'Teste simulado (modo demonstração).' : 'Mensagem de teste enviada.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Enviar teste'; }
});
$('#upload-trigger').addEventListener('click', () => $('#media-file').click());
$('#media-file').addEventListener('change', (event) => handleFile(event.target.files[0]));
$('#remove-file').addEventListener('click', () => { state.media = null; $('#media-file').value = ''; $('#upload-trigger').classList.remove('hidden'); $('#file-preview').classList.add('hidden'); updatePreview(); });
['dragenter', 'dragover'].forEach((eventName) => $('#upload-area').addEventListener(eventName, (event) => { event.preventDefault(); $('#upload-area').classList.add('dragging'); }));
['dragleave', 'drop'].forEach((eventName) => $('#upload-area').addEventListener(eventName, (event) => { event.preventDefault(); $('#upload-area').classList.remove('dragging'); }));
$('#upload-area').addEventListener('drop', (event) => handleFile(event.dataTransfer.files[0]));
$('#open-contacts').addEventListener('click', () => $('#contacts-modal').classList.remove('hidden'));
$('#edit-audience').addEventListener('click', () => $('#contacts-modal').classList.remove('hidden'));
$('#close-contacts').addEventListener('click', () => $('#contacts-modal').classList.add('hidden'));
$('#campaign-number-table-body').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-campaign-id]');
  if (!row) return;
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) {
    event.stopPropagation();
    const action = actionButton.dataset.action;
    if (action === 'pause') pauseCampaign(row.dataset.campaignId);
    if (action === 'resume') resumeCampaign(row.dataset.campaignId);
    if (action === 'edit') editCampaign(row.dataset.campaignId);
    if (action === 'delete') deleteCampaign(row.dataset.campaignId);
    return;
  }
  openCampaignDetail(row.dataset.campaignId, row.dataset.numberId);
});
$('#cancel-edit-campaign').addEventListener('click', cancelEditCampaign);
$('#close-campaign-detail').addEventListener('click', () => $('#campaign-detail-modal').classList.add('hidden'));
$('#add-contact').addEventListener('click', async () => {
  const name = $('#contact-name').value.trim();
  const phone = $('#contact-phone').value.replace(/\D/g, '');
  if (!name || phone.length < 8) return toast('Informe nome e WhatsApp com DDI.');
  if (state.recipients.some((recipient) => recipient.phone === phone)) return toast('Este contato já foi adicionado.');
  try {
    const response = await fetch('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone, groupId: state.selectedCampaignGroupId && state.selectedCampaignGroupId !== 'all' ? state.selectedCampaignGroupId : null }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível salvar o contato.');
    state.contacts = result.contacts;
    state.contactGroups = result.groups || state.contactGroups;
    renderContactsPage();
    state.recipients.push({ ...result.contact, wppNumberId: state.campaignSenderNumberId || result.contact?.wppNumberId || state.wppNumbers[0]?.id || null });
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
$('#create-group').addEventListener('click', async () => {
  const input = $('#new-group-name');
  const name = input.value.trim();
  if (!name) return toast('Informe um nome para o grupo.');
  const button = $('#create-group'); button.disabled = true;
  try {
    const response = await fetch('/api/contact-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível criar o grupo.');
    state.contactGroups = result.groups || state.contactGroups;
    state.importGroupMode = 'existing';
    state.importExistingGroupId = result.group.id;
    state.selectedContactsGroupId = result.group.id;
    input.value = '';
    renderAudience();
    renderContactsPage();
    toast(`Grupo "${result.group.name}" criado.`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#contacts-import-mode').addEventListener('change', (event) => {
  state.importGroupMode = event.target.value;
  renderContactGroupSelectors();
});
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
$('#message-interval').addEventListener('input', renderSendEstimate);
$('#message-interval-unit').addEventListener('change', renderSendEstimate);
$('#campaign-start').addEventListener('change', renderSendEstimate);
$('#campaign-group-select').addEventListener('change', (event) => setCampaignGroup(event.target.value));
$('#campaign-sender-number').addEventListener('change', (event) => setCampaignSender(event.target.value));
$('#contacts-group-filter').addEventListener('change', (event) => {
  state.selectedContactsGroupId = event.target.value;
  renderContactsPage();
});
$('#contact-list').addEventListener('change', (event) => {
  const inclusion = event.target.closest('[data-recipient-selected]');
  if (inclusion) {
    const phone = inclusion.dataset.recipientSelected;
    const existing = state.recipients.find((recipient) => recipient.phone === phone);
    if (inclusion.checked && !existing) {
      const contact = state.contacts.find((item) => item.phone === phone);
      if (contact) state.recipients.push({ ...contact });
    } else if (!inclusion.checked) {
      state.recipients = state.recipients.filter((recipient) => recipient.phone !== phone);
    }
    renderAudience();
    return;
  }
  const select = event.target.closest('[data-recipient-sender]');
  if (!select) return;
  const recipient = state.recipients[Number(select.dataset.recipientSender)];
  if (recipient) recipient.wppNumberId = select.value || null;
  renderNumberChecklist();
});
if ($('#message').value.includes('\\n')) $('#message').value = $('#message').value.replace(/\\n/g, '\n');
renderAudience(); updatePreview(); initializeAuth();
