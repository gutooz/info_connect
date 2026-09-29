# Info Connect — Central de campanhas

MVP de um painel para criar, agendar e acompanhar disparos de texto, imagem e vídeo no WhatsApp, com publicação opcional no Instagram via Meta Graph API.

O painel tem somente três áreas: **Campanhas** (conteúdo separado para WhatsApp e Instagram), **WhatsApp** (sessão WPPConnect e importação de contatos Excel/CSV) e **Instagram** (validação da conta profissional pelo Meta). Não há campanhas, contatos ou credenciais pré-preenchidos.

Campanhas, usuários, sessões e contatos são persistidos em SQLite no arquivo `data/major-neto.sqlite`. Configure `DATABASE_PATH` para mudar o local; o arquivo fica fora do Git e deve ser incluído no backup da VPS.

O primeiro usuário pode se cadastrar pela tela inicial. Depois, apenas usuários autenticados podem cadastrar outras pessoas. Cada login tem campanhas, contatos e números de WhatsApp próprios. As senhas são protegidas com scrypt e o login usa cookie de sessão HttpOnly. Na migração de um banco antigo, os dados globais são atribuídos ao primeiro usuário cadastrado.

## Rodar localmente

1. Instale Node.js 18+.
2. Copie `.env.example` para `.env`.
3. Execute `npm install`.
4. Execute `npm start` e abra `http://localhost:3000`.

O projeto inicia em `DEMO_MODE=true`, que permite validar o fluxo sem enviar mensagens. Para conectar, configure `WPP_CONNECT_URL`, `WPP_CONNECT_SESSION`, `WPP_CONNECT_TOKEN`, `META_IG_USER_ID` e `META_ACCESS_TOKEN`, e altere `DEMO_MODE=false`.

## Integrações

- WPPConnect Server: texto usa `POST /api/{session}/send-message`; imagem usa `send-image`; vídeo usa `send-file`, todos com `Authorization: Bearer`.
- Meta: o servidor cria um container em `/{ig-user-id}/media` e publica em `/{ig-user-id}/media_publish`. A mídia precisa ter uma URL pública quando estiver em modo conectado (`media.publicUrl`).

## Acompanhamento de entrega e resposta

O Dashboard mostra, por número de WhatsApp, quantas mensagens de cada campanha foram enviadas, entregues e respondidas (com os horários), e um clique na linha abre um painel somente leitura com o detalhe por contato. Fora do `DEMO_MODE`, isso depende de o WPPConnect Server notificar o WPPConnect via webhook:

- Configure `PUBLIC_BASE_URL` (URL pública deste servidor) para que, ao conectar um número, o servidor registre automaticamente `POST /api/integrations/wppconnect/webhook` como webhook da sessão.
- Configure `WPP_WEBHOOK_SECRET` para exigir `?secret=` na chamada do webhook; sem ele, o endpoint aceita qualquer chamada (use somente em rede fechada).
- O endpoint entende eventos `onack` (marca entregue/lido) e `onmessage` de quem não é o próprio número (marca respondido, associando à última mensagem enviada para aquele contato).
- Em `DEMO_MODE`, não há WPPConnect real: o servidor simula a progressão enviado → entregue → lido → respondido para o dashboard ter dados de exemplo.

## Cadência e personalização

Na criação da campanha, o usuário escolhe um intervalo de 1 a 3600 segundos ou de 1 a 60 minutos entre envios. Se deixar o campo vazio, os envios são distribuídos automaticamente na janela de horário. As variáveis `{{nome}}` e `{{regiao}}` são substituídas pelo nome e pela região do contato (contatos importados sem nome viram "Delivery" e sem região viram "Brasil"). A personalização por IA é opcional e usa `AI_API_KEY`, `AI_BASE_URL` e `AI_MODEL` no servidor; ela não deve ser usada para contornar políticas, limites ou bloqueios de plataformas. Envie somente para contatos que autorizaram a comunicação e mantenha uma opção de saída/opt-out.

## Implantação

Veja [deploy/README.md](deploy/README.md) para Docker Compose, HTTPS, volumes persistentes e backup. O envio de campanhas ainda não possui fila com retry/idempotência; revise o status de cada campanha antes de repetir um disparo após falha.
