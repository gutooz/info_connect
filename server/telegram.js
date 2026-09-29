const TELEGRAM_API = 'https://api.telegram.org';

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

function createTelegramBot({ token, adminChatId, store }) {
  if (!token || process.env.NODE_ENV === 'test') {
    if (!token) console.warn('TELEGRAM_BOT_TOKEN não configurado: aprovação de cadastros pelo Telegram está desativada.');
    return { notifyPendingRegistration() {}, stop() {} };
  }

  const adminId = adminChatId ? Number(adminChatId) : null;
  if (!adminId) console.warn('TELEGRAM_ADMIN_CHAT_ID não configurado: mande /start para o bot para descobrir seu chat ID.');

  const base = `${TELEGRAM_API}/bot${token}`;
  let stopped = false;
  let offset = 0;

  async function callApi(method, params) {
    const response = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.description || `Falha ao chamar ${method}`);
    return result.result;
  }

  async function handleCallbackQuery(query) {
    if (!adminId || query.from.id !== adminId) {
      return callApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Você não tem permissão para essa ação.', show_alert: true }).catch(() => {});
    }
    const [action, id] = String(query.data || '').split(':');
    if (!id || (action !== 'approve' && action !== 'reject')) {
      return callApi('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    }
    const pending = store.findPendingRegistration(id);
    if (!pending) {
      return callApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Esse cadastro já foi processado.', show_alert: true }).catch(() => {});
    }
    try {
      if (action === 'approve') {
        store.approvePendingRegistration(id);
        await callApi('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `${query.message.text}\n\n✅ Aprovado.` });
      } else {
        store.deletePendingRegistration(id);
        await callApi('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `${query.message.text}\n\n❌ Recusado.` });
      }
      await callApi('answerCallbackQuery', { callback_query_id: query.id });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        store.deletePendingRegistration(id);
        await callApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Esse e-mail já foi cadastrado por outra via.', show_alert: true }).catch(() => {});
      } else {
        console.error('Erro ao processar aprovação de cadastro:', error);
        await callApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Erro ao processar. Tente novamente.', show_alert: true }).catch(() => {});
      }
    }
  }

  async function handleUpdate(update) {
    if (update.message?.text?.startsWith('/start')) {
      const chatId = update.message.chat.id;
      await callApi('sendMessage', { chat_id: chatId, text: `Seu chat ID é: ${chatId}\nColoque esse valor em TELEGRAM_ADMIN_CHAT_ID no .env e reinicie o servidor.` })
        .catch((error) => console.error('Erro ao responder /start no Telegram:', error.message));
      return;
    }
    if (update.callback_query) await handleCallbackQuery(update.callback_query);
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await callApi('getUpdates', { offset, timeout: 30 });
        for (const update of updates) {
          offset = update.update_id + 1;
          await handleUpdate(update);
        }
      } catch (error) {
        console.error('Erro ao consultar o Telegram:', error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  poll();

  return {
    notifyPendingRegistration({ id, name, email, requestedByName }) {
      if (!adminId) return console.warn('Cadastro pendente recebido, mas TELEGRAM_ADMIN_CHAT_ID não está configurado.');
      const text = `📝 <b>Novo pedido de cadastro</b>\n\nNome: ${escapeHtml(name)}\nE-mail: ${escapeHtml(email)}${requestedByName ? `\nSolicitado por: ${escapeHtml(requestedByName)}` : ''}`;
      callApi('sendMessage', {
        chat_id: adminId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Aceitar', callback_data: `approve:${id}` },
          { text: '❌ Recusar', callback_data: `reject:${id}` }
        ]] }
      }).catch((error) => console.error('Erro ao notificar admin no Telegram:', error.message));
    },
    stop() { stopped = true; }
  };
}

module.exports = { createTelegramBot };
