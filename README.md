# FL Gestão

Painel de gestão da **Roca Imports** e da **FL Adega**: marketplaces (Mercado Livre, Amazon, Shopee) nas modalidades Full, Flex, Agência e Turbo, e a loja física de vinhos em Cuiabá (caixa de balcão). Cadastro mestre de produtos (com dados de vinho), estoque por local com baixa automática das vendas, expedição, notas fiscais, custo médio ponderado, margens, financeiro e conciliação.

Endereço: https://flgestao.com.br (GitHub Pages) · Banco: Supabase (projeto da Tudo Mix, tabelas `fl_*` isoladas por RLS).

## Estrutura
- `index.html` + `js/*.js` — site (estático, sem build). `js/fl.js`: caixa da loja, expedição, Amazon/Shopee.
- `supabase/schema.sql` — banco: tabelas, permissões (RLS), custo médio, baixa automática de estoque, expedição, caixa. Idempotente.
- `supabase/functions/fl-ml/index.ts` — integração Mercado Livre/Mercado Pago (somente leitura). Segredos: ML_CLIENT_ID, ML_CLIENT_SECRET, FL_SITE_URL.

## Regras principais
- Toda venda concluída baixa o estoque sozinha: Flex/Agência/Turbo/Coleta saem do depósito da empresa; balcão sai da Loja Cuiabá; Full só baixa se houver local Full cadastrado para a conta. Cancelou/devolveu → estoque volta.
- Modalidade vem da logística do ML (fulfillment → Full, self_service → Flex, drop_off → Agência, cross_docking → Coleta); Turbo e casos sem logística são marcados no pedido.
- Expedição: a separar → separado → despachado. Full/FBA/balcão não entram na fila.
- Custo médio ponderado reconstruído do razão de movimentações; custo da venda congelado na data da venda.
- Reimportação/ressincronização não duplica (chave `origem + origem_ref`).
- Permissões: master, financeiro, compras, estoque, operação (caixa e expedição).

## Fases
1. Fundação: domínio, login, empresas, produtos, estoque, caixa da loja, expedição, ML. **(esta)**
2. Amazon (SP-API) e Shopee (Open Platform) conectados; etiquetas.
3. NFC-e no caixa da loja.
4. Conciliação dos repasses e DRE por empresa/canal.
5. IA e automações por WhatsApp.
