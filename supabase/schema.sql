-- =====================================================================
-- FL GESTÃO — banco de dados (tabelas com prefixo fl_)
-- Roda no projeto Supabase da Tudo Mix, isolado por RLS próprio.
-- Idempotente: pode ser executado de novo sem apagar dados.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Perfis e permissões
-- ---------------------------------------------------------------------
create table if not exists fl_perfis(
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nome text,
  papel text check (papel in ('master','financeiro','compras','estoque','operacao')),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  ultimo_acesso timestamptz
);

create or replace function fl_papel() returns text language sql stable security definer set search_path=public as $$
  select papel from fl_perfis where user_id=auth.uid() and ativo
$$;
create or replace function fl_master() returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(fl_papel()='master',false)
$$;
create or replace function fl_tem(variadic papeis text[]) returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(fl_papel() = any(papeis) or fl_papel()='master',false)
$$;
-- quem vê custos/margens: master, financeiro, compras
create or replace function fl_ve_custo() returns boolean language sql stable as $$ select fl_tem('financeiro','compras') $$;
-- quem vê financeiro (caixa, contas): master, financeiro
create or replace function fl_ve_fin() returns boolean language sql stable as $$ select fl_tem('financeiro') $$;
create or replace function fl_logado() returns boolean language sql stable as $$ select fl_papel() is not null $$;

-- Cria o perfil (pendente) do usuário logado; o e-mail do dono vira master
create or replace function fl_entrar() returns fl_perfis language plpgsql security definer set search_path=public as $$
declare r fl_perfis; v_email text;
begin
  select email into v_email from auth.users where id=auth.uid();
  if v_email is null then raise exception 'Não autenticado'; end if;
  insert into fl_perfis(user_id,email,nome,papel)
  values (auth.uid(),v_email,coalesce((select raw_user_meta_data->>'nome' from auth.users where id=auth.uid()),split_part(v_email,'@',1)),
          case when lower(v_email) in ('iagobrito@tudomixatacado.com','iagobrito@hotmail.com') then 'master' end)
  on conflict (user_id) do update set ultimo_acesso=now()
  returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 2. Estrutura: empresas, unidades, locais, configuração
-- ---------------------------------------------------------------------
create table if not exists fl_empresas(
  id serial primary key, nome text not null, razao_social text, cnpj text unique, ativa boolean not null default true);
create table if not exists fl_unidades(
  id serial primary key, empresa_id int not null references fl_empresas(id), nome text not null, ativa boolean not null default true);
create table if not exists fl_locais(
  id serial primary key, unidade_id int references fl_unidades(id), empresa_id int not null references fl_empresas(id),
  nome text not null,
  tipo text not null default 'loja' check (tipo in ('loja','deposito','full','transito','espelho')),
  -- 'espelho' = estoque que aparece em outro sistema mas são as MESMAS unidades físicas (não soma)
  ml_conta_id int, ativo boolean not null default true);
create table if not exists fl_config(chave text primary key, valor jsonb not null, atualizado_em timestamptz default now(), atualizado_por uuid);

insert into fl_config(chave,valor) values
 ('fuso','"America/Sao_Paulo"'),
 ('rateio_frete','"valor"'),           -- 'valor' (proporcional ao valor do item) ou 'quantidade'
 ('custo_inclui_ipi','true'),
 ('custo_inclui_st','true'),
 ('custo_inclui_frete','true'),
 ('custo_inclui_seguro_outras','true'),
 ('tributos_validado_contabilidade','false'),
 ('cobertura_minima_dias','15'),
 ('sem_movimento_dias','60'),
 ('validade_alerta_dias','45'),
 ('ml_app_id','""')
on conflict (chave) do nothing;

-- Empresas: Roca Imports (marketplace) e FL Adega (vinhos: marketplace + loja física em Cuiabá)
insert into fl_empresas(nome) select 'Roca Imports' where not exists (select 1 from fl_empresas where nome='Roca Imports');
insert into fl_empresas(nome) select 'FL Adega' where not exists (select 1 from fl_empresas where nome='FL Adega');
insert into fl_unidades(empresa_id,nome) select id,'Roca Imports — Online' from fl_empresas e where nome='Roca Imports'
  and not exists (select 1 from fl_unidades u where u.empresa_id=e.id);
insert into fl_unidades(empresa_id,nome) select id,'FL Adega — Online' from fl_empresas e where nome='FL Adega'
  and not exists (select 1 from fl_unidades u where u.nome='FL Adega — Online');
insert into fl_unidades(empresa_id,nome) select id,'FL Adega — Loja Cuiabá' from fl_empresas e where nome='FL Adega'
  and not exists (select 1 from fl_unidades u where u.nome='FL Adega — Loja Cuiabá');
insert into fl_locais(unidade_id,empresa_id,nome,tipo) select u.id,u.empresa_id,'Depósito Roca','deposito' from fl_unidades u
  where u.nome='Roca Imports — Online' and not exists (select 1 from fl_locais l where l.nome='Depósito Roca');
insert into fl_locais(unidade_id,empresa_id,nome,tipo) select u.id,u.empresa_id,'Depósito FL Adega','deposito' from fl_unidades u
  where u.nome='FL Adega — Online' and not exists (select 1 from fl_locais l where l.nome='Depósito FL Adega');
insert into fl_locais(unidade_id,empresa_id,nome,tipo) select u.id,u.empresa_id,'Loja Cuiabá','loja' from fl_unidades u
  where u.nome='FL Adega — Loja Cuiabá' and not exists (select 1 from fl_locais l where l.nome='Loja Cuiabá');

-- ---------------------------------------------------------------------
-- 3. Cadastro mestre de produtos e vínculos de códigos
-- ---------------------------------------------------------------------
create table if not exists fl_produtos(
  id uuid primary key default gen_random_uuid(),
  nome text not null, categoria text, marca text, unidade text not null default 'UN',
  ean text, ncm text, eh_kit boolean not null default false,
  estoque_minimo numeric, ativo boolean not null default true,
  criado_em timestamptz not null default now(), criado_por uuid default auth.uid());
create index if not exists fl_produtos_ean on fl_produtos(ean);

create table if not exists fl_kit_itens(
  kit_id uuid references fl_produtos(id) on delete cascade, componente_id uuid references fl_produtos(id),
  qtd numeric not null check (qtd>0), primary key(kit_id,componente_id));

-- Cada código externo aponta para UM produto do cadastro mestre.
-- fator = quantas unidades do produto mestre esse código representa (caixa com 12 → 12).
create table if not exists fl_codigos(
  id bigserial primary key,
  produto_id uuid references fl_produtos(id) on delete cascade,
  origem text not null check (origem in ('pdv','ml_sku','ml_item','ml_variacao','amazon_sku','shopee_sku','fornecedor','ean','interno')),
  escopo text not null default '',      -- conta ML, CNPJ do fornecedor etc.
  codigo text not null,
  descricao text, fator numeric not null default 1 check (fator>0),
  status text not null default 'confirmado' check (status in ('confirmado','sugerido','rejeitado')),
  motivo_sugestao text, confirmado_por uuid, confirmado_em timestamptz,
  unique(origem,escopo,codigo));
create index if not exists fl_codigos_prod on fl_codigos(produto_id);

-- ---------------------------------------------------------------------
-- 4. Contas do Mercado Livre (tokens ficam em tabela sem acesso pelo site)
-- ---------------------------------------------------------------------
create table if not exists fl_ml_contas(
  id serial primary key, empresa_id int not null references fl_empresas(id), apelido text not null,
  ml_user_id bigint unique, nickname text, status text not null default 'nao_conectada',
  baixa_estoque_nao_full text not null default 'sistema' check (baixa_estoque_nao_full in ('pdv','sistema')),
  conectada_em timestamptz, ultima_sync timestamptz);
alter table fl_ml_contas add column if not exists saldo_disponivel numeric;
alter table fl_ml_contas add column if not exists saldo_a_liberar numeric;
alter table fl_ml_contas add column if not exists saldo_bloqueado numeric;
alter table fl_ml_contas add column if not exists saldo_em timestamptz;
create table if not exists fl_ml_tokens(
  conta_id int primary key references fl_ml_contas(id) on delete cascade,
  access_token text, refresh_token text, expira_em timestamptz, atualizado_em timestamptz default now());
create table if not exists fl_ml_oauth(conta_id int primary key references fl_ml_contas(id) on delete cascade, state text not null, criado_em timestamptz default now());
alter table fl_ml_oauth enable row level security;
create or replace function fl_ml_iniciar_oauth(p_conta int) returns text language plpgsql security definer set search_path=public as $$
declare s text;
begin
  if not fl_master() then raise exception 'Somente o administrador conecta contas'; end if;
  s:=p_conta||'.'||encode(gen_random_bytes(18),'hex');
  insert into fl_ml_oauth values (p_conta,s,now()) on conflict (conta_id) do update set state=excluded.state,criado_em=now();
  return s;
end $$;
insert into fl_ml_contas(empresa_id,apelido) select id,'Roca Imports' from fl_empresas where nome='Roca Imports'
  and not exists (select 1 from fl_ml_contas where apelido='Roca Imports');
insert into fl_ml_contas(empresa_id,apelido) select id,'FL Adega' from fl_empresas where nome='FL Adega'
  and not exists (select 1 from fl_ml_contas where apelido='FL Adega');

create table if not exists fl_ml_anuncios(
  conta_id int references fl_ml_contas(id), item_id text, variacao_id text not null default '',
  titulo text, sku text, preco numeric, status text, logistica text, inventory_id text,
  estoque_disponivel numeric, estoque_full numeric, produto_id uuid references fl_produtos(id),
  atualizado_em timestamptz default now(), primary key(conta_id,item_id,variacao_id));

-- ---------------------------------------------------------------------
-- 5. Notas fiscais (entrada e saída)
-- ---------------------------------------------------------------------
create table if not exists fl_notas(
  id bigserial primary key,
  tipo text not null check (tipo in ('entrada','saida')),
  empresa_id int references fl_empresas(id), unidade_id int references fl_unidades(id),
  parceiro_nome text, parceiro_doc text,
  modelo text, numero text, serie text, chave text unique,
  emissao timestamptz, data_entrada date,
  situacao text not null default 'autorizada' check (situacao in ('autorizada','cancelada','denegada','em_digitacao','desconhecida')),
  natureza text, eh_bonificacao boolean not null default false,
  nota_relacionada_id bigint references fl_notas(id),   -- bonificação → compra
  valor_produtos numeric, desconto numeric default 0, frete numeric default 0, seguro numeric default 0, outras numeric default 0,
  ipi numeric default 0, icms_st numeric default 0, icms numeric default 0, pis numeric default 0, cofins numeric default 0,
  valor_total numeric,
  despesa_extra numeric not null default 0, despesa_extra_desc text,   -- ex.: CT-e pago à parte, rateado pela regra
  origem text not null default 'xml' check (origem in ('xml','manual','imagem')),
  conferida boolean not null default true,   -- notas por leitura de imagem entram como false
  xml_path text, pdf_path text, obs text,
  status_receb text not null default 'pendente' check (status_receb in ('pendente','parcial','recebida','nao_aplica')),
  status_pgto text not null default 'pendente' check (status_pgto in ('pendente','parcial','pago','nao_aplica')),
  criado_em timestamptz default now(), criado_por uuid default auth.uid());

create table if not exists fl_nota_itens(
  id bigserial primary key, nota_id bigint not null references fl_notas(id) on delete cascade, n_item int not null,
  codigo text, ean text, descricao text, ncm text, cfop text, unidade text,
  qtd numeric not null, valor_unit numeric, valor_total numeric,
  desconto numeric default 0, frete numeric default 0, seguro numeric default 0, outras numeric default 0,
  ipi numeric default 0, icms_st numeric default 0, icms numeric default 0,
  bonificacao boolean not null default false, lote text, validade date,
  produto_id uuid references fl_produtos(id), fator numeric not null default 1,
  unique(nota_id,n_item));

create table if not exists fl_anexos(
  id bigserial primary key, entidade text not null, entidade_id text not null,
  nome text, caminho text not null, tipo text, criado_em timestamptz default now(), criado_por uuid default auth.uid());

-- Recebimento físico (separado da emissão e do pagamento)
create table if not exists fl_recebimentos(
  id bigserial primary key, nota_id bigint references fl_notas(id), local_id int references fl_locais(id),
  data date not null default current_date, responsavel uuid default auth.uid(), obs text, criado_em timestamptz default now());
create table if not exists fl_receb_itens(
  id bigserial primary key, recebimento_id bigint not null references fl_recebimentos(id) on delete cascade,
  nota_item_id bigint references fl_nota_itens(id), produto_id uuid references fl_produtos(id),
  qtd_recebida numeric not null default 0,    -- em unidades do cadastro mestre
  qtd_avariada numeric not null default 0, obs text);

-- ---------------------------------------------------------------------
-- 6. Estoque: razão de movimentações (sem custo) + custo separado
-- ---------------------------------------------------------------------
create table if not exists fl_mov(
  id bigserial primary key,
  produto_id uuid not null references fl_produtos(id), local_id int not null references fl_locais(id),
  data timestamptz not null default now(),
  tipo text not null check (tipo in ('saldo_inicial','compra','bonificacao','venda','devolucao_venda','devolucao_compra',
                                     'transferencia_saida','transferencia_entrada','perda','ajuste','consumo_interno')),
  qtd numeric not null,           -- positivo entra, negativo sai (unidades do cadastro mestre)
  origem text not null check (origem in ('pdv','ml','amazon','shopee','venda','nf','manual','importacao')),
  origem_ref text not null,       -- chave única da origem → reimportar não duplica
  documento text, nota_id bigint references fl_notas(id), venda_id bigint, recebimento_id bigint references fl_recebimentos(id),
  responsavel text, obs text, criado_em timestamptz default now(), criado_por uuid default auth.uid(),
  unique(origem,origem_ref));
create index if not exists fl_mov_prod on fl_mov(produto_id,data);

create table if not exists fl_mov_custo(
  mov_id bigint primary key references fl_mov(id) on delete cascade,
  custo_unit numeric not null check (custo_unit>=0),
  confiavel boolean not null default true,   -- custo vindo do PDV da loja sem nota = false
  fonte text);

-- Histórico do custo médio ponderado (derivado; reconstruído por fl_recalcular_custo)
create table if not exists fl_custo_hist(
  id bigserial primary key, produto_id uuid not null references fl_produtos(id), data timestamptz not null,
  mov_id bigint references fl_mov(id) on delete cascade,
  qtd_entrada numeric, custo_entrada numeric, saldo_antes numeric, custo_medio_antes numeric,
  saldo_depois numeric, custo_medio_depois numeric, nota_id bigint);
create index if not exists fl_custo_hist_prod on fl_custo_hist(produto_id,data);

-- Saldos informados pelos sistemas de origem (para conferir divergência)
create table if not exists fl_saldos_externos(
  id bigserial primary key, fonte text not null, produto_id uuid references fl_produtos(id), local_id int references fl_locais(id),
  codigo text, data timestamptz not null, qtd numeric not null, unique(fonte,local_id,codigo,data));

-- ---------------------------------------------------------------------
-- 7. Vendas (loja e Mercado Livre)
-- ---------------------------------------------------------------------
create table if not exists fl_vendas(
  id bigserial primary key,
  canal text not null check (canal in ('loja','mercado_livre','amazon','shopee','outro')),
  empresa_id int references fl_empresas(id), unidade_id int references fl_unidades(id), ml_conta_id int references fl_ml_contas(id),
  origem text not null check (origem in ('pdv','caixa','ml','amazon','shopee','nf','manual','importacao')),
  origem_ref text not null, pedido text, pack_id text,
  data_venda timestamptz not null, status text not null default 'concluida'
    check (status in ('concluida','cancelada','devolvida','devolvida_parcial','pendente')),
  cliente text, logistica text,
  valor_bruto numeric not null default 0, desconto numeric not null default 0, valor_cancelado numeric not null default 0,
  valor_devolvido numeric not null default 0, frete_cobrado numeric not null default 0,
  tarifa_venda numeric not null default 0, frete_vendedor numeric not null default 0, outros_custos_var numeric not null default 0,
  valor_liquido_previsto numeric, data_pagamento date, data_liberacao date, liberado boolean,
  nota_id bigint references fl_notas(id),
  duplicada_de bigint references fl_vendas(id),   -- mesma venda registrada em outro sistema: não soma
  conciliada boolean not null default false, obs text,
  importado_em timestamptz default now(), unique(origem,origem_ref));
create index if not exists fl_vendas_data on fl_vendas(data_venda);

create table if not exists fl_venda_itens(
  id bigserial primary key, venda_id bigint not null references fl_vendas(id) on delete cascade, n int not null default 1,
  produto_id uuid references fl_produtos(id), codigo text, sku text, item_ml text, variacao_ml text, descricao text,
  qtd numeric not null, preco_unit numeric not null default 0, desconto numeric not null default 0,
  tarifa numeric not null default 0, eh_servico boolean not null default false, unique(venda_id,n));

-- custo congelado no momento da venda (compra nova não altera venda antiga)
create table if not exists fl_venda_itens_custo(
  item_id bigint primary key references fl_venda_itens(id) on delete cascade,
  custo_unit numeric, status text not null check (status in ('calculado','informado','ausente','servico')),
  calculado_em timestamptz default now(), revisao_sugerida numeric);

-- ---------------------------------------------------------------------
-- 8. Financeiro
-- ---------------------------------------------------------------------
create table if not exists fl_contas_fin(
  id serial primary key, empresa_id int references fl_empresas(id), nome text not null,
  tipo text not null check (tipo in ('banco','caixa','mercado_pago','cartao','outro')),
  saldo_inicial numeric, data_saldo_inicial date, ml_conta_id int references fl_ml_contas(id), ativa boolean not null default true);

create table if not exists fl_lancamentos(
  id bigserial primary key,
  tipo text not null check (tipo in ('pagar','receber','transferencia')),
  natureza text not null check (natureza in ('venda','fornecedor','despesa_fixa','despesa_variavel','imposto','folha',
     'aporte_socio','emprestimo_recebido','emprestimo_pago','retirada_socio','transferencia_interna','tarifa','outro')),
  empresa_id int references fl_empresas(id),           -- empresa dona da obrigação/receita
  empresa_assumiu_id int references fl_empresas(id),   -- quem efetivamente assumiu a despesa
  categoria text, descricao text not null, parceiro text,
  valor numeric not null check (valor>=0), competencia date, vencimento date,
  status text not null default 'aberto' check (status in ('aberto','pago','parcial','cancelado')),
  valor_pago numeric, data_pagamento date, conta_id int references fl_contas_fin(id), conta_destino_id int references fl_contas_fin(id),
  pago_por text, retido boolean not null default false,
  nota_id bigint references fl_notas(id), venda_id bigint references fl_vendas(id),
  origem text not null default 'manual', origem_ref text, obs text,
  criado_em timestamptz default now(), criado_por uuid default auth.uid());
drop index if exists fl_lanc_origem;
create unique index if not exists fl_lanc_origem_u on fl_lancamentos(origem,origem_ref);

-- ---------------------------------------------------------------------
-- 9. Integrações, importações, pendências e auditoria
-- ---------------------------------------------------------------------
create table if not exists fl_sync_log(
  id bigserial primary key, fonte text not null, conta text, tipo text,
  iniciado_em timestamptz default now(), terminado_em timestamptz,
  status text not null default 'rodando' check (status in ('rodando','ok','parcial','erro')),
  lidos int default 0, gravados int default 0, duplicados int default 0, erros int default 0,
  mensagem text, detalhes jsonb, usuario uuid default auth.uid());

create table if not exists fl_pendencias(
  id bigserial primary key,
  tipo text not null, -- venda_sem_nota, nota_sem_mov, receb_divergente, venda_sem_custo, sem_vinculo, qtd_divergente, duplicidade, cancel_nao_conciliado, unidade_divergente, produto_duplicado, custo_revisado, outro
  entidade text, entidade_id text, chave text unique,   -- chave evita abrir a mesma pendência duas vezes
  descricao text not null, valor numeric,
  responsavel uuid references fl_perfis(user_id),
  status text not null default 'aberta' check (status in ('aberta','em_analise','resolvida','ignorada')),
  obs text, criado_em timestamptz default now(), resolvido_em timestamptz);
create table if not exists fl_pendencia_hist(
  id bigserial primary key, pendencia_id bigint references fl_pendencias(id) on delete cascade,
  status text, obs text, usuario uuid default auth.uid(), em timestamptz default now());

create table if not exists fl_auditoria(
  id bigserial primary key, tabela text, operacao text, registro text, antes jsonb, depois jsonb,
  usuario uuid default auth.uid(), em timestamptz default now());

create or replace function fl_audit() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into fl_auditoria(tabela,operacao,registro,antes,depois)
  values (tg_table_name, tg_op,
          coalesce(case when tg_op='DELETE' then to_jsonb(old)->>'id' else to_jsonb(new)->>'id' end,
                   case when tg_op='DELETE' then to_jsonb(old)->>'chave' else to_jsonb(new)->>'chave' end),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new,old);
end $$;

do $$ declare t text; begin
  foreach t in array array['fl_perfis','fl_config','fl_produtos','fl_kit_itens','fl_codigos','fl_notas','fl_lancamentos',
                           'fl_contas_fin','fl_mov','fl_mov_custo','fl_venda_itens_custo','fl_ml_contas','fl_empresas','fl_locais'] loop
    execute format('drop trigger if exists %I on %I', t||'_audit', t);
    -- movimentações: audita só alterações/exclusões (inserções já têm origem e autor)
    if t in ('fl_mov','fl_mov_custo') then
      execute format('create trigger %I after update or delete on %I for each row execute function fl_audit()', t||'_audit', t);
    else
      execute format('create trigger %I after insert or update or delete on %I for each row execute function fl_audit()', t||'_audit', t);
    end if;
  end loop; end $$;

-- ---------------------------------------------------------------------
-- 10. Custo médio ponderado
-- ---------------------------------------------------------------------
-- Reconstrói o histórico de custo do produto a partir do razão (todas as unidades da empresa somadas).
-- Entradas com custo entram na média; bonificação vinculada entra a custo 0 (dilui o custo da compra);
-- saídas reduzem o saldo sem mudar a média.
create or replace function fl_recalcular_custo(p_produto uuid) returns void language plpgsql security definer set search_path=public as $$
declare r record; saldo numeric:=0; cm numeric:=null; novo numeric;
begin
  delete from fl_custo_hist where produto_id=p_produto;
  for r in select m.id,m.data,m.qtd,m.tipo,m.nota_id,c.custo_unit
           from fl_mov m join fl_locais l on l.id=m.local_id and l.tipo<>'espelho'
           left join fl_mov_custo c on c.mov_id=m.id
           where m.produto_id=p_produto and m.tipo not in ('transferencia_saida','transferencia_entrada')
           order by m.data,m.id loop
    if r.qtd>0 and r.custo_unit is not null then
      if saldo<=0 or cm is null then novo:=r.custo_unit;
      else novo:=(saldo*cm + r.qtd*r.custo_unit)/(saldo+r.qtd); end if;
      insert into fl_custo_hist(produto_id,data,mov_id,qtd_entrada,custo_entrada,saldo_antes,custo_medio_antes,saldo_depois,custo_medio_depois,nota_id)
      values (p_produto,r.data,r.id,r.qtd,r.custo_unit,saldo,cm,saldo+r.qtd,round(novo,6),r.nota_id);
      cm:=novo;
    end if;
    saldo:=saldo+r.qtd;
  end loop;
end $$;

create or replace function fl_custo_em(p_produto uuid, p_data timestamptz) returns numeric language plpgsql stable security definer set search_path=public as $$
declare v numeric; k record; tot numeric:=0; falta boolean:=false;
begin
  if exists(select 1 from fl_produtos where id=p_produto and eh_kit) then
    for k in select componente_id,qtd from fl_kit_itens where kit_id=p_produto loop
      v:=fl_custo_em(k.componente_id,p_data);
      if v is null then falta:=true; else tot:=tot+v*k.qtd; end if;
    end loop;
    return case when falta or tot=0 then null else tot end;
  end if;
  select custo_medio_depois into v from fl_custo_hist where produto_id=p_produto and data<=p_data order by data desc,id desc limit 1;
  return v;
end $$;

-- Qualquer movimento (entrada, saída, custo) muda a média seguinte: recalcula os produtos afetados (por comando)
create or replace function fl_mov_recalc_ins() returns trigger language plpgsql security definer set search_path=public as $$
declare p uuid; begin
  for p in select distinct produto_id from novos loop perform fl_recalcular_custo(p); end loop; return null; end $$;
create or replace function fl_mov_recalc_del() returns trigger language plpgsql security definer set search_path=public as $$
declare p uuid; begin
  for p in select distinct produto_id from velhos loop perform fl_recalcular_custo(p); end loop; return null; end $$;
create or replace function fl_movc_recalc_ins() returns trigger language plpgsql security definer set search_path=public as $$
declare p uuid; begin
  for p in select distinct m.produto_id from novos n join fl_mov m on m.id=n.mov_id loop perform fl_recalcular_custo(p); end loop; return null; end $$;
create or replace function fl_movc_recalc_del() returns trigger language plpgsql security definer set search_path=public as $$
declare p uuid; begin
  for p in select distinct m.produto_id from velhos n join fl_mov m on m.id=n.mov_id loop perform fl_recalcular_custo(p); end loop; return null; end $$;
drop trigger if exists fl_mov_custo_recalc on fl_mov_custo;
drop trigger if exists fl_movc_ins on fl_mov_custo; drop trigger if exists fl_movc_upd on fl_mov_custo; drop trigger if exists fl_movc_del on fl_mov_custo;
drop trigger if exists fl_mov_ins on fl_mov; drop trigger if exists fl_mov_del on fl_mov;
create trigger fl_mov_ins after insert on fl_mov referencing new table as novos for each statement execute function fl_mov_recalc_ins();
create trigger fl_mov_del after delete on fl_mov referencing old table as velhos for each statement execute function fl_mov_recalc_del();
create trigger fl_movc_ins after insert on fl_mov_custo referencing new table as novos for each statement execute function fl_movc_recalc_ins();
create trigger fl_movc_upd after update on fl_mov_custo referencing new table as novos for each statement execute function fl_movc_recalc_ins();
create trigger fl_movc_del after delete on fl_mov_custo referencing old table as velhos for each statement execute function fl_movc_recalc_del();

-- Congela o custo do item vendido. Se uma compra retroativa mudar o custo, NÃO altera:
-- registra revisao_sugerida e abre pendência.
create or replace function fl_congelar_custo(p_item bigint) returns void language plpgsql security definer set search_path=public as $$
declare i record; c numeric; atual fl_venda_itens_custo;
begin
  select vi.*, v.data_venda into i from fl_venda_itens vi join fl_vendas v on v.id=vi.venda_id where vi.id=p_item;
  if i is null then return; end if;
  select * into atual from fl_venda_itens_custo where item_id=p_item;
  if i.eh_servico then
    insert into fl_venda_itens_custo(item_id,custo_unit,status) values (p_item,null,'servico') on conflict (item_id) do nothing; return;
  end if;
  c:= case when i.produto_id is null then null else fl_custo_em(i.produto_id,i.data_venda) end;
  if atual.item_id is null or atual.status='ausente' then
    insert into fl_venda_itens_custo(item_id,custo_unit,status) values (p_item,c,case when c is null then 'ausente' else 'calculado' end)
    on conflict (item_id) do update set custo_unit=excluded.custo_unit,status=excluded.status,calculado_em=now();
  elsif atual.status='calculado' and c is not null and abs(c-atual.custo_unit)>0.005 then
    update fl_venda_itens_custo set revisao_sugerida=c where item_id=p_item;
    insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
    values ('custo_revisado','venda_item',p_item::text,'custo_revisado:'||p_item,
            'Nova entrada retroativa mudaria o custo desta venda de '||round(atual.custo_unit,2)||' para '||round(c,2)||'. O resultado antigo foi mantido; revise.',
            round((c-atual.custo_unit)*i.qtd,2))
    on conflict (chave) do update set descricao=excluded.descricao,valor=excluded.valor,status='aberta';
  end if;
end $$;

create or replace function fl_venda_item_trg() returns trigger language plpgsql security definer set search_path=public as $$
begin perform fl_congelar_custo(new.id); return null; end $$;
drop trigger if exists fl_venda_item_custo on fl_venda_itens;
create trigger fl_venda_item_custo after insert or update of produto_id,eh_servico on fl_venda_itens for each row execute function fl_venda_item_trg();

-- Recalcula custos ausentes e sinaliza revisões (chamar após vincular SKUs ou importar notas)
create or replace function fl_reprocessar_custos_vendas(p_produto uuid default null) returns int language plpgsql security definer set search_path=public as $$
declare r record; n int:=0;
begin
  if not fl_ve_custo() then raise exception 'Sem permissão'; end if;
  for r in select vi.id from fl_venda_itens vi where (p_produto is null or vi.produto_id=p_produto) loop
    perform fl_congelar_custo(r.id); n:=n+1;
  end loop; return n;
end $$;

-- ---------------------------------------------------------------------
-- 11. Notas: lançar entrada no estoque a partir do recebimento
-- ---------------------------------------------------------------------
-- custo unitário de aquisição do item (em unidades do cadastro mestre), seguindo a configuração
create or replace function fl_custo_item_nota(p_item bigint) returns numeric language plpgsql stable security definer set search_path=public as $$
declare i fl_nota_itens; n fl_notas; tot numeric; base numeric; extra numeric:=0; soma_base numeric;
  inc_ipi boolean; inc_st boolean; inc_fr boolean; inc_out boolean; regra text;
begin
  if auth.uid() is not null and not fl_ve_custo() and not fl_tem('estoque') then return null; end if;
  select * into i from fl_nota_itens where id=p_item; select * into n from fl_notas where id=i.nota_id;
  if i.bonificacao or n.eh_bonificacao then return 0; end if;
  select (valor)::text::boolean into inc_ipi from fl_config where chave='custo_inclui_ipi';
  select (valor)::text::boolean into inc_st from fl_config where chave='custo_inclui_st';
  select (valor)::text::boolean into inc_fr from fl_config where chave='custo_inclui_frete';
  select (valor)::text::boolean into inc_out from fl_config where chave='custo_inclui_seguro_outras';
  select valor#>>'{}' into regra from fl_config where chave='rateio_frete';
  tot:=coalesce(i.valor_total,0)-coalesce(i.desconto,0)
       +case when inc_fr then coalesce(i.frete,0) else 0 end
       +case when inc_out then coalesce(i.seguro,0)+coalesce(i.outras,0) else 0 end
       +case when inc_ipi then coalesce(i.ipi,0) else 0 end
       +case when inc_st then coalesce(i.icms_st,0) else 0 end;
  if n.despesa_extra>0 and inc_fr then
    if regra='quantidade' then
      select sum(qtd*fator) into soma_base from fl_nota_itens where nota_id=n.id and not bonificacao;
      extra:=n.despesa_extra*(i.qtd*i.fator)/nullif(soma_base,0);
    else
      select sum(valor_total-coalesce(desconto,0)) into soma_base from fl_nota_itens where nota_id=n.id and not bonificacao;
      extra:=n.despesa_extra*(i.valor_total-coalesce(i.desconto,0))/nullif(soma_base,0);
    end if;
  end if;
  return round((tot+coalesce(extra,0))/nullif(i.qtd*i.fator,0),6);
end $$;

-- Registra um recebimento (total ou parcial). p_itens: [{"nota_item_id":1,"qtd":10,"avaria":0,"obs":""}] (qtd em unidades do cadastro)
create or replace function fl_receber_nota(p_nota bigint, p_local int, p_data date, p_itens jsonb, p_obs text default null)
returns bigint language plpgsql security definer set search_path=public as $$
declare rid bigint; x jsonb; it fl_nota_itens; n fl_notas; mid bigint; q numeric; c numeric; prev numeric; tot_prev numeric; tot_rec numeric;
begin
  if not fl_tem('compras','estoque') then raise exception 'Sem permissão para receber mercadoria'; end if;
  select * into n from fl_notas where id=p_nota;
  if n.tipo<>'entrada' then raise exception 'Somente notas de entrada'; end if;
  if not n.conferida then raise exception 'Nota lida por imagem ainda não conferida'; end if;
  insert into fl_recebimentos(nota_id,local_id,data,obs) values (p_nota,p_local,coalesce(p_data,current_date),p_obs) returning id into rid;
  for x in select * from jsonb_array_elements(p_itens) loop
    select * into it from fl_nota_itens where id=(x->>'nota_item_id')::bigint and nota_id=p_nota;
    if it.id is null then continue; end if;
    if it.produto_id is null then raise exception 'Item % (%) sem vínculo com o cadastro mestre', it.n_item, it.descricao; end if;
    q:=coalesce((x->>'qtd')::numeric,0);
    insert into fl_receb_itens(recebimento_id,nota_item_id,produto_id,qtd_recebida,qtd_avariada,obs)
    values (rid,it.id,it.produto_id,q,coalesce((x->>'avaria')::numeric,0),x->>'obs');
    if q>0 then
      insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,nota_id,recebimento_id,responsavel)
      values (it.produto_id,p_local,(coalesce(p_data,current_date)::timestamp + interval '12 hours'),
              case when it.bonificacao or n.eh_bonificacao then 'bonificacao' else 'compra' end,
              q,'nf','receb:'||rid||':'||it.id,'NF '||n.numero||'/'||coalesce(n.serie,''),p_nota,rid,
              (select coalesce(nome,email) from fl_perfis where user_id=auth.uid()))
      returning id into mid;
      c:=fl_custo_item_nota(it.id);
      if n.eh_bonificacao and n.nota_relacionada_id is null then
        -- bonificação sem compra vinculada: entra a custo zero, mas fica pendente
        insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao)
        values ('outro','nota',p_nota::text,'bonif_sem_compra:'||p_nota,'Bonificação NF '||n.numero||' sem compra vinculada') on conflict do nothing;
      end if;
      if c is not null then insert into fl_mov_custo(mov_id,custo_unit,confiavel,fonte) values (mid,c,true,'NF '||n.numero); end if;
    end if;
  end loop;
  -- status do recebimento da nota
  select sum(qtd*fator) into tot_prev from fl_nota_itens where nota_id=p_nota;
  select sum(ri.qtd_recebida) into tot_rec from fl_receb_itens ri join fl_recebimentos r on r.id=ri.recebimento_id where r.nota_id=p_nota;
  update fl_notas set status_receb=case when coalesce(tot_rec,0)<=0 then 'pendente' when tot_rec<tot_prev then 'parcial' else 'recebida' end where id=p_nota;
  if tot_rec>tot_prev then
    insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao)
    values ('qtd_divergente','nota',p_nota::text,'receb_maior:'||p_nota,'Recebido mais do que a NF '||n.numero||' informa')
    on conflict (chave) do update set status='aberta';
  end if;
  return rid;
end $$;

-- Para o perfil Estoque: itens a receber SEM valores
create or replace function fl_itens_a_receber() returns table(nota_id bigint, numero text, fornecedor text, emissao timestamptz,
  nota_item_id bigint, descricao text, unidade text, produto_id uuid, produto text, qtd_prevista numeric, qtd_recebida numeric, lote text, validade date)
language sql stable security definer set search_path=public as $$
  select n.id,n.numero,n.parceiro_nome,n.emissao,i.id,i.descricao,i.unidade,i.produto_id,p.nome,i.qtd*i.fator,
         coalesce((select sum(ri.qtd_recebida) from fl_receb_itens ri where ri.nota_item_id=i.id),0), i.lote, i.validade
  from fl_notas n join fl_nota_itens i on i.nota_id=n.id left join fl_produtos p on p.id=i.produto_id
  where fl_tem('compras','estoque') and n.tipo='entrada' and n.status_receb in ('pendente','parcial') and n.situacao='autorizada'
  order by n.emissao, i.n_item
$$;

-- ---------------------------------------------------------------------
-- 12. Visões de estoque
-- ---------------------------------------------------------------------
create or replace view fl_v_saldos with (security_invoker=true) as
  select m.produto_id, m.local_id, l.empresa_id, l.tipo as tipo_local, sum(m.qtd) as saldo, max(m.data) as ultima_mov,
         min(m.data) filter (where m.tipo='saldo_inicial') as data_saldo_inicial
  from fl_mov m join fl_locais l on l.id=m.local_id group by 1,2,3,4;

-- ---------------------------------------------------------------------
-- 13. Gravação idempotente de vendas (usada pelo importador e pela sincronização)
-- p_venda: objeto da venda; p_itens: lista de itens. Retorna 'novo', 'atualizado' ou 'igual'.
-- ---------------------------------------------------------------------
create or replace function fl_gravar_venda(p_venda jsonb, p_itens jsonb) returns text language plpgsql security definer set search_path=public as $$
declare vid bigint; ant fl_vendas; x jsonb; k int:=0; pid uuid; res text;
begin
  if auth.uid() is not null and not fl_tem('financeiro','operacao') then raise exception 'Sem permissão'; end if;
  select * into ant from fl_vendas where origem=p_venda->>'origem' and origem_ref=p_venda->>'origem_ref';
  insert into fl_vendas(canal,empresa_id,unidade_id,ml_conta_id,origem,origem_ref,pedido,pack_id,data_venda,status,cliente,logistica,
     valor_bruto,desconto,valor_cancelado,valor_devolvido,frete_cobrado,tarifa_venda,frete_vendedor,outros_custos_var,
     valor_liquido_previsto,data_pagamento,data_liberacao,liberado)
  values (p_venda->>'canal',(p_venda->>'empresa_id')::int,(p_venda->>'unidade_id')::int,(p_venda->>'ml_conta_id')::int,
     p_venda->>'origem',p_venda->>'origem_ref',p_venda->>'pedido',p_venda->>'pack_id',(p_venda->>'data_venda')::timestamptz,
     coalesce(p_venda->>'status','concluida'),p_venda->>'cliente',p_venda->>'logistica',
     coalesce((p_venda->>'valor_bruto')::numeric,0),coalesce((p_venda->>'desconto')::numeric,0),coalesce((p_venda->>'valor_cancelado')::numeric,0),
     coalesce((p_venda->>'valor_devolvido')::numeric,0),coalesce((p_venda->>'frete_cobrado')::numeric,0),coalesce((p_venda->>'tarifa_venda')::numeric,0),
     coalesce((p_venda->>'frete_vendedor')::numeric,0),coalesce((p_venda->>'outros_custos_var')::numeric,0),
     (p_venda->>'valor_liquido_previsto')::numeric,(p_venda->>'data_pagamento')::date,(p_venda->>'data_liberacao')::date,(p_venda->>'liberado')::boolean)
  on conflict (origem,origem_ref) do update set status=excluded.status,valor_bruto=excluded.valor_bruto,desconto=excluded.desconto,
     valor_cancelado=excluded.valor_cancelado,valor_devolvido=excluded.valor_devolvido,frete_cobrado=excluded.frete_cobrado,
     tarifa_venda=excluded.tarifa_venda,frete_vendedor=excluded.frete_vendedor,outros_custos_var=excluded.outros_custos_var,
     valor_liquido_previsto=excluded.valor_liquido_previsto,data_pagamento=excluded.data_pagamento,data_liberacao=excluded.data_liberacao,
     liberado=excluded.liberado,cliente=coalesce(excluded.cliente,fl_vendas.cliente),logistica=coalesce(excluded.logistica,fl_vendas.logistica)
  returning id into vid;
  res:=case when ant.id is null then 'novo'
            when ant.status is distinct from coalesce(p_venda->>'status','concluida') or ant.valor_bruto is distinct from coalesce((p_venda->>'valor_bruto')::numeric,0)
                 or ant.data_liberacao is distinct from (p_venda->>'data_liberacao')::date or ant.liberado is distinct from (p_venda->>'liberado')::boolean then 'atualizado'
            else 'igual' end;
  for x in select * from jsonb_array_elements(coalesce(p_itens,'[]')) loop
    k:=k+1; pid:=null;
    -- vínculo pelo cadastro de códigos (somente confirmados)
    select produto_id into pid from fl_codigos where status='confirmado' and produto_id is not null and (
         (origem='ml_variacao' and codigo=x->>'variacao_ml' and coalesce(x->>'variacao_ml','')<>'')
      or (origem='ml_sku' and codigo=x->>'sku' and coalesce(x->>'sku','')<>'')
      or (origem='ml_item' and codigo=x->>'item_ml' and coalesce(x->>'item_ml','')<>'')
      or (origem='pdv' and codigo=x->>'codigo' and coalesce(x->>'codigo','')<>'')
      or (origem='ean' and codigo=x->>'ean' and coalesce(x->>'ean','')<>''))
      order by case origem when 'ml_variacao' then 1 when 'ml_sku' then 2 when 'ml_item' then 3 when 'pdv' then 4 else 5 end limit 1;
    insert into fl_venda_itens(venda_id,n,produto_id,codigo,sku,item_ml,variacao_ml,descricao,qtd,preco_unit,desconto,tarifa,eh_servico)
    values (vid,k,pid,x->>'codigo',x->>'sku',x->>'item_ml',x->>'variacao_ml',x->>'descricao',(x->>'qtd')::numeric,
            coalesce((x->>'preco_unit')::numeric,0),coalesce((x->>'desconto')::numeric,0),coalesce((x->>'tarifa')::numeric,0),
            coalesce((x->>'eh_servico')::boolean,false))
    on conflict (venda_id,n) do update set qtd=excluded.qtd,preco_unit=excluded.preco_unit,desconto=excluded.desconto,tarifa=excluded.tarifa,
       produto_id=coalesce(fl_venda_itens.produto_id,excluded.produto_id);
  end loop;
  return res;
end $$;

-- Vincula um código a um produto e aplica nos itens já importados
create or replace function fl_vincular_codigo(p_origem text, p_escopo text, p_codigo text, p_produto uuid, p_fator numeric default 1, p_descricao text default null)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not fl_tem('compras','estoque','operacao','financeiro') then raise exception 'Sem permissão'; end if;
  insert into fl_codigos(produto_id,origem,escopo,codigo,descricao,fator,status,confirmado_por,confirmado_em)
  values (p_produto,p_origem,coalesce(p_escopo,''),p_codigo,p_descricao,coalesce(p_fator,1),'confirmado',auth.uid(),now())
  on conflict (origem,escopo,codigo) do update set produto_id=excluded.produto_id,fator=excluded.fator,status='confirmado',
     confirmado_por=auth.uid(),confirmado_em=now();
  if p_origem in ('ml_sku','ml_item','ml_variacao','pdv','ean') then
    update fl_venda_itens set produto_id=p_produto where produto_id is null and (
      (p_origem='ml_sku' and sku=p_codigo) or (p_origem='ml_item' and item_ml=p_codigo) or (p_origem='ml_variacao' and variacao_ml=p_codigo)
      or (p_origem='pdv' and codigo=p_codigo));
  end if;
  if p_origem='fornecedor' then
    update fl_nota_itens i set produto_id=p_produto, fator=coalesce(p_fator,1)
    from fl_notas n where n.id=i.nota_id and i.produto_id is null and i.codigo=p_codigo and n.parceiro_doc=p_escopo;
  end if;
  if p_origem='ean' then
    update fl_nota_itens set produto_id=p_produto where produto_id is null and ean=p_codigo;
  end if;
  update fl_pendencias set status='resolvida',resolvido_em=now() where chave='sem_vinculo:'||p_origem||':'||coalesce(p_escopo,'')||':'||p_codigo and status<>'resolvida';
end $$;

-- ---------------------------------------------------------------------
-- 14. Geração automática da central de divergências (idempotente)
-- ---------------------------------------------------------------------
create or replace function fl_gerar_pendencias() returns int language plpgsql security definer set search_path=public as $$
declare n int:=0; c int;
begin
  if not fl_logado() then raise exception 'Sem permissão'; end if;
  -- itens vendidos sem vínculo
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'sem_vinculo','venda_item',min(vi.id)::text,
         'sem_vinculo:'||case when vi.variacao_ml is not null and vi.variacao_ml<>'' then 'ml_variacao::'||vi.variacao_ml
                              when vi.sku is not null and vi.sku<>'' then 'ml_sku::'||vi.sku
                              when vi.item_ml is not null then 'ml_item::'||vi.item_ml else 'pdv::'||coalesce(vi.codigo,vi.descricao) end,
         'Item vendido sem vínculo com o cadastro: '||max(vi.descricao)||' ('||count(*)||' vendas)', sum(vi.qtd*vi.preco_unit)
  from fl_venda_itens vi join fl_vendas v on v.id=vi.venda_id
  where vi.produto_id is null and not vi.eh_servico and v.duplicada_de is null
  group by 4 on conflict (chave) do update set descricao=excluded.descricao,valor=excluded.valor;
  get diagnostics c=row_count; n:=n+c;
  -- vendidos sem custo
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'venda_sem_custo','produto',p.id::text,'venda_sem_custo:'||p.id,'Vendido sem custo confiável: '||p.nome||' ('||sum(vi.qtd)||' un.)',sum(vi.qtd*vi.preco_unit)
  from fl_venda_itens vi join fl_venda_itens_custo c on c.item_id=vi.id and c.status='ausente' join fl_produtos p on p.id=vi.produto_id
  join fl_vendas v on v.id=vi.venda_id and v.duplicada_de is null
  group by p.id,p.nome on conflict (chave) do update set descricao=excluded.descricao,valor=excluded.valor,
    status=case when fl_pendencias.status='resolvida' then 'aberta' else fl_pendencias.status end;
  get diagnostics c=row_count; n:=n+c;
  -- notas de entrada sem recebimento há mais de 7 dias
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'nota_sem_mov','nota',id::text,'nota_sem_mov:'||id,'NF '||numero||' de '||coalesce(parceiro_nome,'?')||' sem recebimento lançado',valor_total
  from fl_notas where tipo='entrada' and situacao='autorizada' and status_receb='pendente' and emissao<now()-interval '7 days'
  on conflict (chave) do nothing;
  get diagnostics c=row_count; n:=n+c;
  -- vendas ML acima de R$ 0 sem nota
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'venda_sem_nota','venda',id::text,'venda_sem_nota:'||id,'Pedido '||coalesce(pedido,origem_ref)||' sem nota fiscal vinculada',valor_bruto
  from fl_vendas where nota_id is null and canal='mercado_livre' and status='concluida' and duplicada_de is null and data_venda<now()-interval '3 days'
  on conflict (chave) do nothing;
  get diagnostics c=row_count; n:=n+c;
  -- cancelamentos/devoluções não conciliados
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'cancel_nao_conciliado','venda',id::text,'cancel:'||id,'Pedido '||coalesce(pedido,origem_ref)||' '||status||' ainda não conciliado',valor_bruto
  from fl_vendas where status in ('cancelada','devolvida','devolvida_parcial') and not conciliada and duplicada_de is null
  on conflict (chave) do nothing;
  get diagnostics c=row_count; n:=n+c;
  -- recebimentos diferentes do previsto (ML liberado com valor diferente)
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'receb_divergente','lancamento',l.id::text,'receb_div:'||l.id,'Recebido '||l.valor_pago||' x previsto '||l.valor||' — '||l.descricao,l.valor_pago-l.valor
  from fl_lancamentos l where l.tipo='receber' and l.status='pago' and l.valor_pago is not null and abs(l.valor_pago-l.valor)>0.05
  on conflict (chave) do nothing;
  get diagnostics c=row_count; n:=n+c;
  -- estoque negativo
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'qtd_divergente','produto',s.produto_id::text,'neg:'||s.produto_id||':'||s.local_id,'Estoque negativo: '||p.nome||' em '||l.nome||' ('||s.saldo||')',null
  from fl_v_saldos s join fl_produtos p on p.id=s.produto_id join fl_locais l on l.id=s.local_id where s.saldo<0
  on conflict (chave) do update set status=case when fl_pendencias.status='resolvida' then 'aberta' else fl_pendencias.status end;
  get diagnostics c=row_count; n:=n+c;
  -- possíveis duplicidades: mesma data, mesmo valor, canais/origens diferentes, sem marcação
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao,valor)
  select 'duplicidade','venda',a.id::text,'dup:'||least(a.id,b.id)||':'||greatest(a.id,b.id),
         'Possível venda duplicada: '||a.origem||' '||coalesce(a.pedido,a.origem_ref)||' e '||b.origem||' '||coalesce(b.pedido,b.origem_ref),a.valor_bruto
  from fl_vendas a join fl_vendas b on a.id<b.id and a.origem<>b.origem and a.valor_bruto=b.valor_bruto and a.valor_bruto>0
       and abs(extract(epoch from a.data_venda-b.data_venda))<86400*2
  where a.duplicada_de is null and b.duplicada_de is null and a.data_venda>now()-interval '120 days'
  on conflict (chave) do nothing;
  get diagnostics c=row_count; n:=n+c;
  -- divergência de unidade: mesmo produto com fatores diferentes para o mesmo fornecedor+código não ocorre (unique); sinaliza unidade da NF ≠ cadastro com fator 1
  insert into fl_pendencias(tipo,entidade,entidade_id,chave,descricao)
  select 'unidade_divergente','nota_item',i.id::text,'un:'||i.id,'NF '||n.numero||': item "'||i.descricao||'" em '||i.unidade||' e cadastro em '||p.unidade||' com fator 1 — confira a conversão'
  from fl_nota_itens i join fl_notas n on n.id=i.nota_id join fl_produtos p on p.id=i.produto_id
  where i.fator=1 and upper(coalesce(i.unidade,'UN')) not in ('UN','UND','UNID','UNIDADE','PC','PÇ','PCT')
        and upper(coalesce(i.unidade,''))<>upper(p.unidade)
  on conflict (chave) do nothing;
  get diagnostics c=row_count; n:=n+c;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 15. RLS
-- ---------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['fl_perfis','fl_empresas','fl_unidades','fl_locais','fl_config','fl_produtos','fl_kit_itens','fl_codigos',
    'fl_ml_contas','fl_ml_tokens','fl_ml_anuncios','fl_notas','fl_nota_itens','fl_anexos','fl_recebimentos','fl_receb_itens','fl_mov','fl_mov_custo',
    'fl_custo_hist','fl_saldos_externos','fl_vendas','fl_venda_itens','fl_venda_itens_custo','fl_contas_fin','fl_lancamentos',
    'fl_sync_log','fl_pendencias','fl_pendencia_hist','fl_auditoria'] loop
    execute format('alter table %I enable row level security', t);
  end loop; end $$;

-- remove políticas antigas fl_ para recriar
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname='public' and tablename like 'fl\_%' loop
    execute format('drop policy %I on %I', r.policyname, r.tablename);
  end loop; end $$;

-- perfis: cada um vê o seu; master vê e altera todos
create policy fl_perfis_sel on fl_perfis for select using (user_id=auth.uid() or fl_master());
create policy fl_perfis_upd on fl_perfis for update using (fl_master()) with check (fl_master());
-- leitura geral para quem tem papel
create policy r on fl_empresas for select using (fl_logado());
create policy r on fl_unidades for select using (fl_logado());
create policy r on fl_locais for select using (fl_logado());
create policy r on fl_config for select using (fl_logado());
create policy r on fl_produtos for select using (fl_logado());
create policy r on fl_kit_itens for select using (fl_logado());
create policy r on fl_codigos for select using (fl_logado());
create policy r on fl_ml_contas for select using (fl_logado());
create policy r on fl_ml_anuncios for select using (fl_logado());
create policy r on fl_mov for select using (fl_logado());
create policy r on fl_saldos_externos for select using (fl_logado());
create policy r on fl_recebimentos for select using (fl_logado());
create policy r on fl_receb_itens for select using (fl_logado());
create policy r on fl_sync_log for select using (fl_logado());
create policy r on fl_vendas for select using (fl_tem('financeiro','operacao'));
create policy r on fl_venda_itens for select using (fl_tem('financeiro','operacao'));
create policy r on fl_pendencias for select using (fl_logado());
create policy r on fl_pendencia_hist for select using (fl_logado());
-- custos e notas (valores): master, financeiro, compras
create policy r on fl_mov_custo for select using (fl_ve_custo());
create policy r on fl_custo_hist for select using (fl_ve_custo());
create policy r on fl_venda_itens_custo for select using (fl_ve_custo());
create policy r on fl_notas for select using (fl_tem('financeiro','compras') or (tipo='saida' and fl_tem('operacao')));
create policy r on fl_nota_itens for select using (fl_ve_custo());
create policy r on fl_anexos for select using (fl_logado());
-- financeiro: master, financeiro
create policy r on fl_contas_fin for select using (fl_ve_fin());
create policy r on fl_lancamentos for select using (fl_ve_fin());
create policy r on fl_auditoria for select using (fl_master());
-- fl_ml_tokens: nenhuma política → só o servidor (service role) acessa

-- escrita
create policy w on fl_config for all using (fl_master()) with check (fl_master());
create policy w on fl_empresas for all using (fl_master()) with check (fl_master());
create policy w on fl_unidades for all using (fl_master()) with check (fl_master());
create policy w on fl_locais for all using (fl_master()) with check (fl_master());
create policy w on fl_ml_contas for all using (fl_master()) with check (fl_master());
create policy w on fl_produtos for all using (fl_tem('compras','estoque')) with check (fl_tem('compras','estoque'));
create policy w on fl_kit_itens for all using (fl_tem('compras','estoque')) with check (fl_tem('compras','estoque'));
create policy w on fl_codigos for all using (fl_tem('compras','estoque','operacao')) with check (fl_tem('compras','estoque','operacao'));
create policy w on fl_notas for all using (fl_tem('compras','financeiro')) with check (fl_tem('compras','financeiro'));
create policy w on fl_nota_itens for all using (fl_tem('compras','financeiro')) with check (fl_tem('compras','financeiro'));
create policy w on fl_anexos for insert with check (fl_logado());
create policy d on fl_anexos for delete using (fl_master() or criado_por=auth.uid());
create policy w on fl_mov for insert with check (fl_tem('estoque','compras') and origem in ('manual','importacao','pdv','venda'));
create policy d on fl_mov for delete using (fl_master());
create policy w on fl_mov_custo for all using (fl_ve_custo()) with check (fl_ve_custo());
create policy w on fl_saldos_externos for all using (fl_tem('estoque','compras')) with check (fl_tem('estoque','compras'));
create policy w on fl_vendas for update using (fl_tem('financeiro','operacao')) with check (fl_tem('financeiro','operacao'));
create policy d on fl_vendas for delete using (fl_master());
create policy w on fl_venda_itens for update using (fl_tem('financeiro','operacao')) with check (fl_tem('financeiro','operacao'));
create policy w on fl_venda_itens_custo for update using (fl_ve_custo()) with check (fl_ve_custo());
create policy w on fl_contas_fin for all using (fl_ve_fin()) with check (fl_ve_fin());
create policy w on fl_lancamentos for all using (fl_ve_fin()) with check (fl_ve_fin());
create policy w on fl_pendencias for all using (fl_logado()) with check (fl_logado());
create policy w on fl_pendencia_hist for insert with check (fl_logado());
create policy w on fl_sync_log for all using (fl_logado()) with check (fl_logado());

-- funções: só usuários autenticados
-- funções internas: não podem ser chamadas pelo site (só por outras funções/gatilhos)
revoke all on function fl_recalcular_custo(uuid) from public, anon, authenticated;
revoke all on function fl_congelar_custo(bigint) from public, anon, authenticated;
revoke all on function fl_custo_em(uuid,timestamptz) from public, anon, authenticated;
revoke all on function fl_audit() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 16. Storage para XML, PDF e comprovantes (privado)
-- ---------------------------------------------------------------------
insert into storage.buckets(id,name,public) values ('fl-docs','fl-docs',false) on conflict (id) do nothing;
drop policy if exists fl_docs_sel on storage.objects;
drop policy if exists fl_docs_ins on storage.objects;
drop policy if exists fl_docs_del on storage.objects;
create policy fl_docs_sel on storage.objects for select using (bucket_id='fl-docs' and fl_logado());
create policy fl_docs_ins on storage.objects for insert with check (bucket_id='fl-docs' and fl_logado());
create policy fl_docs_del on storage.objects for delete using (bucket_id='fl-docs' and fl_master());

-- custo médio atual por produto (respeita RLS de fl_custo_hist)
create or replace view fl_v_custo_atual with (security_invoker=true) as
  select distinct on (produto_id) produto_id, custo_medio_depois as custo_medio, data as data_custo, custo_entrada as ultimo_custo_entrada, nota_id as ultima_nota_id
  from fl_custo_hist order by produto_id, data desc, id desc;

-- lotes e validades recebidos (sem valores) para todos os perfis
create or replace function fl_validades() returns table(produto_id uuid, lote text, validade date, qtd numeric, nota text, recebido date)
language sql stable security definer set search_path=public as $$
  select ri.produto_id, i.lote, i.validade, sum(ri.qtd_recebida), max(n.numero), max(r.data)
  from fl_receb_itens ri join fl_recebimentos r on r.id=ri.recebimento_id join fl_nota_itens i on i.id=ri.nota_item_id join fl_notas n on n.id=i.nota_id
  where fl_logado() and i.validade is not null group by 1,2,3
$$;

-- status de pagamento da nota acompanha as contas a pagar vinculadas
create or replace function fl_lanc_nota_trg() returns trigger language plpgsql security definer set search_path=public as $$
declare nid bigint:=coalesce(new.nota_id,old.nota_id); tot numeric; pago numeric; abertos int;
begin
  if nid is null then return null; end if;
  select sum(valor), sum(case when status='pago' then coalesce(valor_pago,valor) when status='parcial' then coalesce(valor_pago,0) else 0 end),
         count(*) filter (where status in ('aberto','parcial'))
    into tot,pago,abertos from fl_lancamentos where nota_id=nid and tipo='pagar' and status<>'cancelado';
  update fl_notas set status_pgto=case when tot is null then 'pendente' when abertos=0 then 'pago' when pago>0 then 'parcial' else 'pendente' end
   where id=nid and tipo='entrada';
  return null;
end $$;
drop trigger if exists fl_lanc_nota on fl_lancamentos;
create trigger fl_lanc_nota after insert or update or delete on fl_lancamentos for each row execute function fl_lanc_nota_trg();

-- =====================================================================
-- 17. FL GESTÃO — canais, modalidades, vinhos, baixa automática, expedição e caixa da loja
-- =====================================================================
-- Campos de vinho no cadastro (opcionais; servem também para outros produtos)
alter table fl_produtos add column if not exists tipo_vinho text;      -- tinto, branco, rosé, espumante, fortificado…
alter table fl_produtos add column if not exists uva text;
alter table fl_produtos add column if not exists safra int;
alter table fl_produtos add column if not exists pais text;
alter table fl_produtos add column if not exists regiao text;
alter table fl_produtos add column if not exists volume_ml int;
alter table fl_produtos add column if not exists teor_alcoolico numeric;
alter table fl_produtos add column if not exists preco_venda numeric;  -- preço de balcão (loja Cuiabá)

-- Modalidade de envio, local de baixa e expedição
alter table fl_vendas add column if not exists modalidade text check (modalidade in ('full','flex','agencia','turbo','coleta','fba','dba','shopee_xpress','retirada','balcao','outra'));
alter table fl_vendas add column if not exists local_id int references fl_locais(id);
alter table fl_vendas add column if not exists expedicao_status text not null default 'nao_aplica'
  check (expedicao_status in ('a_separar','separado','despachado','entregue','nao_aplica'));
alter table fl_vendas add column if not exists despachado_em timestamptz;
alter table fl_vendas add column if not exists despachado_por text;
alter table fl_vendas add column if not exists forma_pagamento text;
create index if not exists fl_vendas_exped on fl_vendas(expedicao_status) where expedicao_status in ('a_separar','separado');

-- Contas da Amazon e da Shopee (cadastro; conexão por API na Fase 2)
create table if not exists fl_canal_contas(
  id serial primary key, empresa_id int not null references fl_empresas(id),
  canal text not null check (canal in ('amazon','shopee')), apelido text not null,
  status text not null default 'nao_conectada', ultima_sync timestamptz, unique(canal,apelido));
insert into fl_canal_contas(empresa_id,canal,apelido) select e.id,c.canal,e.nome from fl_empresas e cross join (values ('amazon'),('shopee')) c(canal)
  on conflict (canal,apelido) do nothing;
alter table fl_vendas add column if not exists canal_conta_id int references fl_canal_contas(id);
alter table fl_canal_contas enable row level security;

-- Antes de gravar a venda: modalidade a partir da logística do ML e status de expedição
create or replace function fl_venda_prep() returns trigger language plpgsql as $$
begin
  if new.modalidade is null then
    new.modalidade:=case
      when new.canal='loja' then 'balcao'
      when new.logistica='fulfillment' then case when new.canal='amazon' then 'fba' else 'full' end
      when new.logistica='self_service' then 'flex'
      when new.logistica in ('xd_drop_off','drop_off') then 'agencia'
      when new.logistica='cross_docking' then 'coleta'
      else null end;
  end if;
  if tg_op='INSERT' then
    new.expedicao_status:=case when new.modalidade in ('full','fba','balcao','retirada') or new.status<>'concluida' then 'nao_aplica'
                               else 'a_separar' end;
  elsif new.status in ('cancelada','devolvida') and old.expedicao_status in ('a_separar','separado') then
    new.expedicao_status:='nao_aplica';
  end if;
  return new;
end $$;
drop trigger if exists fl_venda_prep on fl_vendas;
create trigger fl_venda_prep before insert or update of status,modalidade,logistica on fl_vendas for each row execute function fl_venda_prep();

-- Local de onde sai a mercadoria
create or replace function fl_local_da_venda(p_venda bigint) returns int language plpgsql stable security definer set search_path=public as $$
declare v fl_vendas; l int; baixa text;
begin
  select * into v from fl_vendas where id=p_venda;
  if v.local_id is not null then return v.local_id; end if;
  if v.modalidade in ('full','fba') then
    select id into l from fl_locais where tipo='full' and ativo and (ml_conta_id=v.ml_conta_id or (v.ml_conta_id is null and empresa_id=v.empresa_id)) order by id limit 1;
    return l;  -- sem local Full cadastrado: não baixa (o estoque está no marketplace)
  end if;
  if v.ml_conta_id is not null then
    select baixa_estoque_nao_full into baixa from fl_ml_contas where id=v.ml_conta_id;
    if baixa='pdv' then return null; end if;
  end if;
  if v.canal='loja' then
    select id into l from fl_locais where tipo='loja' and ativo and empresa_id=v.empresa_id order by id limit 1;
  else
    select id into l from fl_locais where tipo='deposito' and ativo and empresa_id=v.empresa_id order by id limit 1;
  end if;
  return l;
end $$;

-- Baixa (ou estorno) de estoque de um item vendido — idempotente
create or replace function fl_baixar_item(p_item bigint) returns void language plpgsql security definer set search_path=public as $$
declare i record; loc int; ref text:='vi:'||p_item;
begin
  select vi.*, v.status, v.duplicada_de, v.data_venda, v.pedido, v.canal into i from fl_venda_itens vi join fl_vendas v on v.id=vi.venda_id where vi.id=p_item;
  if i.id is null then return; end if;
  loc:=fl_local_da_venda(i.venda_id);
  if i.produto_id is null or i.eh_servico or loc is null or i.duplicada_de is not null or i.status in ('cancelada','devolvida','pendente') then
    delete from fl_mov where origem='venda' and origem_ref=ref;
    return;
  end if;
  insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,venda_id,responsavel)
  values (i.produto_id,loc,i.data_venda,'venda',-abs(i.qtd),'venda',ref,coalesce('Pedido '||i.pedido,'Venda '||i.venda_id),i.venda_id,'Sistema')
  on conflict (origem,origem_ref) do update set produto_id=excluded.produto_id,local_id=excluded.local_id,qtd=excluded.qtd,data=excluded.data
  where fl_mov.produto_id is distinct from excluded.produto_id or fl_mov.local_id is distinct from excluded.local_id or fl_mov.qtd is distinct from excluded.qtd;
end $$;
create or replace function fl_item_baixa_trg() returns trigger language plpgsql security definer set search_path=public as $$
begin perform fl_baixar_item(new.id); return null; end $$;
drop trigger if exists fl_item_baixa on fl_venda_itens;
create trigger fl_item_baixa after insert or update of produto_id,qtd,eh_servico on fl_venda_itens for each row execute function fl_item_baixa_trg();
create or replace function fl_venda_baixa_trg() returns trigger language plpgsql security definer set search_path=public as $$
declare r record; begin
  for r in select id from fl_venda_itens where venda_id=new.id loop perform fl_baixar_item(r.id); end loop; return null; end $$;
drop trigger if exists fl_venda_baixa on fl_vendas;
create trigger fl_venda_baixa after update of status,local_id,modalidade,duplicada_de on fl_vendas for each row execute function fl_venda_baixa_trg();
revoke all on function fl_baixar_item(bigint) from public, anon, authenticated;

-- Gravação de vendas: aceita modalidade, local e conta Amazon/Shopee
create or replace function fl_gravar_venda_ext(p_venda jsonb, p_itens jsonb) returns text language plpgsql security definer set search_path=public as $$
declare res text; vid bigint;
begin
  res:=fl_gravar_venda(p_venda,p_itens);
  select id into vid from fl_vendas where origem=p_venda->>'origem' and origem_ref=p_venda->>'origem_ref';
  update fl_vendas set modalidade=coalesce(p_venda->>'modalidade',modalidade),
    local_id=coalesce((p_venda->>'local_id')::int,local_id),
    canal_conta_id=coalesce((p_venda->>'canal_conta_id')::int,canal_conta_id),
    forma_pagamento=coalesce(p_venda->>'forma_pagamento',forma_pagamento)
  where id=vid and (p_venda ? 'modalidade' or p_venda ? 'local_id' or p_venda ? 'canal_conta_id' or p_venda ? 'forma_pagamento');
  return res;
end $$;

-- Expedição: marcar separado / despachado / entregue
create or replace function fl_expedicao(p_vendas bigint[], p_status text) returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin
  if not fl_tem('operacao','estoque') then raise exception 'Sem permissão'; end if;
  if p_status not in ('a_separar','separado','despachado','entregue') then raise exception 'Status inválido'; end if;
  update fl_vendas set expedicao_status=p_status,
    despachado_em=case when p_status in ('despachado','entregue') then coalesce(despachado_em,now()) else null end,
    despachado_por=case when p_status in ('despachado','entregue') then coalesce(despachado_por,(select coalesce(nome,email) from fl_perfis where user_id=auth.uid())) else null end
  where id=any(p_vendas) and expedicao_status<>'nao_aplica';
  get diagnostics n=row_count; return n;
end $$;
-- Lista de expedição sem valores (para o perfil Estoque)
create or replace function fl_fila_expedicao() returns table(venda_id bigint, data_venda timestamptz, canal text, conta text, empresa text, modalidade text,
  expedicao_status text, pedido text, cliente text, itens jsonb, despachado_em timestamptz)
language sql stable security definer set search_path=public as $$
  select v.id,v.data_venda,v.canal,coalesce(m.apelido,c.apelido),e.nome,v.modalidade,v.expedicao_status,v.pedido,v.cliente,
    (select jsonb_agg(jsonb_build_object('descricao',coalesce(p.nome,vi.descricao),'qtd',vi.qtd,'sku',vi.sku) order by vi.n)
       from fl_venda_itens vi left join fl_produtos p on p.id=vi.produto_id where vi.venda_id=v.id and not vi.eh_servico),
    v.despachado_em
  from fl_vendas v left join fl_ml_contas m on m.id=v.ml_conta_id left join fl_canal_contas c on c.id=v.canal_conta_id
  left join fl_empresas e on e.id=v.empresa_id
  where fl_tem('operacao','estoque') and v.duplicada_de is null
    and (v.expedicao_status in ('a_separar','separado') or (v.expedicao_status in ('despachado','entregue') and v.despachado_em>now()-interval '3 days'))
  order by v.data_venda
$$;

-- Caixa da loja (venda de balcão): grava a venda, baixa o estoque e lança o recebimento
-- p: {"empresa_id":2,"local_id":3,"cliente":"","forma_pagamento":"pix","desconto":0,"itens":[{"produto_id":"…","qtd":1,"preco_unit":89.9}]}
create or replace function fl_venda_balcao(p jsonb) returns bigint language plpgsql security definer set search_path=public as $$
declare vid bigint; x jsonb; k int:=0; bruto numeric:=0; desc_ numeric:=coalesce((p->>'desconto')::numeric,0); emp int; uni int; loc int; fp text:=coalesce(p->>'forma_pagamento','dinheiro');
begin
  if not fl_tem('operacao','financeiro') then raise exception 'Sem permissão para vender no caixa'; end if;
  if jsonb_array_length(coalesce(p->'itens','[]'))=0 then raise exception 'Inclua ao menos um produto'; end if;
  loc:=(p->>'local_id')::int;
  select empresa_id,unidade_id into emp,uni from fl_locais where id=loc and tipo='loja';
  if emp is null then raise exception 'Escolha o local da loja'; end if;
  select sum((i->>'qtd')::numeric*(i->>'preco_unit')::numeric) into bruto from jsonb_array_elements(p->'itens') i;
  insert into fl_vendas(canal,empresa_id,unidade_id,origem,origem_ref,pedido,data_venda,status,cliente,valor_bruto,desconto,
     valor_liquido_previsto,modalidade,local_id,forma_pagamento,data_pagamento,liberado)
  values ('loja',emp,uni,'caixa','cx:'||gen_random_uuid(),null,now(),'concluida',nullif(p->>'cliente',''),bruto,desc_,
     bruto-desc_,'balcao',loc,fp,current_date,fp<>'credito')
  returning id into vid;
  update fl_vendas set pedido='Balcão '||vid where id=vid;
  for x in select * from jsonb_array_elements(p->'itens') loop
    k:=k+1;
    insert into fl_venda_itens(venda_id,n,produto_id,descricao,qtd,preco_unit)
    values (vid,k,(x->>'produto_id')::uuid,(select nome from fl_produtos where id=(x->>'produto_id')::uuid),(x->>'qtd')::numeric,(x->>'preco_unit')::numeric);
  end loop;
  insert into fl_lancamentos(tipo,natureza,empresa_id,categoria,descricao,valor,competencia,vencimento,status,valor_pago,data_pagamento,venda_id,origem,origem_ref)
  values ('receber','venda',emp,'Venda balcão','Venda balcão '||vid||' ('||fp||')',bruto-desc_,current_date,current_date,
     case when fp='credito' then 'aberto' else 'pago' end, case when fp='credito' then null else bruto-desc_ end,
     case when fp='credito' then null else current_date end, vid,'caixa','cx:'||vid);
  return vid;
end $$;

-- Saldo por produto e local (para caixa e consulta rápida, sem valores)
create or replace function fl_saldo_local(p_local int) returns table(produto_id uuid, saldo numeric) language sql stable security definer set search_path=public as $$
  select produto_id, sum(qtd) from fl_mov where local_id=p_local and fl_logado() group by 1
$$;

-- Permissões das novas estruturas
drop policy if exists r on fl_canal_contas; drop policy if exists w on fl_canal_contas;
create policy r on fl_canal_contas for select using (fl_logado());
create policy w on fl_canal_contas for all using (fl_master()) with check (fl_master());
drop trigger if exists fl_canal_contas_audit on fl_canal_contas;
create trigger fl_canal_contas_audit after insert or update or delete on fl_canal_contas for each row execute function fl_audit();
