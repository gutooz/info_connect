# Spec: Persistência local de campanhas

## Objetivo

Persistir campanhas em um banco SQLite local para que o histórico sobreviva a refresh da página e reinicializações do servidor. O arquivo poderá ser levado para a VPS junto com a aplicação.

## Contrato

- Banco padrão: `data/major-neto.sqlite`.
- `GET /api/campaigns` continua retornando a lista de campanhas no formato atual.
- Criar campanha grava o registro antes de iniciar o envio.
- Mudanças de status, quantidade enviada, erro e conclusão são gravadas durante o processamento.
- A mídia e os destinatários permanecem no payload persistido para permitir retomada e auditoria local.

## Limites

- Não persistir credenciais, tokens ou arquivos `.env`.
- Não alterar a integração com WPPConnect ou Meta nesta tarefa.
- O banco fica fora do Git e será configurável por `DATABASE_PATH`.

## Sucesso

- Uma campanha criada continua aparecendo depois de atualizar a página.
- Campanhas continuam aparecendo depois de reiniciar o painel.
- O status salvo é carregado corretamente.
- O armazenamento funciona em um arquivo local e tem teste automatizado de fechar/reabrir.
