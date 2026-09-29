const { createWppTokenProvider } = require('/app/server/wpp-token');

const session = 'verificacao-teste';
const baseUrl = process.env.WPP_CONNECT_URL;
const tokenFor = createWppTokenProvider({
  baseUrl,
  secretKey: process.env.SECRET_KEY,
  defaultSession: process.env.WPP_CONNECT_SESSION,
  defaultToken: process.env.WPP_CONNECT_TOKEN
});

tokenFor(session).then((token) => fetch(`${baseUrl}/api/${session}/status-session`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10000)
})).then(async (response) => {
  console.log(`Nova sessão: autenticação HTTP ${response.status}`);
  if (response.status === 401 || response.status === 403) process.exitCode = 1;
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
