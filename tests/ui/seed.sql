insert into auth.users values
 ('00000000-0000-0000-0000-00000000000a','iagobrito@hotmail.com','{"nome":"Iago (admin)"}'),
 ('00000000-0000-0000-0000-00000000000b','roca@teste.com','{}'),('00000000-0000-0000-0000-00000000000c','pdv1@teste.com','{}'),
 ('00000000-0000-0000-0000-00000000000d','pdv2@teste.com','{}'),('00000000-0000-0000-0000-00000000000e','fin@teste.com','{}') on conflict do nothing;
insert into fl_perfis(user_id,email,nome,papel,operacoes,pode_cancelar,ativo) values
 ('00000000-0000-0000-0000-00000000000a','iagobrito@hotmail.com','Iago (admin)','master','{}',false,true),
 ('00000000-0000-0000-0000-00000000000b','roca@teste.com','Op Roca','roca','{roca}',false,true),
 ('00000000-0000-0000-0000-00000000000c','pdv1@teste.com','Caixa 1','pdv','{adega}',false,true),
 ('00000000-0000-0000-0000-00000000000d','pdv2@teste.com','Caixa 2','pdv','{adega}',false,true),
 ('00000000-0000-0000-0000-00000000000e','fin@teste.com','Financeiro','financeiro','{roca,adega}',true,true) on conflict do nothing;
insert into fl_produtos(id,nome,sku,unidade,custo_aquisicao) values ('11111111-0000-0000-0000-000000000001','Fone Bluetooth X','FONE-X','UN',60);
insert into fl_produtos(id,nome,sku,ean,unidade,preco_venda,tipo_vinho,safra) values ('22222222-0000-0000-0000-000000000001','Malbec Reserva 750ml','VIN-MAL','7891234567895','UN',80,'Tinto',2021),
  ('22222222-0000-0000-0000-000000000002','Rosé Provence 750ml','VIN-ROS',null,'UN',120,'Rosé',2023);
insert into fl_mov(produto_id,local_id,tipo,qtd,origem,origem_ref) values
  ('22222222-0000-0000-0000-000000000001',(select id from fl_locais where nome='Loja Cuiabá'),'compra',10,'manual','ini-mal'),
  ('22222222-0000-0000-0000-000000000002',(select id from fl_locais where nome='Loja Cuiabá'),'compra',1,'manual','ini-ros');
insert into fl_mov_custo select id,40,true,'teste' from fl_mov where origem_ref in ('ini-mal','ini-ros');
-- venda antiga (histórico anterior) para conferir acesso
insert into fl_vendas(canal,empresa_id,origem,origem_ref,pedido,data_venda,valor_bruto,ml_conta_id) values ('mercado_livre',(select id from fl_empresas where nome='Roca Imports'),'ml','antiga-1','1000001','2026-10-01T10:00:00-03:00',55,(select id from fl_ml_contas where apelido='Roca Imports'));
