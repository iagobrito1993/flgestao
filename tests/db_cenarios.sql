-- Testes dos cenários do roteiro (rodar numa base de teste, nunca em produção)
\set ON_ERROR_STOP on
\pset footer off
-- usuários de teste
insert into auth.users values
 ('00000000-0000-0000-0000-00000000000a','iagobrito@hotmail.com','{"nome":"Admin"}'),
 ('00000000-0000-0000-0000-00000000000b','roca@teste.com','{"nome":"Op Roca"}'),
 ('00000000-0000-0000-0000-00000000000c','pdv1@teste.com','{"nome":"Caixa 1"}'),
 ('00000000-0000-0000-0000-00000000000d','pdv2@teste.com','{"nome":"Caixa 2"}'),
 ('00000000-0000-0000-0000-00000000000e','fin@teste.com','{"nome":"Financeiro"}')
on conflict do nothing;
set role authenticated;
create temp table ctx(k text primary key, v text);
-- admin entra e convida
select set_config('test.uid','00000000-0000-0000-0000-00000000000a',false);
select papel from fl_entrar();
insert into fl_convites(email,nome,papel,operacoes) values ('roca@teste.com','Op Roca','roca','{roca}'),
 ('pdv1@teste.com','Caixa 1','pdv','{adega}'),('pdv2@teste.com','Caixa 2','pdv','{adega}');
insert into fl_convites(email,nome,papel,operacoes,pode_cancelar) values ('fin@teste.com','Financeiro','financeiro','{roca,adega}',true);
do $$ declare u text; begin
  foreach u in array array['00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000d','00000000-0000-0000-0000-00000000000e'] loop
    perform set_config('test.uid',u,false); perform fl_entrar();
  end loop; end $$;
select set_config('test.uid','00000000-0000-0000-0000-00000000000a',false);
select email,papel,operacoes,ativo from fl_perfis order by email;

-- produtos: admin cadastra com custo e preço
insert into fl_produtos(id,nome,sku,unidade,custo_aquisicao) values ('11111111-0000-0000-0000-000000000001','Fone Bluetooth X','fone-x','UN',60);
insert into fl_produtos(id,nome,sku,unidade,preco_venda,tipo_vinho) values ('22222222-0000-0000-0000-000000000001','Malbec Reserva 750ml','VIN-MAL','UN',80,'Tinto'),
  ('22222222-0000-0000-0000-000000000002','Última Garrafa Rosé','VIN-ROS','UN',120,'Rosé');

\echo '=== C1: entrada de 20 unidades em duas entregas (12 + 8)'
select set_config('test.uid','00000000-0000-0000-0000-00000000000b',false);
do $$ declare cid bigint; it bigint; s1 numeric; s2 numeric; loc int:=(select id from fl_locais where nome='Cuiabá (Roca)'); r1 bigint; r1b bigint;
begin
  -- operador sem permissão de custo não consegue alterar custo
  begin update fl_produtos set custo_aquisicao=1 where sku='FONE-X'; raise exception 'FALHA: alterou custo sem permissão';
  exception when others then if sqlerrm not like '%Sem permissão para editar custo%' then raise; end if; end;
  -- SKU duplicado bloqueado
  begin insert into fl_produtos(nome,sku) values ('Duplicado','Fone-X'); raise exception 'FALHA: SKU duplicado';
  exception when unique_violation then null; end;
  cid:=fl_compra_criar(jsonb_build_object('fornecedor','Fornecedor A','documento','NF 1001','data','2026-11-01','local_id',loc,'chave','compra-teste-1',
       'itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',20,'recebido',12))));
  -- clique repetido na criação não duplica
  if fl_compra_criar(jsonb_build_object('fornecedor','Fornecedor A','local_id',loc,'chave','compra-teste-1','itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',20,'recebido',12))))<>cid then raise exception 'FALHA: compra duplicada'; end if;
  s1:=fl_saldo_fisico(loc,'11111111-0000-0000-0000-000000000001');
  if s1<>12 then raise exception 'FALHA C1: saldo após 1ª entrega = % (esperado 12)', s1; end if;
  if (select status from fl_compras where id=cid)<>'parcial' then raise exception 'FALHA C1: compra deveria estar parcial'; end if;
  select id into it from fl_compra_itens where compra_id=cid;
  r1:=fl_compra_receber(cid,jsonb_build_array(jsonb_build_object('item_id',it,'qtd',8)),'2026-11-02','NF 1001 (2ª entrega)','receb-teste-2');
  r1b:=fl_compra_receber(cid,jsonb_build_array(jsonb_build_object('item_id',it,'qtd',8)),'2026-11-02','NF 1001 (2ª entrega)','receb-teste-2');
  if r1<>r1b then raise exception 'FALHA C1: recebimento duplicado'; end if;
  s2:=fl_saldo_fisico(loc,'11111111-0000-0000-0000-000000000001');
  if s2<>20 then raise exception 'FALHA C1: saldo final = % (esperado 20)', s2; end if;
  if (select status from fl_compras where id=cid)<>'recebida' then raise exception 'FALHA C1: compra deveria estar recebida'; end if;
  if (select count(*) from fl_mov where origem='compra' and produto_id='11111111-0000-0000-0000-000000000001')<>2 then raise exception 'FALHA C1: histórico deveria ter 2 entradas'; end if;
  raise notice 'OK C1: saldo 12 → 20, 2 recebimentos no histórico';
end $$;
select data::date, tipo, qtd, documento, responsavel from fl_mov where origem='compra' order by id;

\echo '=== C2: remessa de 10 para São Paulo, chegam 8'
do $$ declare rid bigint; it bigint; o int:=(select id from fl_locais where nome='Cuiabá (Roca)'); d int:=(select id from fl_locais where nome='São Paulo (Roca)'); st text;
begin
  rid:=fl_remessa_criar(jsonb_build_object('tipo','sp','origem_id',o,'destino_id',d,'chave','rm-sp-1','itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',10))));
  insert into ctx values ('rm_sp',rid);
  perform fl_remessa_separar(rid);
  if fl_disponivel(o,'11111111-0000-0000-0000-000000000001')<>10 then raise exception 'FALHA C2: reserva'; end if;
  perform fl_remessa_saida(rid);
  if fl_saldo_fisico(o,'11111111-0000-0000-0000-000000000001')<>10 then raise exception 'FALHA C2: saída da origem'; end if;
  select id into it from fl_remessa_itens where remessa_id=rid;
  st:=fl_remessa_receber(rid,jsonb_build_array(jsonb_build_object('item_id',it,'qtd',8)));
  if st<>'divergente' then raise exception 'FALHA C2: status %', st; end if;
  if fl_saldo_fisico(d,'11111111-0000-0000-0000-000000000001')<>8 then raise exception 'FALHA C2: destino deveria ter 8'; end if;
  if (select pendente_conferencia from fl_estoque_roca() where local_id=d and produto_id='11111111-0000-0000-0000-000000000001')<>2 then raise exception 'FALHA C2: pendente 2'; end if;
  raise notice 'OK C2: destino 8, 2 pendentes de conferência (% → %)', (select nome from fl_locais where id=o),(select nome from fl_locais where id=d);
end $$;
select numero, tipo, status, (select nome from fl_locais where id=origem_id) origem, (select nome from fl_locais where id=destino_id) destino from fl_remessas;

\echo '=== C3: 5 unidades de São Paulo para o Full'
do $$ declare rid bigint; d int:=(select id from fl_locais where nome='São Paulo (Roca)'); f int; it bigint; c int:=(select id from fl_ml_contas where apelido='Roca Imports');
begin
  begin perform fl_remessa_criar(jsonb_build_object('tipo','full','origem_id',d,'itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',5))));
    raise exception 'FALHA C3: aceitou Full sem conta'; exception when others then if sqlerrm not like '%conta do Mercado Livre%' then raise; end if; end;
  rid:=fl_remessa_criar(jsonb_build_object('tipo','full','origem_id',d,'ml_conta_id',c,'envio_id','ENV-123','centro_destino','SP02','chave','rm-full-1',
       'itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',5))));
  perform fl_remessa_separar(rid); perform fl_remessa_saida(rid);
  select destino_id into f from fl_remessas where id=rid;
  select id into it from fl_remessa_itens where remessa_id=rid;
  perform fl_remessa_receber(rid,jsonb_build_array(jsonb_build_object('item_id',it,'qtd',5)));
  if fl_saldo_fisico(d,'11111111-0000-0000-0000-000000000001')<>3 then raise exception 'FALHA C3: SP deveria ficar com 3'; end if;
  if fl_saldo_fisico(f,'11111111-0000-0000-0000-000000000001')<>5 then raise exception 'FALHA C3: Full deveria ter 5'; end if;
  if (select ml_conta_id from fl_mov where origem_ref like 'rm:'||rid||':%:entrada')<>c then raise exception 'FALHA C3: conta não identificada'; end if;
  raise notice 'OK C3: saiu do saldo de SP (8 → 3), Full da conta % recebeu 5', (select apelido from fl_ml_contas where id=c);
end $$;

\echo '=== C4: envio acima do disponível e confirmação dupla'
do $$ declare rid bigint; o int:=(select id from fl_locais where nome='Cuiabá (Roca)'); d int:=(select id from fl_locais where nome='São Paulo (Roca)'); n1 int; n2 int; it bigint;
begin
  begin perform fl_remessa_criar(jsonb_build_object('tipo','sp','origem_id',o,'destino_id',d,'itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',11))));
    raise exception 'FALHA C4: aceitou acima do saldo'; exception when others then if sqlerrm not like '%Saldo insuficiente%' then raise; end if; end;
  rid:=fl_remessa_criar(jsonb_build_object('tipo','sp','origem_id',o,'destino_id',d,'chave','rm-sp-2','itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',4))));
  perform fl_remessa_separar(rid); perform fl_remessa_separar(rid);
  -- outra remessa não pode usar o reservado: disponível 10-4=6
  begin perform fl_remessa_criar(jsonb_build_object('tipo','sp','origem_id',o,'destino_id',d,'itens',jsonb_build_array(jsonb_build_object('produto_id','11111111-0000-0000-0000-000000000001','qtd',7))));
    raise exception 'FALHA C4: usou saldo reservado'; exception when others then if sqlerrm not like '%Saldo insuficiente%' then raise; end if; end;
  perform fl_remessa_saida(rid); perform fl_remessa_saida(rid); perform fl_remessa_saida(rid);
  select count(*) into n1 from fl_mov where origem_ref like 'rm:'||rid||':%';
  select id into it from fl_remessa_itens where remessa_id=rid;
  perform fl_remessa_receber(rid,jsonb_build_array(jsonb_build_object('item_id',it,'qtd',4)));
  perform fl_remessa_receber(rid,jsonb_build_array(jsonb_build_object('item_id',it,'qtd',4)));
  select count(*) into n2 from fl_mov where origem_ref like 'rm:'||rid||':%';
  if n1<>1 or n2<>2 then raise exception 'FALHA C4: movimentações duplicadas (% / %)', n1, n2; end if;
  if fl_saldo_fisico(o,'11111111-0000-0000-0000-000000000001')<>6 then raise exception 'FALHA C4: saldo origem %', fl_saldo_fisico(o,'11111111-0000-0000-0000-000000000001'); end if;
  if fl_saldo_fisico(d,'11111111-0000-0000-0000-000000000001')<>7 then raise exception 'FALHA C4: saldo SP'; end if;
  raise notice 'OK C4: bloqueou 11 (disponível 10) e 7 (6 livres); cliques repetidos geraram 1 saída e 1 entrada';
end $$;
\echo '--- conferência da divergência de C2: 1 encontrada, 1 perda'
do $$ declare it bigint; begin
  select i.id into it from fl_remessa_itens i where remessa_id=(select v::bigint from ctx where k='rm_sp');
  perform fl_remessa_conferir(it,1,1,'1 achada no caminhão, 1 avariada');
  if (select status from fl_remessas where id=(select v::bigint from ctx where k='rm_sp'))<>'recebida' then raise exception 'FALHA: divergência não fechou'; end if;
  raise notice 'OK: divergência conferida e fechada';
end $$;
select produto_id is not null, local, conta, fisico, reservado, disponivel, em_transito, pendente_conferencia from fl_estoque_roca();

\echo '=== C5/C6: importação de vendas, reimportação, extrato e conciliação (2×R$100, custo 120, tarifas 20, repasse 180)'
select set_config('test.uid','00000000-0000-0000-0000-00000000000e',false);
do $$ declare a1 bigint; a2 bigint; a3 bigint; c int:=(select id from fl_ml_contas where apelido='Roca Imports'); cf int; r jsonb; e1 bigint; t jsonb; cid bigint;
  vendas jsonb:=jsonb_build_array(
    jsonb_build_object('pedido','2000001','data','2026-11-10T10:00:00-03:00','bruto',100,'tarifa',10,'liquido',90,'data_liberacao','2026-11-15',
      'itens',jsonb_build_array(jsonb_build_object('sku','FONE-X','descricao','Fone','qtd',1,'preco_unit',100,'tarifa',10))),
    jsonb_build_object('pedido','2000002','data','2026-11-11T10:00:00-03:00','bruto',100,'tarifa',10,'liquido',90,'data_liberacao','2026-11-15',
      'itens',jsonb_build_array(jsonb_build_object('sku','FONE-X','descricao','Fone','qtd',1,'preco_unit',100,'tarifa',10))));
begin
  select id into cf from fl_contas_fin where nome='Banco Roca Imports';
  a1:=fl_imp_registrar(jsonb_build_object('tipo','vendas','ml_conta_id',c,'nome','vendas_nov.xlsx','sha256','abc','linhas',2));
  r:=fl_importar_vendas(a1,c,vendas);
  if (r->>'novos')::int<>2 then raise exception 'FALHA C5: %', r; end if;
  -- mesmo arquivo de novo
  a2:=fl_imp_registrar(jsonb_build_object('tipo','vendas','ml_conta_id',c,'nome','vendas_nov.xlsx','sha256','abc','linhas',2));
  r:=fl_importar_vendas(a2,c,vendas);
  -- período sobreposto (uma venda repetida + uma nova)
  a3:=fl_imp_registrar(jsonb_build_object('tipo','vendas','ml_conta_id',c,'nome','vendas_sobreposto.csv','sha256','def','linhas',2));
  r:=fl_importar_vendas(a3,c,jsonb_build_array(vendas->1,jsonb_build_object('pedido','2000003','data','2026-11-12T10:00:00-03:00','status','cancelada','bruto',50,'cancelado',50,'liquido',0,
     'itens',jsonb_build_array(jsonb_build_object('sku','FONE-X','descricao','Fone','qtd',1,'preco_unit',50)))));
  if (r->>'novos')::int<>1 or (r->>'iguais')::int<>1 then raise exception 'FALHA C5 sobreposto: %', r; end if;
  if (select count(*) from fl_vendas where canal='mercado_livre')<>3 then raise exception 'FALHA C5: vendas duplicadas'; end if;
  if (select sum(tarifa_venda) from fl_vendas where canal='mercado_livre')<>20 then raise exception 'FALHA C5: tarifa contada mais de uma vez'; end if;
  -- extrato com o repasse de 180 e reimportação do extrato
  a1:=fl_imp_registrar(jsonb_build_object('tipo','extrato','conta_fin_id',cf,'nome','extrato.ofx','sha256','x1','linhas',2));
  r:=fl_importar_extrato(a1,cf,jsonb_build_array(jsonb_build_object('data','2026-11-15','valor',180,'descricao','TED MERCADO PAGO REPASSE 2000001 2000002','chave','fit:A1'),
                                                 jsonb_build_object('data','2026-11-16','valor',-35,'descricao','TARIFA BANCARIA','chave','fit:A2')));
  r:=fl_importar_extrato(a1,cf,jsonb_build_array(jsonb_build_object('data','2026-11-15','valor',180,'descricao','TED MERCADO PAGO REPASSE 2000001 2000002','chave','fit:A1')));
  if (r->>'iguais')::int<>1 or (select count(*) from fl_extrato)<>2 then raise exception 'FALHA C5: extrato duplicado'; end if;
  select id into e1 from fl_extrato where chave='fit:A1';
  cid:=fl_conciliar(e1,array(select id from fl_vendas where pedido in ('2000001','2000002')),'identificador');
  begin perform fl_conciliar(e1,array(select id from fl_vendas where pedido in ('2000001')),'manual',null,'x'); raise exception 'FALHA: conciliou duas vezes';
  exception when others then if sqlerrm not like '%já foi conciliado%' then raise; end if; end;
  t:=fl_apuracao_total('2026-11-01','2026-11-30',c,null,'roca');
  raise notice 'Apuração: %', t;
  if (t->>'receita')::numeric<>200 or (t->>'cmv')::numeric<>120 or (t->>'tarifas')::numeric<>20 or (t->>'ganho')::numeric<>60 or (t->>'margem')::numeric<>30 then
    raise exception 'FALHA C6: %', t; end if;
  if (t->>'recebido')::numeric<>180 or (t->>'previsto')::numeric<>180 or (t->>'diferenca')::numeric<>0 then raise exception 'FALHA C6 recebido: %', t; end if;
  raise notice 'OK C5: reimportação e sobreposição sem duplicar vendas, créditos e tarifas';
  raise notice 'OK C6: conciliado 2 vendas ↔ 1 crédito de 180; Ganho R$ 60, Margem 30%%';
end $$;

\echo '=== C7: venda sem custo e receita zerada'
select set_config('test.uid','00000000-0000-0000-0000-00000000000a',false);
insert into fl_produtos(nome,sku) values ('Produto sem custo','SEM-CUSTO');
select set_config('test.uid','00000000-0000-0000-0000-00000000000e',false);
do $$ declare c int:=(select id from fl_ml_contas where apelido='Roca Imports'); a bigint; t jsonb;
begin
  a:=fl_imp_registrar(jsonb_build_object('tipo','vendas','ml_conta_id',c,'nome','dez.csv','sha256','g','linhas',1));
  perform fl_importar_vendas(a,c,jsonb_build_array(jsonb_build_object('pedido','3000001','data','2026-12-05T10:00:00-03:00','bruto',70,'tarifa',7,'liquido',63,
     'itens',jsonb_build_array(jsonb_build_object('sku','SEM-CUSTO','descricao','x','qtd',1,'preco_unit',70)))));
  t:=fl_apuracao_total('2026-12-01','2026-12-31',c,null,'roca');
  if t->>'situacao'<>'Margem pendente de conferência' then raise exception 'FALHA C7 sem custo: %', t; end if;
  t:=fl_apuracao_total('2027-01-01','2027-01-31',c,null,'roca');
  if t->>'situacao'<>'Sem base para cálculo' or t->'margem'<>'null'::jsonb then raise exception 'FALHA C7 receita zero: %', t; end if;
  raise notice 'OK C7: "Margem pendente de conferência" e "Sem base para cálculo" (sem divisão por zero)';
end $$;

\echo '=== C8: PDV — 2 vinhos a R$ 80, R$ 200 em dinheiro'
select set_config('test.uid','00000000-0000-0000-0000-00000000000a',false);
do $$ declare loja int:=(select id from fl_locais where nome='Loja Cuiabá'); begin
  insert into fl_mov(produto_id,local_id,tipo,qtd,origem,origem_ref) values ('22222222-0000-0000-0000-000000000001',loja,'compra',10,'manual','ini-mal'),
    ('22222222-0000-0000-0000-000000000002',loja,'compra',1,'manual','ini-ros');
  -- mesmo SKU no depósito da Roca não pode ser afetado
  insert into fl_mov(produto_id,local_id,tipo,qtd,origem,origem_ref) values ('22222222-0000-0000-0000-000000000001',(select id from fl_locais where nome='Cuiabá (Roca)'),'compra',5,'manual','ini-mal-roca');
end $$;
select set_config('test.uid','00000000-0000-0000-0000-00000000000c',false);
do $$ declare loja int:=(select id from fl_locais where nome='Loja Cuiabá'); r jsonb; roca int:=(select id from fl_locais where nome='Cuiabá (Roca)');
begin
  begin perform fl_pdv_vender(jsonb_build_object('chave','venda-desc-0001','local_id',loja,'forma_pagamento','pix','desconto',10,'itens',jsonb_build_array(jsonb_build_object('produto_id','22222222-0000-0000-0000-000000000001','qtd',1))));
    raise exception 'FALHA C8: deu desconto sem permissão'; exception when others then if sqlerrm not like '%desconto%' then raise; end if; end;
  r:=fl_pdv_vender(jsonb_build_object('chave','venda-teste-0001','local_id',loja,'forma_pagamento','dinheiro','valor_recebido',200,
       'itens',jsonb_build_array(jsonb_build_object('produto_id','22222222-0000-0000-0000-000000000001','qtd',2))));
  raise notice 'Resumo: %', r;
  if (r->>'total')::numeric<>160 or (r->>'troco')::numeric<>40 then raise exception 'FALHA C8: %', r; end if;
  if fl_saldo_fisico(loja,'22222222-0000-0000-0000-000000000001')<>8 then raise exception 'FALHA C8: baixa na loja'; end if;
  if fl_saldo_fisico(roca,'22222222-0000-0000-0000-000000000001')<>5 then raise exception 'FALHA C8: mexeu no estoque da Roca'; end if;
  if (select empresa_id from fl_vendas where id=(r->>'id')::bigint)<>(select id from fl_empresas where operacao='adega') then raise exception 'FALHA C8: empresa'; end if;
  raise notice 'OK C8: total R$ 160, troco R$ 40, baixa de 2 só na Loja Cuiabá (Roca intacta)';
end $$;

\echo '=== C10: falha durante a confirmação, nova tentativa e cancelamento autorizado'
select set_config('test.uid','00000000-0000-0000-0000-00000000000c',false);
-- 1ª tentativa: a gravação falha (transação desfeita no meio)
begin;
select fl_pdv_vender(jsonb_build_object('chave','venda-falha-0001','local_id',(select id from fl_locais where nome='Loja Cuiabá'),'forma_pagamento','pix',
  'itens',jsonb_build_array(jsonb_build_object('produto_id','22222222-0000-0000-0000-000000000001','qtd',1))))->>'numero' as tentativa_1;
rollback;
do $$ declare loja int:=(select id from fl_locais where nome='Loja Cuiabá'); r1 jsonb; r2 jsonb; s0 numeric; n int;
begin
  s0:=fl_saldo_fisico(loja,'22222222-0000-0000-0000-000000000001');
  if (select count(*) from fl_vendas where origem_ref='cx:venda-falha-0001')<>0 then raise exception 'FALHA C10: venda ficou gravada após falha'; end if;
  r1:=fl_pdv_vender(jsonb_build_object('chave','venda-falha-0001','local_id',loja,'forma_pagamento','pix','itens',jsonb_build_array(jsonb_build_object('produto_id','22222222-0000-0000-0000-000000000001','qtd',1))));
  r2:=fl_pdv_vender(jsonb_build_object('chave','venda-falha-0001','local_id',loja,'forma_pagamento','pix','itens',jsonb_build_array(jsonb_build_object('produto_id','22222222-0000-0000-0000-000000000001','qtd',1))));
  if r1->>'id'<>r2->>'id' or not (r2->>'repetida')::boolean then raise exception 'FALHA C10: nova tentativa duplicou'; end if;
  if fl_saldo_fisico(loja,'22222222-0000-0000-0000-000000000001')<>s0-1 then raise exception 'FALHA C10: baixa'; end if;
  -- operador sem permissão não cancela
  begin perform fl_pdv_cancelar((r1->>'id')::bigint,'teste'); raise exception 'FALHA C10: cancelou sem permissão';
  exception when others then if sqlerrm not like '%Sem permissão%' then raise; end if; end;
  insert into ctx values ('venda_c10',r1->>'id');
  raise notice 'OK C10a: falha não gravou nada; nova tentativa gravou 1 venda, 1 pagamento e 1 baixa; repetição devolveu a mesma venda';
end $$;
select set_config('test.uid','00000000-0000-0000-0000-00000000000e',false);
do $$ declare loja int:=(select id from fl_locais where nome='Loja Cuiabá'); v bigint:=(select v::bigint from ctx where k='venda_c10'); s0 numeric;
begin
  s0:=fl_saldo_fisico(loja,'22222222-0000-0000-0000-000000000001');
  if (select count(*) from fl_lancamentos where venda_id=v)<>1 then raise exception 'FALHA C10: pagamento duplicado'; end if;
  begin perform fl_pdv_cancelar(v,''); raise exception 'FALHA: cancelou sem motivo'; exception when others then if sqlerrm not like '%motivo%' then raise; end if; end;
  perform fl_pdv_cancelar(v,'Cliente desistiu');
  perform fl_pdv_cancelar(v,'Cliente desistiu');
  if fl_saldo_fisico(loja,'22222222-0000-0000-0000-000000000001')<>s0+1 then raise exception 'FALHA C10: estorno % → %', s0, fl_saldo_fisico(loja,'22222222-0000-0000-0000-000000000001'); end if;
  if (select count(*) from fl_mov where origem_ref like 'vi:%:estorno' and venda_id=v)<>1 then raise exception 'FALHA C10: estorno duplicado'; end if;
  if (select status from fl_lancamentos where venda_id=v)<>'cancelado' then raise exception 'FALHA C10: pagamento não cancelado'; end if;
  if (select motivo_cancelamento from fl_vendas where id=v)<>'Cliente desistiu' then raise exception 'FALHA C10: motivo'; end if;
  raise notice 'OK C10b: cancelamento com motivo reverteu estoque e pagamento uma única vez (2º clique ignorado)';
end $$;

\echo '=== C11: funcionário tenta abrir o extrato por link direto'
select set_config('test.uid','00000000-0000-0000-0000-00000000000b',false);
do $$ declare n int;
begin
  select count(*) into n from fl_extrato; if n<>0 then raise exception 'FALHA C11: operador viu % linhas do extrato', n; end if;
  select count(*) into n from fl_vendas; if n<>0 then raise exception 'FALHA C11: operador viu vendas'; end if;
  select count(*) into n from fl_lancamentos; if n<>0 then raise exception 'FALHA C11: operador viu financeiro'; end if;
  begin perform fl_exige_fin(); raise exception 'FALHA C11: liberou área financeira'; exception when others then if sqlerrm not like '%Sem permissão%' then raise; end if; end;
  begin perform * from fl_apuracao('2026-01-01','2026-12-31'); raise exception 'FALHA C11: apuração'; exception when others then if sqlerrm not like '%Sem permissão%' then raise; end if; end;
  begin perform fl_pdv_vender(jsonb_build_object('chave','roca-tenta-pdv-1','local_id',(select id from fl_locais where nome='Loja Cuiabá'),'forma_pagamento','pix','itens',jsonb_build_array(jsonb_build_object('produto_id','22222222-0000-0000-0000-000000000001','qtd',1))));
    raise exception 'FALHA C11: operador da Roca vendeu no PDV'; exception when others then if sqlerrm not like '%Sem permissão%' then raise; end if; end;
  -- funções autorizadas continuam funcionando
  if (select count(*) from fl_estoque_roca())=0 then raise exception 'FALHA C11: operador perdeu o estoque'; end if;
  raise notice 'OK C11: operador da Roca bloqueado no extrato, vendas, financeiro, apuração e PDV; estoque e remessas continuam acessíveis';
end $$;
select set_config('test.uid','00000000-0000-0000-0000-00000000000c',false);
do $$ declare n int;
begin
  select count(*) into n from fl_extrato; if n<>0 then raise exception 'FALHA C11: caixa viu extrato'; end if;
  select count(*) into n from fl_vendas where canal='mercado_livre'; if n<>0 then raise exception 'FALHA C11: caixa viu vendas da Roca'; end if;
  if (select count(*) from fl_estoque_roca())<>0 then raise exception 'FALHA C11: caixa viu estoque da Roca'; end if;
  begin perform fl_remessa_criar('{"tipo":"sp","origem_id":1,"itens":[]}'); raise exception 'FALHA C11: caixa criou remessa'; exception when others then if sqlerrm not like '%Sem permissão%' then raise; end if; end;
  raise notice 'OK C11: operador do PDV bloqueado no extrato, vendas e estoque da Roca e remessas';
end $$;
\echo '=== FIM: todos os cenários de banco passaram'
