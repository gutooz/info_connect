# Implantação na VPS com Docker Compose

O `compose.yaml` executa a aplicação, a imagem Docker do WPPConnect e Caddy. O banco SQLite, a sessão do WhatsApp e os certificados HTTPS ficam em volumes persistentes. Apenas as portas 80 e 443 são publicadas.

## Preparação

Na VPS, copie o projeto sem `.env`, `node_modules`, `data`, `tokens` ou `userDataDir` para `/opt/major-neto`. Crie `deploy/runtime` a partir dos arquivos em `deploy/runtime.example`. Esse diretório contém segredos e está no `.gitignore`.

Configure em `app.env` `WPP_CONNECT_SESSION=major`, `DEMO_MODE=false` e, após gerar o token, `WPP_CONNECT_TOKEN`. Configure em `wpp.env` uma `SECRET_KEY` aleatória de 32 bytes. Configure em `web.env` o domínio apontado para a VPS. Até que `sinaipro.com.br` aponte para `177.7.60.78`, use `177.7.60.78.sslip.io`.

```sh
docker compose build
docker compose up -d wppconnect
docker compose exec -T wppconnect node -e 'fetch("http://127.0.0.1:21465/api/major/CHAVE_SECRETA/generate-token", {method:"POST"}).then(r=>r.json()).then(console.log)'
```

O script `deploy/bootstrap-docker.sh` grava os segredos da integração em `deploy/runtime` e inicia os serviços. Em toda execução ele sincroniza `PUBLIC_BASE_URL` com o `PANEL_DOMAIN` de `web.env`, adiciona as chaves novas que faltarem e preserva o `WPP_WEBHOOK_SECRET` já criado (ou gera um na primeira execução). Sem essas duas variáveis, o dashboard não recebe status de entregue/lido/respondido e o endpoint de webhook fica aberto sem autenticação. Execute `bash deploy/bootstrap-docker.sh` na VPS. Não coloque chaves ou tokens em Git, chat ou logs. Depois:

```sh
docker compose up -d
docker compose ps
docker compose logs --tail=50 app wppconnect web
```

Abra o endereço HTTPS e solicite o cadastro de cada usuário. Não há limite numérico de contas; o administrador aprova cada cadastro pelo Telegram. Cada login tem contatos, campanhas e sessões de WhatsApp isolados, com QR Code exclusivo por sessão. Na primeira inicialização após atualizar um banco antigo, os dados anteriores ficam com o primeiro usuário cadastrado; faça backup do SQLite antes da atualização.

## Troca de domínio

Quando trocar o domínio, altere `PANEL_DOMAIN` em `deploy/runtime/web.env` e execute `bash deploy/bootstrap-docker.sh`. O script sincroniza `PUBLIC_BASE_URL`, recria os serviços e o Caddy obtém o certificado automaticamente.

## Backup

Faça backup dos volumes `app_data`, `wpp_tokens` e `wpp_user_data`. Para o SQLite, prefira `sqlite3 /data/major-neto.sqlite '.backup ...'` dentro do contêiner ou pare o contêiner `app` antes de copiar o volume.

## Deploy automático pelo GitHub

O workflow `.github/workflows/deploy-production.yml` valida sintaxe, testes, dependências e a imagem Docker. Em pushes para `feature/unlimited-users-anytime-sends`, ele envia um arquivo criado por `git archive` para a VPS e chama `/usr/local/sbin/deploy-major-neto`.

Configure no repositório GitHub os secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY` e `VPS_KNOWN_HOSTS`. A chave deve pertencer a um usuário exclusivo de deploy, sem acesso ao Docker e com `sudo` liberado somente para o script de implantação. O host key deve ser cadastrado em `VPS_KNOWN_HOSTS`; o workflow usa `StrictHostKeyChecking=yes` e não aprende chaves automaticamente.

Na preparação inicial da VPS, copie a chave pública e execute como `root`: `bash deploy/install-github-deploy.sh /caminho/chave.pub deploy/deploy-from-github.sh`. O instalador cria o usuário `major-deploy`, os diretórios de staging e a regra restrita de `sudo`.

Antes de trocar o container, o script compila a nova imagem, faz um backup online do SQLite e guarda uma cópia do código atual. Se o health check interno falhar, a imagem e o código anteriores são restaurados automaticamente. Os sete backups de banco mais recentes criados pela esteira ficam em `/var/lib/major-neto-deploy/database-backups`.
