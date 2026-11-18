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

## Operações (Parte 2 — `supabase/schema_operacoes.sql`, rodar depois de `schema.sql`)
- **Início**: cada usuário vê só as operações liberadas.
- **Roca Imports** (perfil Operacional Roca): produtos por SKU (sem duplicar), recebimento com entregas parciais, estoque por local e conta (físico, reservado, disponível, em trânsito, pendente de conferência) com histórico, remessas para São Paulo e para o Full (separação reserva, saída põe em trânsito, chegada registra o recebido e deixa a diferença pendente de conferência). Cliques repetidos não duplicam movimentação.
- **FL Adega → Abrir PDV** (perfil Operador de PDV): busca por nome/SKU/código de barras com preço e disponível em Cuiabá, desconto só com permissão, troco no dinheiro, venda + pagamento + baixa numa única operação com chave anti-duplicidade, resumo da venda, fechamento de caixa por forma de pagamento, cancelamento com permissão e motivo (estorno único).
- **Conciliação** (Financeiro): importar arquivo de vendas (CSV/XLSX, com mapeamento de colunas, prévia e erro por linha) e extrato bancário (CSV/OFX); reimportação/sobreposição não duplica; conferência dos repasses (vínculo automático só por identificador; valor igual vira sugestão com confirmação manual + anexo/justificativa); Ganho em R$ e Margem (%) com base explícita e detalhamento.
- **Usuários e permissões** (Administrador): convidar por e-mail, perfil, operações, permissões específicas (custo, desconto, cancelamento), ativar/desativar. Tudo validado no banco (RLS + funções).
- "Vendas e Marketplace" saiu do menu; o histórico continua em Conciliação → Histórico de vendas.

## Testes
- `node tests/conc_logic.test.js` — leitura de arquivos, datas/valores BR, OFX, sugestões de conciliação e margem.
- `tests/db_cenarios.sql` + `tests/concorrencia_pdv.sh` — cenários do roteiro direto no banco (base de teste local).
- `tests/ui/run.sh` — testes de ponta a ponta pela interface (Chrome headless) contra a base de teste local, com cliente Supabase simulado e RLS ativo.

## Fases
1. Fundação: domínio, login, empresas, produtos, estoque, caixa da loja, expedição, ML. **(esta)**
2. Amazon (SP-API) e Shopee (Open Platform) conectados; etiquetas.
3. NFC-e no caixa da loja.
4. Conciliação dos repasses e DRE por empresa/canal.
5. IA e automações por WhatsApp.
