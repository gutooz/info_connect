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

Abra o endereço HTTPS, cadastre o primeiro usuário e leia o QR Code no painel. Depois do primeiro cadastro, outros usuários só podem ser cadastrados por uma pessoa autenticada. Cada login tem contatos, campanhas e sessões de WhatsApp isolados. Na primeira inicialização após atualizar um banco antigo, os dados anteriores ficam com o primeiro usuário cadastrado; faça backup do SQLite antes da atualização.

## Troca de domínio

Quando trocar o domínio, altere `PANEL_DOMAIN` em `deploy/runtime/web.env` e execute `bash deploy/bootstrap-docker.sh`. O script sincroniza `PUBLIC_BASE_URL`, recria os serviços e o Caddy obtém o certificado automaticamente.

## Backup

Faça backup dos volumes `app_data`, `wpp_tokens` e `wpp_user_data`. Para o SQLite, prefira `sqlite3 /data/major-neto.sqlite '.backup ...'` dentro do contêiner ou pare o contêiner `app` antes de copiar o volume.
