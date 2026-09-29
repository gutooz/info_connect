const base = process.env.WPP_CONNECT_URL;
const session = process.env.WPP_CONNECT_SESSION;
const token = process.env.WPP_CONNECT_TOKEN;
if (!base || !session || !token) process.exit(2);
fetch(`${base}/api/${encodeURIComponent(session)}/status-session`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10000)
}).then(async (response) => {
  const payload = await response.json().catch(() => ({}));
  console.log(`WPPConnect: HTTP ${response.status}, status ${String(payload.status || 'UNKNOWN')}`);
  process.exit(response.status === 401 || response.status === 403 ? 1 : 0);
}).catch(() => process.exit(1));
