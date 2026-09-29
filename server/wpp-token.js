function createWppTokenProvider({ baseUrl, secretKey, defaultSession, defaultToken, fetchImpl = fetch }) {
  const cache = new Map();
  const base = String(baseUrl || '').replace(/\/$/, '');

  return async function tokenFor(session) {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(session || '')) throw new Error('Sessão do WhatsApp inválida.');
    if (session === defaultSession && defaultToken) return defaultToken;
    if (cache.has(session)) return cache.get(session);
    if (!base || !secretKey) throw new Error('WPPConnect não está configurado para novos números.');

    const response = await fetchImpl(`${base}/api/${encodeURIComponent(session)}/${encodeURIComponent(secretKey)}/generate-token`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.token) throw new Error('Não foi possível autorizar a sessão do WhatsApp.');
    cache.set(session, result.token);
    return result.token;
  };
}

module.exports = { createWppTokenProvider };
