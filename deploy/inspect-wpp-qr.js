const { WPP_CONNECT_URL: base, WPP_CONNECT_SESSION: session, WPP_CONNECT_TOKEN: token } = process.env;
fetch(`${base}/api/${encodeURIComponent(session)}/qrcode-session`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10000)
}).then(async (response) => {
  const data = await response.json();
  const shape = (value) => {
    if (typeof value === 'string') return `string(${value.length})`;
    if (Array.isArray(value)) return `array(${value.length})`;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
    return value;
  };
  console.log(JSON.stringify({ status: response.status, shape: shape(data) }));
}).catch((error) => { console.error(error.message); process.exit(1); });
