# Backup e recuperação — FL Gestão

## Cópias
1. **Automática (Supabase Pro):** backup diário do banco inteiro, retido por 7 dias. Supabase → projeto tudomix-estoque → Database → Backups.
2. **Manual (recomendado semanalmente):** no site, Integrações e configurações → Backup e auditoria → "Baixar backup completo agora". Gera um JSON com todas as tabelas `fl_*`. Salve no Google Drive, pasta "Backups FL Gestão", com a data no nome.
3. **Arquivos:** XML, PDF e comprovantes ficam no Storage, bucket `fl-docs`.
4. **Código:** repositório GitHub `flgestao`.

## Recuperar
- **Banco inteiro (desastre):** Supabase → Database → Backups → Restore no dia desejado. Atenção: restaura o projeto inteiro (inclui Tudo Mix Estoque) — combine antes.
- **Registros apagados/alterados por engano:** abra Auditoria no site (mostra antes/depois de cada alteração) e refaça a alteração; ou use o JSON do backup manual para reinserir as linhas pelo editor SQL (`insert ... select * from json_populate_recordset(null::fl_tabela, '<json>')`).
- **Recriar a estrutura:** rode `supabase/schema.sql` no editor SQL (não apaga dados).
- **Dados importados:** basta reimportar os arquivos/sincronizar — a chave única impede duplicidade.

## Teste de recuperação
A cada 3 meses: baixe o backup manual, abra o JSON e confira se as tabelas principais (`fl_vendas`, `fl_notas`, `fl_mov`, `fl_lancamentos`) têm a quantidade esperada de linhas.
