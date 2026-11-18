-- =====================================================================
-- FL GESTÃO — Parte 2: operações (Roca Imports / FL Adega), permissões,
-- recebimento, remessas (São Paulo / Full), PDV da Adega e conciliação.
-- Rodar DEPOIS de schema.sql. Idempotente: pode ser executado de novo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Perfis, operações e permissões
-- ---------------------------------------------------------------------
alter table fl_perfis drop constraint if exists fl_perfis_papel_check;
alter table fl_perfis add constraint fl_perfis_papel_check
  check (papel in ('master','financeiro','roca','pdv','compras','estoque','operacao'));
alter table fl_perfis add column if not exists operacoes text[] not null default '{}';
alter table fl_perfis add column if not exists pode_editar_custo boolean not null default false;
alter table fl_perfis add column if not exists pode_desconto boolean not null default false;
alter table fl_perfis add column if not exists pode_cancelar boolean not null default false;

alter table fl_empresas add column if not exists operacao text check (operacao in ('roca','adega'));
update fl_empresas set operacao='roca' where nome='Roca Imports' and operacao is null;
update fl_empresas set operacao='adega' where nome='FL Adega' and operacao is null;

-- Convites: o administrador pré-cadastra o e-mail com o perfil; no 1º acesso o perfil é aplicado.
create table if not exists fl_convites(
  email text primary key, nome text, papel text not null check (papel in ('master','financeiro','roca','pdv')),
  operacoes text[] not null default '{}', pode_editar_custo boolean not null default false,
  pode_desconto boolean not null default false, pode_cancelar boolean not null default false,
  criado_por uuid default auth.uid(), criado_em timestamptz default now(), usado_em timestamptz);
alter table fl_convites enable row level security;

create or replace function fl_perfil_atual() returns fl_perfis language sql stable security definer set search_path=public as $$
  select * from fl_perfis where user_id=auth.uid() and ativo
$$;
-- Operação Roca: administrador ou perfil operacional da Roca (e perfis antigos de estoque/compras)
create or replace function fl_pode_roca() returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select papel in ('master','roca','estoque','compras') from fl_perfis where user_id=auth.uid() and ativo),false)
$$;
-- PDV da Adega: administrador ou operador de PDV
create or replace function fl_pode_pdv() returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select papel in ('master','pdv','operacao') from fl_perfis where user_id=auth.uid() and ativo),false)
$$;
-- Financeiro de uma operação ('roca'/'adega'); null = qualquer operação autorizada
create or replace function fl_pode_fin(p_op text default null) returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select papel='master' or (papel='financeiro' and (case when p_op is null then cardinality(operacoes)>0 else p_op=any(operacoes) end))
                   from fl_perfis where user_id=auth.uid() and ativo),false)
$$;
create or replace function fl_op_empresa(p_emp int) returns text language sql stable security definer set search_path=public as $$
  select operacao from fl_empresas where id=p_emp
$$;
create or replace function fl_pode_fin_empresa(p_emp int) returns boolean language sql stable as $$
  select fl_pode_fin(coalesce(fl_op_empresa(p_emp),'__'))
$$;
create or replace function fl_pode_custo() returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select papel in ('master','financeiro','compras') or pode_editar_custo from fl_perfis where user_id=auth.uid() and ativo),false)
$$;
-- quem vê custos: master, financeiro, compras e quem tem permissão de custo
create or replace function fl_ve_custo() returns boolean language sql stable as $$ select fl_pode_custo() $$;
-- Bloqueio explícito para páginas financeiras (o site chama antes de carregar; o banco também filtra)
create or replace function fl_exige_fin() returns boolean language plpgsql stable security definer set search_path=public as $$
begin if not fl_pode_fin(null) then raise exception 'Sem permissão: área restrita ao financeiro'; end if; return true; end $$;

-- Entrada: cria perfil; aplica convite; dono vira master
create or replace function fl_entrar() returns fl_perfis language plpgsql security definer set search_path=public as $$
declare r fl_perfis; v_email text; c fl_convites;
begin
  select email into v_email from auth.users where id=auth.uid();
  if v_email is null then raise exception 'Não autenticado'; end if;
  insert into fl_perfis(user_id,email,nome,papel)
  values (auth.uid(),v_email,coalesce((select raw_user_meta_data->>'nome' from auth.users where id=auth.uid()),split_part(v_email,'@',1)),
          case when lower(v_email) in ('iagobrito@tudomixatacado.com','iagobrito@hotmail.com') then 'master' end)
  on conflict (user_id) do update set ultimo_acesso=now()
  returning * into r;
  select * into c from fl_convites where lower(email)=lower(v_email) and usado_em is null;
  if c.email is not null and r.papel is null then
    update fl_perfis set papel=c.papel,operacoes=c.operacoes,pode_editar_custo=c.pode_editar_custo,pode_desconto=c.pode_desconto,
       pode_cancelar=c.pode_cancelar,ativo=true,nome=coalesce(c.nome,nome) where user_id=auth.uid() returning * into r;
    update fl_convites set usado_em=now() where email=c.email;
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- B. Produtos (SKU e custo de aquisição) e locais da Roca
-- ---------------------------------------------------------------------
alter table fl_produtos add column if not exists sku text;
alter table fl_produtos add column if not exists custo_aquisicao numeric check (custo_aquisicao is null or custo_aquisicao>=0);
create unique index if not exists fl_produtos_sku_u on fl_produtos(upper(sku)) where sku is not null and sku<>'';

-- Custo só pode ser alterado por quem tem permissão (vale no banco, não só na tela)
create or replace function fl_produto_custo_trg() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then return new; end if;
  if (tg_op='INSERT' and new.custo_aquisicao is not null) or (tg_op='UPDATE' and new.custo_aquisicao is distinct from old.custo_aquisicao) then
    if not fl_pode_custo() then raise exception 'Sem permissão para editar custo'; end if;
  end if;
  if (tg_op='INSERT' and new.preco_venda is not null) or (tg_op='UPDATE' and new.preco_venda is distinct from old.preco_venda) then
    if not (fl_master() or fl_pode_custo()) then raise exception 'Sem permissão para alterar preço'; end if;
  end if;
  if new.sku is not null then new.sku:=upper(trim(new.sku)); if new.sku='' then new.sku:=null; end if; end if;
  return new;
end $$;
drop trigger if exists fl_produto_custo on fl_produtos;
create trigger fl_produto_custo before insert or update on fl_produtos for each row execute function fl_produto_custo_trg();

insert into fl_locais(unidade_id,empresa_id,nome,tipo) select u.id,u.empresa_id,'São Paulo (Roca)','deposito' from fl_unidades u
  where u.nome='Roca Imports — Online' and not exists (select 1 from fl_locais l where l.nome='São Paulo (Roca)');
update fl_locais set nome='Cuiabá (Roca)' where nome='Depósito Roca';

-- Local Full de uma conta do ML (criado na primeira remessa)
create or replace function fl_local_full(p_conta int) returns int language plpgsql security definer set search_path=public as $$
declare l int; c fl_ml_contas;
begin
  select id into l from fl_locais where tipo='full' and ml_conta_id=p_conta and ativo order by id limit 1;
  if l is not null then return l; end if;
  select * into c from fl_ml_contas where id=p_conta;
  if c.id is null then raise exception 'Conta do Mercado Livre não encontrada'; end if;
  insert into fl_locais(unidade_id,empresa_id,nome,tipo,ml_conta_id)
  values ((select id from fl_unidades where empresa_id=c.empresa_id order by id limit 1),c.empresa_id,'Full ML · '||c.apelido,'full',p_conta)
  returning id into l;
  return l;
end $$;

-- Movimentação: conta atendida e novas origens
alter table fl_mov add column if not exists ml_conta_id int references fl_ml_contas(id);
alter table fl_mov drop constraint if exists fl_mov_origem_check;
alter table fl_mov add constraint fl_mov_origem_check
  check (origem in ('pdv','ml','amazon','shopee','venda','nf','manual','importacao','compra','remessa'));
alter table fl_mov drop constraint if exists fl_mov_tipo_check;
alter table fl_mov add constraint fl_mov_tipo_check
  check (tipo in ('saldo_inicial','compra','bonificacao','venda','devolucao_venda','devolucao_compra','transferencia_saida',
                  'transferencia_entrada','perda','ajuste','consumo_interno','estorno_venda'));

-- Trava por produto+local (serializa vendas e remessas concorrentes)
create or replace function fl_travar(p_local int, p_produto uuid) returns void language sql as $$
  select pg_advisory_xact_lock(hashtext('fl:'||p_local||':'||p_produto))
$$;
-- Saldo físico de um produto num local
create or replace function fl_saldo_fisico(p_local int, p_produto uuid) returns numeric language sql stable security definer set search_path=public as $$
  select coalesce(sum(qtd),0) from fl_mov where local_id=p_local and produto_id=p_produto
$$;

-- ---------------------------------------------------------------------
-- C. Compras e recebimentos parciais (Roca)
-- ---------------------------------------------------------------------
create table if not exists fl_compras(
  id bigserial primary key, empresa_id int not null references fl_empresas(id), fornecedor text not null, documento text,
  data date not null default current_date, local_id int not null references fl_locais(id),
  status text not null default 'aberta' check (status in ('aberta','parcial','recebida','cancelada')),
  obs text, chave text unique, criado_por uuid default auth.uid(), criado_em timestamptz default now());
alter table fl_compras add column if not exists chave text unique;
create table if not exists fl_compra_itens(
  id bigserial primary key, compra_id bigint not null references fl_compras(id) on delete cascade,
  produto_id uuid not null references fl_produtos(id), qtd numeric not null check (qtd>0), custo_unit numeric check (custo_unit is null or custo_unit>=0),
  unique(compra_id,produto_id));
create table if not exists fl_compra_receb(
  id bigserial primary key, compra_id bigint not null references fl_compras(id), data date not null default current_date,
  local_id int not null references fl_locais(id), documento text, responsavel uuid default auth.uid(), responsavel_nome text,
  chave text unique, obs text, criado_em timestamptz default now());
create table if not exists fl_compra_receb_itens(
  id bigserial primary key, receb_id bigint not null references fl_compra_receb(id) on delete cascade,
  item_id bigint not null references fl_compra_itens(id), qtd numeric not null check (qtd>0));

create or replace function fl_nome_usuario() returns text language sql stable security definer set search_path=public as $$
  select coalesce(nome,email) from fl_perfis where user_id=auth.uid()
$$;

-- Recebe (total ou parcial) uma compra. p_itens: [{"item_id":1,"qtd":12}]. p_chave evita duplicar em clique repetido.
create or replace function fl_compra_receber(p_compra bigint, p_itens jsonb, p_data date default null, p_documento text default null,
  p_chave text default null, p_local int default null) returns bigint language plpgsql security definer set search_path=public as $$
declare c fl_compras; rid bigint; x jsonb; it fl_compra_itens; ja numeric; q numeric; mid bigint; cu numeric; tot numeric; rec numeric; loc int;
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  if p_chave is not null then select id into rid from fl_compra_receb where chave=p_chave; if rid is not null then return rid; end if; end if;
  select * into c from fl_compras where id=p_compra for update;
  if c.id is null then raise exception 'Compra não encontrada'; end if;
  if c.status in ('recebida','cancelada') then raise exception 'Compra já %', c.status; end if;
  loc:=coalesce(p_local,c.local_id);
  insert into fl_compra_receb(compra_id,data,local_id,documento,chave,responsavel_nome)
  values (p_compra,coalesce(p_data,current_date),loc,coalesce(p_documento,c.documento),p_chave,fl_nome_usuario()) returning id into rid;
  for x in select * from jsonb_array_elements(p_itens) loop
    q:=coalesce((x->>'qtd')::numeric,0); if q<=0 then continue; end if;
    select * into it from fl_compra_itens where id=(x->>'item_id')::bigint and compra_id=p_compra;
    if it.id is null then raise exception 'Item não pertence à compra'; end if;
    select coalesce(sum(ri.qtd),0) into ja from fl_compra_receb_itens ri where ri.item_id=it.id;
    if ja+q>it.qtd then raise exception 'Quantidade recebida (%) maior que a pendente (%) para o item', q, it.qtd-ja; end if;
    insert into fl_compra_receb_itens(receb_id,item_id,qtd) values (rid,it.id,q);
    insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,responsavel)
    values (it.produto_id,loc,(coalesce(p_data,current_date)::timestamp+interval '12 hours'),'compra',q,'compra','cr:'||rid||':'||it.id,
            'Compra '||c.id||coalesce(' · doc '||coalesce(p_documento,c.documento),''),fl_nome_usuario()) returning id into mid;
    cu:=coalesce(it.custo_unit,(select custo_aquisicao from fl_produtos where id=it.produto_id));
    if cu is not null then insert into fl_mov_custo(mov_id,custo_unit,confiavel,fonte) values (mid,cu,true,'Compra '||c.id); end if;
  end loop;
  if not exists(select 1 from fl_compra_receb_itens where receb_id=rid) then raise exception 'Informe ao menos uma quantidade recebida'; end if;
  select sum(qtd) into tot from fl_compra_itens where compra_id=p_compra;
  select coalesce(sum(ri.qtd),0) into rec from fl_compra_receb_itens ri join fl_compra_itens i on i.id=ri.item_id where i.compra_id=p_compra;
  update fl_compras set status=case when rec>=tot then 'recebida' else 'parcial' end where id=p_compra;
  return rid;
end $$;

-- Cria a compra (com quantidades esperadas) e, opcionalmente, já recebe o que chegou.
-- p: {"empresa_id":1,"fornecedor":"X","documento":"NF 1","data":"2026-11-18","local_id":1,"chave":"uuid",
--     "itens":[{"produto_id":"…","qtd":20,"custo_unit":10,"recebido":12}]}
create or replace function fl_compra_criar(p jsonb) returns bigint language plpgsql security definer set search_path=public as $$
declare cid bigint; x jsonb; iid bigint; rec jsonb:='[]'; emp int;
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  if coalesce(trim(p->>'fornecedor'),'')='' then raise exception 'Informe o fornecedor'; end if;
  if jsonb_array_length(coalesce(p->'itens','[]'))=0 then raise exception 'Inclua ao menos um produto'; end if;
  if p->>'chave' is not null then select id into cid from fl_compras where chave=p->>'chave'; if cid is not null then return cid; end if; end if;
  select empresa_id into emp from fl_locais where id=(p->>'local_id')::int;
  insert into fl_compras(empresa_id,fornecedor,documento,data,local_id,obs,chave)
  values (coalesce((p->>'empresa_id')::int,emp),trim(p->>'fornecedor'),nullif(p->>'documento',''),coalesce((p->>'data')::date,current_date),
          (p->>'local_id')::int,nullif(p->>'obs',''),p->>'chave') returning id into cid;
  for x in select * from jsonb_array_elements(p->'itens') loop
    insert into fl_compra_itens(compra_id,produto_id,qtd,custo_unit)
    values (cid,(x->>'produto_id')::uuid,(x->>'qtd')::numeric,case when fl_pode_custo() then (x->>'custo_unit')::numeric end)
    returning id into iid;
    if coalesce((x->>'recebido')::numeric,0)>0 then rec:=rec||jsonb_build_object('item_id',iid,'qtd',(x->>'recebido')::numeric); end if;
  end loop;
  if jsonb_array_length(rec)>0 then
    perform fl_compra_receber(cid,rec,coalesce((p->>'data')::date,current_date),nullif(p->>'documento',''),case when p->>'chave' is not null then (p->>'chave')||':1' end);
  end if;
  return cid;
end $$;

-- ---------------------------------------------------------------------
-- D. Remessas (São Paulo e Full)
-- ---------------------------------------------------------------------
create sequence if not exists fl_remessa_seq;
create table if not exists fl_remessas(
  id bigserial primary key, numero text unique not null default ('RM-'||lpad(nextval('fl_remessa_seq')::text,5,'0')),
  tipo text not null check (tipo in ('sp','full')),
  origem_id int not null references fl_locais(id), destino_id int not null references fl_locais(id),
  ml_conta_id int references fl_ml_contas(id), envio_id text, centro_destino text,
  status text not null default 'aberta' check (status in ('aberta','separada','em_transito','recebida','divergente','cancelada')),
  data date not null default current_date, responsavel uuid default auth.uid(), responsavel_nome text,
  separada_em timestamptz, saida_em timestamptz, recebida_em timestamptz, obs text, chave text unique, criado_em timestamptz default now(),
  check (origem_id<>destino_id), check (tipo<>'full' or ml_conta_id is not null));
create table if not exists fl_remessa_itens(
  id bigserial primary key, remessa_id bigint not null references fl_remessas(id) on delete cascade,
  produto_id uuid not null references fl_produtos(id), qtd numeric not null check (qtd>0),
  qtd_recebida numeric, qtd_conferida_depois numeric not null default 0, qtd_perda numeric not null default 0,
  unique(remessa_id,produto_id));
create table if not exists fl_remessa_hist(
  id bigserial primary key, remessa_id bigint not null references fl_remessas(id) on delete cascade,
  evento text not null, detalhe text, usuario text, em timestamptz default now());

-- Reservado = itens de remessas separadas (ainda no local de origem)
create or replace function fl_reservado(p_local int, p_produto uuid, p_exceto bigint default null) returns numeric language sql stable security definer set search_path=public as $$
  select coalesce(sum(i.qtd),0) from fl_remessa_itens i join fl_remessas r on r.id=i.remessa_id
  where r.origem_id=p_local and i.produto_id=p_produto and r.status='separada' and r.id is distinct from p_exceto
$$;
create or replace function fl_disponivel(p_local int, p_produto uuid, p_exceto bigint default null) returns numeric language sql stable security definer set search_path=public as $$
  select fl_saldo_fisico(p_local,p_produto)-fl_reservado(p_local,p_produto,p_exceto)
$$;
create or replace function fl_remessa_log(p_rem bigint, p_ev text, p_det text) returns void language sql security definer set search_path=public as $$
  insert into fl_remessa_hist(remessa_id,evento,detalhe,usuario) values (p_rem,p_ev,p_det,fl_nome_usuario())
$$;
-- verifica saldo disponível de todos os itens (com trava)
create or replace function fl_remessa_checar(p_rem bigint) returns void language plpgsql security definer set search_path=public as $$
declare r fl_remessas; i record; d numeric;
begin
  select * into r from fl_remessas where id=p_rem;
  for i in select ri.*, p.nome, p.sku from fl_remessa_itens ri join fl_produtos p on p.id=ri.produto_id where ri.remessa_id=p_rem order by ri.produto_id loop
    perform fl_travar(r.origem_id,i.produto_id);
    d:=fl_disponivel(r.origem_id,i.produto_id,p_rem);
    if i.qtd>d then raise exception 'Saldo insuficiente de % (%): disponível %, pedido %', i.nome, coalesce(i.sku,'sem SKU'), d, i.qtd; end if;
  end loop;
end $$;

-- p: {"tipo":"sp"|"full","origem_id":1,"destino_id":2 (sp),"ml_conta_id":1 (full),"envio_id":"","centro_destino":"","data":"…","chave":"uuid","itens":[{"produto_id":"…","qtd":10}]}
create or replace function fl_remessa_criar(p jsonb) returns bigint language plpgsql security definer set search_path=public as $$
declare rid bigint; dest int; x jsonb; tp text:=p->>'tipo';
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  if p->>'chave' is not null then select id into rid from fl_remessas where chave=p->>'chave'; if rid is not null then return rid; end if; end if;
  if tp='full' then
    if (p->>'ml_conta_id') is null then raise exception 'Informe a conta do Mercado Livre'; end if;
    dest:=fl_local_full((p->>'ml_conta_id')::int);
  else
    dest:=coalesce((p->>'destino_id')::int,(select id from fl_locais where nome='São Paulo (Roca)'));
  end if;
  if jsonb_array_length(coalesce(p->'itens','[]'))=0 then raise exception 'Inclua ao menos um produto'; end if;
  insert into fl_remessas(tipo,origem_id,destino_id,ml_conta_id,envio_id,centro_destino,data,responsavel_nome,obs,chave)
  values (tp,(p->>'origem_id')::int,dest,(p->>'ml_conta_id')::int,nullif(p->>'envio_id',''),nullif(p->>'centro_destino',''),
          coalesce((p->>'data')::date,current_date),fl_nome_usuario(),nullif(p->>'obs',''),p->>'chave') returning id into rid;
  for x in select * from jsonb_array_elements(p->'itens') loop
    insert into fl_remessa_itens(remessa_id,produto_id,qtd) values (rid,(x->>'produto_id')::uuid,(x->>'qtd')::numeric)
    on conflict (remessa_id,produto_id) do update set qtd=fl_remessa_itens.qtd+excluded.qtd;
  end loop;
  perform fl_remessa_checar(rid);
  perform fl_remessa_log(rid,'criada',(select count(*)||' SKU(s), '||sum(qtd)||' un.' from fl_remessa_itens where remessa_id=rid));
  return rid;
end $$;

-- Separação: reserva os itens na origem (clique repetido não faz nada)
create or replace function fl_remessa_separar(p_rem bigint) returns text language plpgsql security definer set search_path=public as $$
declare r fl_remessas;
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  select * into r from fl_remessas where id=p_rem for update;
  if r.id is null then raise exception 'Remessa não encontrada'; end if;
  if r.status<>'aberta' then return 'sem_alteracao'; end if;
  perform fl_remessa_checar(p_rem);
  update fl_remessas set status='separada',separada_em=now() where id=p_rem;
  perform fl_remessa_log(p_rem,'separada','Itens reservados na origem');
  return 'ok';
end $$;

-- Saída: tira da origem e coloca em trânsito (uma única movimentação, mesmo com cliques repetidos)
create or replace function fl_remessa_saida(p_rem bigint) returns text language plpgsql security definer set search_path=public as $$
declare r fl_remessas; i record;
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  select * into r from fl_remessas where id=p_rem for update;
  if r.id is null then raise exception 'Remessa não encontrada'; end if;
  if r.status in ('em_transito','recebida','divergente') then return 'sem_alteracao'; end if;
  if r.status='cancelada' then raise exception 'Remessa cancelada'; end if;
  perform fl_remessa_checar(p_rem);
  for i in select * from fl_remessa_itens where remessa_id=p_rem loop
    insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,responsavel,ml_conta_id)
    values (i.produto_id,r.origem_id,now(),'transferencia_saida',-i.qtd,'remessa','rm:'||p_rem||':'||i.id||':saida',r.numero,fl_nome_usuario(),r.ml_conta_id)
    on conflict (origem,origem_ref) do nothing;
  end loop;
  update fl_remessas set status='em_transito',saida_em=now(),separada_em=coalesce(separada_em,now()) where id=p_rem;
  perform fl_remessa_log(p_rem,'saida','Mercadoria em trânsito para '||(select nome from fl_locais where id=r.destino_id));
  return 'ok';
end $$;

-- Recebimento no destino: p_itens [{"item_id":1,"qtd":8}]. Falta fica pendente de conferência. Só uma vez.
create or replace function fl_remessa_receber(p_rem bigint, p_itens jsonb) returns text language plpgsql security definer set search_path=public as $$
declare r fl_remessas; i fl_remessa_itens; q numeric; pend numeric:=0;
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  select * into r from fl_remessas where id=p_rem for update;
  if r.id is null then raise exception 'Remessa não encontrada'; end if;
  if r.status in ('recebida','divergente') then return 'sem_alteracao'; end if;
  if r.status<>'em_transito' then raise exception 'Confirme a saída antes do recebimento'; end if;
  for i in select * from fl_remessa_itens where remessa_id=p_rem loop
    select (x->>'qtd')::numeric into q from jsonb_array_elements(p_itens) x where (x->>'item_id')::bigint=i.id;
    q:=coalesce(q,0);
    if q<0 or q>i.qtd then raise exception 'Quantidade recebida inválida para o item % (enviado %)', i.id, i.qtd; end if;
    update fl_remessa_itens set qtd_recebida=q where id=i.id;
    if q>0 then
      insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,responsavel,ml_conta_id)
      values (i.produto_id,r.destino_id,now(),'transferencia_entrada',q,'remessa','rm:'||p_rem||':'||i.id||':entrada',r.numero,fl_nome_usuario(),r.ml_conta_id)
      on conflict (origem,origem_ref) do nothing;
    end if;
    pend:=pend+(i.qtd-q);
  end loop;
  update fl_remessas set status=case when pend>0 then 'divergente' else 'recebida' end,recebida_em=now() where id=p_rem;
  perform fl_remessa_log(p_rem,'recebida',case when pend>0 then 'Recebido com divergência: '||pend||' un. pendentes de conferência' else 'Recebido completo' end);
  return case when pend>0 then 'divergente' else 'ok' end;
end $$;

-- Conferência da divergência: encontrou (entra no destino) ou perda (não volta ao estoque)
create or replace function fl_remessa_conferir(p_item bigint, p_encontrado numeric, p_perda numeric, p_obs text default null) returns text language plpgsql security definer set search_path=public as $$
declare i fl_remessa_itens; r fl_remessas; pend numeric; n int;
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  select * into i from fl_remessa_itens where id=p_item for update;
  select * into r from fl_remessas where id=i.remessa_id for update;
  if r.status<>'divergente' then raise exception 'Remessa sem divergência pendente'; end if;
  pend:=i.qtd-coalesce(i.qtd_recebida,0)-i.qtd_conferida_depois-i.qtd_perda;
  if coalesce(p_encontrado,0)<0 or coalesce(p_perda,0)<0 or coalesce(p_encontrado,0)+coalesce(p_perda,0)>pend then
    raise exception 'Quantidades maiores que o pendente (%)', pend; end if;
  if coalesce(p_encontrado,0)>0 then
    select count(*) into n from fl_mov where origem='remessa' and origem_ref like 'rm:'||r.id||':'||i.id||':conf:%';
    insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,responsavel,obs,ml_conta_id)
    values (i.produto_id,r.destino_id,now(),'transferencia_entrada',p_encontrado,'remessa','rm:'||r.id||':'||i.id||':conf:'||(n+1),r.numero,fl_nome_usuario(),p_obs,r.ml_conta_id);
  end if;
  update fl_remessa_itens set qtd_conferida_depois=qtd_conferida_depois+coalesce(p_encontrado,0),qtd_perda=qtd_perda+coalesce(p_perda,0) where id=p_item;
  perform fl_remessa_log(r.id,'conferencia','Item '||p_item||': encontrado '||coalesce(p_encontrado,0)||', perda '||coalesce(p_perda,0)||coalesce(' — '||p_obs,''));
  if not exists(select 1 from fl_remessa_itens where remessa_id=r.id and qtd-coalesce(qtd_recebida,0)-qtd_conferida_depois-qtd_perda>0) then
    update fl_remessas set status='recebida' where id=r.id;
  end if;
  return 'ok';
end $$;

create or replace function fl_remessa_cancelar(p_rem bigint, p_motivo text) returns text language plpgsql security definer set search_path=public as $$
declare r fl_remessas;
begin
  if not fl_pode_roca() then raise exception 'Sem permissão'; end if;
  select * into r from fl_remessas where id=p_rem for update;
  if r.status='cancelada' then return 'sem_alteracao'; end if;
  if r.status not in ('aberta','separada') then raise exception 'Remessa já saiu: não pode ser cancelada'; end if;
  update fl_remessas set status='cancelada' where id=p_rem;
  perform fl_remessa_log(p_rem,'cancelada',coalesce(p_motivo,''));
  return 'ok';
end $$;

-- Estoque da Roca por SKU, local e conta: físico, reservado, disponível, em trânsito, pendente de conferência
create or replace function fl_estoque_roca() returns table(produto_id uuid, sku text, descricao text, unidade text, local_id int, local text,
  tipo_local text, conta text, fisico numeric, reservado numeric, disponivel numeric, em_transito numeric, pendente_conferencia numeric)
language sql stable security definer set search_path=public as $$
  with loc as (select l.* from fl_locais l join fl_empresas e on e.id=l.empresa_id where e.operacao='roca' and l.ativo),
  fis as (select m.produto_id,m.local_id,sum(m.qtd) q from fl_mov m join loc on loc.id=m.local_id group by 1,2),
  res as (select i.produto_id,r.origem_id local_id,sum(i.qtd) q from fl_remessa_itens i join fl_remessas r on r.id=i.remessa_id where r.status='separada' group by 1,2),
  tra as (select i.produto_id,r.destino_id local_id,sum(i.qtd) q from fl_remessa_itens i join fl_remessas r on r.id=i.remessa_id where r.status='em_transito' group by 1,2),
  pen as (select i.produto_id,r.destino_id local_id,sum(i.qtd-coalesce(i.qtd_recebida,0)-i.qtd_conferida_depois-i.qtd_perda) q
          from fl_remessa_itens i join fl_remessas r on r.id=i.remessa_id where r.status='divergente' group by 1,2),
  chaves as (select produto_id,local_id from fis union select produto_id,local_id from res union select produto_id,local_id from tra union select produto_id,local_id from pen)
  select k.produto_id,p.sku,p.nome,p.unidade,k.local_id,loc.nome,loc.tipo,(select apelido from fl_ml_contas where id=loc.ml_conta_id),
    coalesce(fis.q,0),coalesce(res.q,0),coalesce(fis.q,0)-coalesce(res.q,0),coalesce(tra.q,0),coalesce(pen.q,0)
  from chaves k join loc on loc.id=k.local_id join fl_produtos p on p.id=k.produto_id
  left join fis on fis.produto_id=k.produto_id and fis.local_id=k.local_id
  left join res on res.produto_id=k.produto_id and res.local_id=k.local_id
  left join tra on tra.produto_id=k.produto_id and tra.local_id=k.local_id
  left join pen on pen.produto_id=k.produto_id and pen.local_id=k.local_id
  where fl_pode_roca() or fl_pode_fin('roca')
  order by p.nome, loc.nome
$$;

-- ---------------------------------------------------------------------
-- E. PDV da FL Adega
-- ---------------------------------------------------------------------
alter table fl_vendas add column if not exists operador uuid;
alter table fl_vendas add column if not exists operador_nome text;
alter table fl_vendas add column if not exists valor_recebido numeric;
alter table fl_vendas add column if not exists troco numeric;
alter table fl_vendas add column if not exists cancelado_em timestamptz;
alter table fl_vendas add column if not exists cancelado_por text;
alter table fl_vendas add column if not exists motivo_cancelamento text;
alter table fl_vendas add column if not exists arquivo_id bigint;

-- Local de onde sai a mercadoria. Venda de marketplace sem modalidade conhecida não baixa estoque (fica pendente até indicar a modalidade).
create or replace function fl_local_da_venda(p_venda bigint) returns int language plpgsql stable security definer set search_path=public as $$
declare v fl_vendas; l int; baixa text;
begin
  select * into v from fl_vendas where id=p_venda;
  if v.local_id is not null then return v.local_id; end if;
  if v.modalidade in ('full','fba') then
    select id into l from fl_locais where tipo='full' and ativo and (ml_conta_id=v.ml_conta_id or (v.ml_conta_id is null and empresa_id=v.empresa_id)) order by id limit 1;
    return l;
  end if;
  if v.canal<>'loja' and v.modalidade is null then return null; end if;
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

-- Baixa/estorno explícitos e idempotentes (cancelamento gera estorno, não apaga a venda do histórico)
create or replace function fl_baixar_item(p_item bigint) returns void language plpgsql security definer set search_path=public as $$
declare i record; loc int; ref text:='vi:'||p_item; tem_venda boolean;
begin
  select vi.*, v.status, v.duplicada_de, v.data_venda, v.pedido, v.canal into i from fl_venda_itens vi join fl_vendas v on v.id=vi.venda_id where vi.id=p_item;
  if i.id is null then return; end if;
  loc:=fl_local_da_venda(i.venda_id);
  if i.produto_id is null or i.eh_servico or loc is null or i.duplicada_de is not null or i.status='pendente' then
    delete from fl_mov where origem='venda' and origem_ref in (ref,ref||':estorno');
    return;
  end if;
  insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,venda_id,responsavel)
  values (i.produto_id,loc,i.data_venda,'venda',-abs(i.qtd),'venda',ref,coalesce('Pedido '||i.pedido,'Venda '||i.venda_id),i.venda_id,'Sistema')
  on conflict (origem,origem_ref) do update set produto_id=excluded.produto_id,local_id=excluded.local_id,qtd=excluded.qtd
  where fl_mov.produto_id is distinct from excluded.produto_id or fl_mov.local_id is distinct from excluded.local_id or fl_mov.qtd is distinct from excluded.qtd;
  if i.status in ('cancelada','devolvida') then
    insert into fl_mov(produto_id,local_id,data,tipo,qtd,origem,origem_ref,documento,venda_id,responsavel)
    values (i.produto_id,loc,now(),'estorno_venda',abs(i.qtd),'venda',ref||':estorno','Estorno '||coalesce(i.pedido,'venda '||i.venda_id),i.venda_id,'Sistema')
    on conflict (origem,origem_ref) do update set qtd=excluded.qtd,produto_id=excluded.produto_id,local_id=excluded.local_id
    where fl_mov.qtd is distinct from excluded.qtd or fl_mov.produto_id is distinct from excluded.produto_id or fl_mov.local_id is distinct from excluded.local_id;
  else
    delete from fl_mov where origem='venda' and origem_ref=ref||':estorno';
  end if;
end $$;
revoke all on function fl_baixar_item(bigint) from public, anon, authenticated;

-- Venda de balcão: preço do cadastro, desconto só com permissão, trava de estoque, idempotente pela chave.
-- p: {"chave":"uuid","local_id":3,"forma_pagamento":"dinheiro","valor_recebido":200,"desconto":0,"cliente":"","itens":[{"produto_id":"…","qtd":2}]}
create or replace function fl_pdv_vender(p jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare vid bigint; x jsonb; k int:=0; bruto numeric:=0; desc_ numeric:=coalesce((p->>'desconto')::numeric,0); emp int; uni int; loc int;
  fp text:=coalesce(p->>'forma_pagamento',''); rec numeric; pr fl_produtos; q numeric; disp numeric; total numeric; pf fl_perfis; chave text:=p->>'chave';
begin
  if not fl_pode_pdv() then raise exception 'Sem permissão para vender no PDV'; end if;
  if chave is null or length(chave)<8 then raise exception 'Chave da venda ausente'; end if;
  select id into vid from fl_vendas where origem='caixa' and origem_ref='cx:'||chave;
  if vid is not null then return fl_pdv_resumo(vid)||jsonb_build_object('repetida',true); end if;
  select * into pf from fl_perfis where user_id=auth.uid();
  if fp not in ('dinheiro','pix','debito','credito') then raise exception 'Escolha a forma de pagamento'; end if;
  if desc_<0 then raise exception 'Desconto inválido'; end if;
  if desc_>0 and not (pf.papel='master' or pf.pode_desconto) then raise exception 'Sem permissão para dar desconto'; end if;
  if jsonb_array_length(coalesce(p->'itens','[]'))=0 then raise exception 'Inclua ao menos um produto'; end if;
  loc:=(p->>'local_id')::int;
  select l.empresa_id,l.unidade_id into emp,uni from fl_locais l join fl_empresas e on e.id=l.empresa_id where l.id=loc and l.tipo='loja' and e.operacao='adega';
  if emp is null then raise exception 'Local de venda inválido (use a loja da FL Adega)'; end if;
  -- trava os produtos em ordem fixa e confere o saldo (itens repetidos são somados)
  for x in select jsonb_build_object('produto_id',value->>'produto_id','qtd',sum((value->>'qtd')::numeric)) from jsonb_array_elements(p->'itens')
           group by value->>'produto_id' order by value->>'produto_id' loop
    select * into pr from fl_produtos where id=(x->>'produto_id')::uuid;
    q:=(x->>'qtd')::numeric;
    if pr.id is null then raise exception 'Produto não encontrado'; end if;
    if q is null or q<=0 or q<>trunc(q) then raise exception 'Quantidade inválida para %', pr.nome; end if;
    if pr.preco_venda is null or pr.preco_venda<=0 then raise exception 'Produto sem preço de venda: %', pr.nome; end if;
    perform fl_travar(loc,pr.id);
    disp:=fl_saldo_fisico(loc,pr.id);
    if q>disp then raise exception 'Estoque insuficiente de %: disponível %', pr.nome, disp; end if;
    bruto:=bruto+q*pr.preco_venda;
  end loop;
  total:=bruto-desc_;
  if total<0 then raise exception 'Desconto maior que o total'; end if;
  if fp='dinheiro' then
    rec:=(p->>'valor_recebido')::numeric;
    if rec is null or rec<total then raise exception 'Valor recebido menor que o total (%)', total; end if;
  else rec:=total; end if;
  insert into fl_vendas(canal,empresa_id,unidade_id,origem,origem_ref,data_venda,status,cliente,valor_bruto,desconto,valor_liquido_previsto,
     modalidade,local_id,forma_pagamento,data_pagamento,liberado,operador,operador_nome,valor_recebido,troco)
  values ('loja',emp,uni,'caixa','cx:'||chave,now(),'concluida',nullif(p->>'cliente',''),bruto,desc_,total,'balcao',loc,fp,current_date,fp<>'credito',
     auth.uid(),coalesce(pf.nome,pf.email),rec,rec-total)
  returning id into vid;
  update fl_vendas set pedido='PDV-'||lpad(vid::text,6,'0') where id=vid;
  for x in select * from jsonb_array_elements(p->'itens') loop
    k:=k+1; select * into pr from fl_produtos where id=(x->>'produto_id')::uuid;
    insert into fl_venda_itens(venda_id,n,produto_id,sku,descricao,qtd,preco_unit) values (vid,k,pr.id,pr.sku,pr.nome,(x->>'qtd')::numeric,pr.preco_venda);
  end loop;
  insert into fl_lancamentos(tipo,natureza,empresa_id,categoria,descricao,valor,competencia,vencimento,status,valor_pago,data_pagamento,venda_id,origem,origem_ref)
  values ('receber','venda',emp,'Venda balcão','PDV-'||lpad(vid::text,6,'0')||' ('||fp||')',total,current_date,current_date,
     case when fp='credito' then 'aberto' else 'pago' end, case when fp='credito' then null else total end,
     case when fp='credito' then null else current_date end, vid,'caixa','cx:'||vid);
  -- confere que nenhum saldo ficou negativo (proteção extra)
  if exists(select 1 from fl_venda_itens vi where vi.venda_id=vid and fl_saldo_fisico(loc,vi.produto_id)<0) then
    raise exception 'Estoque insuficiente (venda simultânea). Tente de novo.';
  end if;
  return fl_pdv_resumo(vid);
end $$;

create or replace function fl_pdv_resumo(p_venda bigint) returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('id',v.id,'numero',v.pedido,'data',v.data_venda,'operador',v.operador_nome,'status',v.status,
    'forma_pagamento',v.forma_pagamento,'bruto',v.valor_bruto,'desconto',v.desconto,'total',v.valor_bruto-v.desconto,
    'valor_recebido',v.valor_recebido,'troco',v.troco,'motivo_cancelamento',v.motivo_cancelamento,
    'itens',(select jsonb_agg(jsonb_build_object('descricao',vi.descricao,'sku',vi.sku,'qtd',vi.qtd,'preco',vi.preco_unit,'total',vi.qtd*vi.preco_unit) order by vi.n)
             from fl_venda_itens vi where vi.venda_id=v.id))
  from fl_vendas v where v.id=p_venda
    and (fl_pode_fin('adega') or (fl_pode_pdv() and (v.operador=auth.uid() or (select papel='master' or pode_cancelar from fl_perfis where user_id=auth.uid()))))
$$;

-- Cancelamento: exige permissão e motivo; reverte uma única vez
create or replace function fl_pdv_cancelar(p_venda bigint, p_motivo text) returns jsonb language plpgsql security definer set search_path=public as $$
declare v fl_vendas; pf fl_perfis;
begin
  select * into pf from fl_perfis where user_id=auth.uid() and ativo;
  if not (pf.papel='master' or (pf.papel in ('pdv','operacao','financeiro') and pf.pode_cancelar)) then raise exception 'Sem permissão para cancelar venda'; end if;
  if coalesce(trim(p_motivo),'')='' then raise exception 'Informe o motivo do cancelamento'; end if;
  select * into v from fl_vendas where id=p_venda and origem='caixa' for update;
  if v.id is null then raise exception 'Venda do PDV não encontrada'; end if;
  if v.status='cancelada' then return fl_pdv_resumo(p_venda)||jsonb_build_object('repetida',true); end if;
  update fl_vendas set status='cancelada',valor_cancelado=valor_bruto-desconto,cancelado_em=now(),cancelado_por=coalesce(pf.nome,pf.email),
    motivo_cancelamento=trim(p_motivo) where id=p_venda;
  update fl_lancamentos set status='cancelado',obs=coalesce(obs||' · ','')||'Cancelado: '||trim(p_motivo) where venda_id=p_venda and origem='caixa';
  return fl_pdv_resumo(p_venda);
end $$;

-- Busca de vinhos no PDV: preço e disponível em Cuiabá
create or replace function fl_pdv_produtos(p_local int) returns table(produto_id uuid, sku text, ean text, nome text, preco numeric, disponivel numeric,
  tipo_vinho text, uva text, safra int, volume_ml int)
language sql stable security definer set search_path=public as $$
  select p.id,p.sku,p.ean,p.nome,p.preco_venda,fl_saldo_fisico(p_local,p.id),p.tipo_vinho,p.uva,p.safra,p.volume_ml
  from fl_produtos p where fl_pode_pdv() and p.ativo and not p.eh_kit
    and (p.preco_venda is not null or exists(select 1 from fl_mov m where m.local_id=p_local and m.produto_id=p.id))
  order by p.nome
$$;

-- Fechamento de caixa: totais por forma de pagamento (operador vê o próprio caixa)
create or replace function fl_pdv_fechamento(p_de timestamptz, p_ate timestamptz, p_local int default null, p_todos boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare pf fl_perfis; ve_todos boolean; r jsonb;
begin
  select * into pf from fl_perfis where user_id=auth.uid() and ativo;
  if not (fl_pode_pdv() or fl_pode_fin('adega')) then raise exception 'Sem permissão'; end if;
  ve_todos:=p_todos and (pf.papel='master' or fl_pode_fin('adega'));
  with v as (select * from fl_vendas where origem='caixa' and data_venda between p_de and p_ate
               and (p_local is null or local_id=p_local) and (ve_todos or operador=auth.uid()))
  select jsonb_build_object(
    'por_forma',coalesce((select jsonb_agg(jsonb_build_object('forma',forma_pagamento,'vendas',n,'total',t) order by forma_pagamento)
       from (select forma_pagamento,count(*) n,sum(valor_bruto-desconto) t from v where status='concluida' group by 1) z),'[]'),
    'total',coalesce((select sum(valor_bruto-desconto) from v where status='concluida'),0),
    'qtd_vendas',(select count(*) from v where status='concluida'),
    'canceladas',(select count(*) from v where status='cancelada'),
    'troco_dado',coalesce((select sum(troco) from v where status='concluida' and forma_pagamento='dinheiro'),0),
    'dinheiro_recebido',coalesce((select sum(valor_recebido) from v where status='concluida' and forma_pagamento='dinheiro'),0),
    'vendas',coalesce((select jsonb_agg(jsonb_build_object('id',id,'numero',pedido,'data',data_venda,'operador',operador_nome,'forma',forma_pagamento,
        'total',valor_bruto-desconto,'status',status,'motivo',motivo_cancelamento) order by data_venda desc) from v),'[]'),
    'escopo',case when ve_todos then 'todos' else 'proprio' end) into r;
  return r;
end $$;

-- a função antiga do caixa deixa de ser usada pelo site
revoke all on function fl_venda_balcao(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- F. Conciliação: arquivos, vendas importadas, extrato e vínculos
-- ---------------------------------------------------------------------
create table if not exists fl_imp_arquivos(
  id bigserial primary key, tipo text not null check (tipo in ('vendas','extrato')),
  ml_conta_id int references fl_ml_contas(id), conta_fin_id int references fl_contas_fin(id),
  nome text not null, sha256 text not null, caminho text, formato text,
  linhas int, novos int default 0, atualizados int default 0, iguais int default 0, erros int default 0,
  importado_por uuid default auth.uid(), importado_por_nome text, importado_em timestamptz default now());
create index if not exists fl_imp_arquivos_sha on fl_imp_arquivos(sha256);

create table if not exists fl_extrato(
  id bigserial primary key, conta_fin_id int not null references fl_contas_fin(id), data date not null, valor numeric not null,
  descricao text, ref text, chave text not null, arquivo_id bigint references fl_imp_arquivos(id),
  importado_em timestamptz default now(), unique(conta_fin_id,chave));
create table if not exists fl_conciliacoes(
  id bigserial primary key, extrato_id bigint not null unique references fl_extrato(id),
  metodo text not null check (metodo in ('identificador','manual')), anexo text, obs text,
  diferenca numeric not null default 0, por uuid default auth.uid(), por_nome text, em timestamptz default now());
create table if not exists fl_conc_itens(
  conc_id bigint not null references fl_conciliacoes(id) on delete cascade,
  venda_id bigint not null unique references fl_vendas(id), valor numeric not null, primary key(conc_id,venda_id));

-- Conta bancária da Roca (criada se não houver)
insert into fl_contas_fin(empresa_id,nome,tipo) select id,'Banco Roca Imports','banco' from fl_empresas e
  where e.operacao='roca' and not exists (select 1 from fl_contas_fin c where c.empresa_id=e.id and c.tipo='banco');

create or replace function fl_imp_registrar(p jsonb) returns bigint language plpgsql security definer set search_path=public as $$
declare aid bigint; op text;
begin
  if p->>'tipo'='vendas' then op:=fl_op_empresa((select empresa_id from fl_ml_contas where id=(p->>'ml_conta_id')::int));
  else op:=fl_op_empresa((select empresa_id from fl_contas_fin where id=(p->>'conta_fin_id')::int)); end if;
  if not fl_pode_fin(coalesce(op,'__')) then raise exception 'Sem permissão'; end if;
  insert into fl_imp_arquivos(tipo,ml_conta_id,conta_fin_id,nome,sha256,caminho,formato,linhas,importado_por_nome)
  values (p->>'tipo',(p->>'ml_conta_id')::int,(p->>'conta_fin_id')::int,p->>'nome',p->>'sha256',p->>'caminho',p->>'formato',(p->>'linhas')::int,fl_nome_usuario())
  returning id into aid;
  return aid;
end $$;

-- Importa vendas do arquivo do ML. p_vendas: [{pedido,data,status,cliente,pack_id,bruto,desconto,cancelado,devolvido,tarifa,frete,outros,liquido,data_liberacao,
--   itens:[{sku,item_ml,descricao,qtd,preco_unit,tarifa}]}]. Reimportar não duplica (chave = nº da venda).
create or replace function fl_importar_vendas(p_arquivo bigint, p_conta int, p_vendas jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare v jsonb; res text; n_novo int:=0; n_atu int:=0; n_igual int:=0; emp int; vid bigint;
begin
  select empresa_id into emp from fl_ml_contas where id=p_conta;
  if not fl_pode_fin(coalesce(fl_op_empresa(emp),'__')) then raise exception 'Sem permissão'; end if;
  for v in select * from jsonb_array_elements(p_vendas) loop
    if coalesce(v->>'pedido','')='' then raise exception 'Venda sem número'; end if;
    res:=fl_gravar_venda(jsonb_build_object('canal','mercado_livre','empresa_id',emp,'ml_conta_id',p_conta,'origem','ml','origem_ref',v->>'pedido',
       'pedido',v->>'pedido','pack_id',v->>'pack_id','data_venda',v->>'data','status',coalesce(v->>'status','concluida'),'cliente',v->>'cliente',
       'logistica',v->>'logistica','valor_bruto',v->>'bruto','desconto',coalesce(v->>'desconto','0'),'valor_cancelado',coalesce(v->>'cancelado','0'),
       'valor_devolvido',coalesce(v->>'devolvido','0'),'tarifa_venda',coalesce(v->>'tarifa','0'),'frete_vendedor',coalesce(v->>'frete','0'),
       'outros_custos_var',coalesce(v->>'outros','0'),'valor_liquido_previsto',v->>'liquido','data_liberacao',v->>'data_liberacao'),
       v->'itens');
    select id into vid from fl_vendas where origem='ml' and origem_ref=v->>'pedido';
    update fl_vendas set arquivo_id=coalesce(arquivo_id,p_arquivo) where id=vid;
    -- vínculo pelo SKU do cadastro
    update fl_venda_itens vi set produto_id=p.id from fl_produtos p
      where vi.venda_id=vid and vi.produto_id is null and vi.sku is not null and upper(p.sku)=upper(vi.sku);
    if res='novo' then n_novo:=n_novo+1; elsif res='atualizado' then n_atu:=n_atu+1; else n_igual:=n_igual+1; end if;
  end loop;
  update fl_imp_arquivos set novos=n_novo,atualizados=n_atu,iguais=n_igual where id=p_arquivo;
  return jsonb_build_object('novos',n_novo,'atualizados',n_atu,'iguais',n_igual);
end $$;

-- Importa linhas do extrato. p_linhas: [{data,valor,descricao,ref,chave}] — chave única por conta (FITID do OFX ou hash da linha).
create or replace function fl_importar_extrato(p_arquivo bigint, p_conta_fin int, p_linhas jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare x jsonb; n_novo int:=0; n_igual int:=0; emp int; ok boolean;
begin
  select empresa_id into emp from fl_contas_fin where id=p_conta_fin;
  if not fl_pode_fin(coalesce(fl_op_empresa(emp),'__')) then raise exception 'Sem permissão'; end if;
  for x in select * from jsonb_array_elements(p_linhas) loop
    insert into fl_extrato(conta_fin_id,data,valor,descricao,ref,chave,arquivo_id)
    values (p_conta_fin,(x->>'data')::date,(x->>'valor')::numeric,x->>'descricao',x->>'ref',x->>'chave',p_arquivo)
    on conflict (conta_fin_id,chave) do nothing returning true into ok;
    if ok then n_novo:=n_novo+1; else n_igual:=n_igual+1; end if; ok:=null;
  end loop;
  update fl_imp_arquivos set novos=n_novo,iguais=n_igual where id=p_arquivo;
  return jsonb_build_object('novos',n_novo,'iguais',n_igual);
end $$;

-- Confirma o vínculo de um crédito bancário com uma ou mais vendas. A soma prevista precisa bater (ou diferença justificada).
create or replace function fl_conciliar(p_extrato bigint, p_vendas bigint[], p_metodo text, p_anexo text default null, p_obs text default null)
returns bigint language plpgsql security definer set search_path=public as $$
declare e fl_extrato; cid bigint; soma numeric; dif numeric; v record; emp int;
begin
  select * into e from fl_extrato where id=p_extrato for update;
  if e.id is null then raise exception 'Lançamento do extrato não encontrado'; end if;
  select empresa_id into emp from fl_contas_fin where id=e.conta_fin_id;
  if not fl_pode_fin(coalesce(fl_op_empresa(emp),'__')) then raise exception 'Sem permissão'; end if;
  if e.valor<=0 then raise exception 'Somente créditos podem ser conciliados com vendas'; end if;
  if exists(select 1 from fl_conciliacoes where extrato_id=p_extrato) then raise exception 'Este crédito já foi conciliado'; end if;
  if coalesce(array_length(p_vendas,1),0)=0 then raise exception 'Escolha as vendas'; end if;
  if exists(select 1 from fl_conc_itens where venda_id=any(p_vendas)) then raise exception 'Há venda já conciliada com outro crédito'; end if;
  select sum(coalesce(valor_liquido_previsto,valor_bruto-desconto-valor_cancelado-valor_devolvido-tarifa_venda-frete_vendedor)) into soma from fl_vendas where id=any(p_vendas);
  dif:=round(e.valor-soma,2);
  if p_metodo='identificador' and abs(dif)>0.01 then raise exception 'Valores não batem (diferença %): confirme manualmente com justificativa', dif; end if;
  if p_metodo='manual' and abs(dif)>0.01 and coalesce(trim(p_obs),'')='' then raise exception 'Diferença de %: informe a justificativa', dif; end if;
  if p_metodo='manual' and coalesce(trim(p_obs),'')='' and coalesce(p_anexo,'')='' then raise exception 'Confirmação manual: anexe o relatório de repasses ou escreva a justificativa'; end if;
  insert into fl_conciliacoes(extrato_id,metodo,anexo,obs,diferenca,por_nome) values (p_extrato,p_metodo,p_anexo,p_obs,dif,fl_nome_usuario()) returning id into cid;
  -- distribui o crédito entre as vendas, proporcional ao previsto
  for v in select id, coalesce(valor_liquido_previsto,valor_bruto-desconto-valor_cancelado-valor_devolvido-tarifa_venda-frete_vendedor) prev from fl_vendas where id=any(p_vendas) loop
    insert into fl_conc_itens(conc_id,venda_id,valor) values (cid,v.id,round(case when soma=0 then e.valor/array_length(p_vendas,1) else e.valor*v.prev/soma end,2));
  end loop;
  return cid;
end $$;
create or replace function fl_desconciliar(p_conc bigint) returns void language plpgsql security definer set search_path=public as $$
declare emp int;
begin
  select cf.empresa_id into emp from fl_conciliacoes c join fl_extrato e on e.id=c.extrato_id join fl_contas_fin cf on cf.id=e.conta_fin_id where c.id=p_conc;
  if not fl_pode_fin(coalesce(fl_op_empresa(emp),'__')) then raise exception 'Sem permissão'; end if;
  delete from fl_conciliacoes where id=p_conc;
end $$;

-- Apuração por venda: receita, CMV (custo congelado), tarifas, frete, ganho, previsto, recebido no banco.
-- p_produto filtra itens do produto (receita/CMV/tarifa do item; frete e outras rateados pelo valor do item).
create or replace function fl_apuracao(p_de date, p_ate date, p_ml_conta int default null, p_produto uuid default null, p_op text default 'roca')
returns table(venda_id bigint, pedido text, data_venda timestamptz, conta text, status text, vendido numeric, deducoes numeric, receita numeric,
  cmv numeric, custo_pendente boolean, tarifas numeric, frete numeric, outras numeric, ganho numeric, previsto numeric, recebido numeric, conciliada boolean)
language plpgsql stable security definer set search_path=public as $$
begin
  if not fl_pode_fin(p_op) then raise exception 'Sem permissão'; end if;
  return query
  with base as (
    select v.*, m.apelido from fl_vendas v left join fl_ml_contas m on m.id=v.ml_conta_id join fl_empresas e on e.id=v.empresa_id
    where e.operacao=p_op and v.duplicada_de is null and v.data_venda>=p_de::timestamptz and v.data_venda<(p_ate+1)::timestamptz
      and (p_ml_conta is null or v.ml_conta_id=p_ml_conta)
      and (p_produto is null or exists(select 1 from fl_venda_itens vi where vi.venda_id=v.id and vi.produto_id=p_produto))),
  it as (
    select vi.venda_id, sum(vi.qtd*vi.preco_unit-vi.desconto) val_itens,
      sum(case when p_produto is null or vi.produto_id=p_produto then vi.qtd*vi.preco_unit-vi.desconto else 0 end) val_sel,
      sum(case when p_produto is null or vi.produto_id=p_produto then vi.qtd*coalesce(c.custo_unit,0) else 0 end) cmv,
      bool_or((p_produto is null or vi.produto_id=p_produto) and not vi.eh_servico and (c.custo_unit is null)) pend,
      sum(case when p_produto is null or vi.produto_id=p_produto then vi.tarifa else 0 end) tar_itens
    from fl_venda_itens vi left join fl_venda_itens_custo c on c.item_id=vi.id
    where vi.venda_id in (select id from base) group by 1),
  calc as (
    select b.*, coalesce(it.val_itens,0) val_itens, coalesce(it.val_sel,0) val_sel, coalesce(it.cmv,0) cmv_, coalesce(it.pend,true) pend_, coalesce(it.tar_itens,0) tar_itens,
      case when p_produto is null or coalesce(it.val_itens,0)=0 then 1 else it.val_sel/it.val_itens end fr,
      (select coalesce(sum(ci.valor),0) from fl_conc_itens ci where ci.venda_id=b.id) rec,
      exists(select 1 from fl_conc_itens ci where ci.venda_id=b.id) conc
    from base b left join it on it.venda_id=b.id)
  select c.id, c.pedido, c.data_venda, coalesce(c.apelido, case when c.canal='loja' then 'Loja Cuiabá' end), c.status,
    round(c.valor_bruto*c.fr,2),
    round((c.desconto+c.valor_cancelado+c.valor_devolvido)*c.fr,2),
    round(case when c.status='cancelada' then 0 else (c.valor_bruto-c.desconto-c.valor_cancelado-c.valor_devolvido)*c.fr end,2),
    round(case when c.status in ('cancelada','devolvida') then 0 else c.cmv_ end,2),
    case when c.status in ('cancelada','devolvida') then false else c.pend_ end,
    round(case when p_produto is null then c.tarifa_venda when c.tar_itens>0 then c.tar_itens else c.tarifa_venda*c.fr end,2),
    round(c.frete_vendedor*c.fr,2), round(c.outros_custos_var*c.fr,2),
    round(case when c.status='cancelada' then 0 else (c.valor_bruto-c.desconto-c.valor_cancelado-c.valor_devolvido)*c.fr end
      - case when c.status in ('cancelada','devolvida') then 0 else c.cmv_ end
      - case when p_produto is null then c.tarifa_venda when c.tar_itens>0 then c.tar_itens else c.tarifa_venda*c.fr end
      - c.frete_vendedor*c.fr - c.outros_custos_var*c.fr,2),
    round(coalesce(c.valor_liquido_previsto, c.valor_bruto-c.desconto-c.valor_cancelado-c.valor_devolvido-c.tarifa_venda-c.frete_vendedor)*c.fr,2),
    round(c.rec*c.fr,2), c.conc
  from calc c order by c.data_venda desc;
end $$;

-- Totais da apuração com regras de margem (sem base / pendente de conferência)
create or replace function fl_apuracao_total(p_de date, p_ate date, p_ml_conta int default null, p_produto uuid default null, p_op text default 'roca')
returns jsonb language sql stable security definer set search_path=public as $$
  with a as (select * from fl_apuracao(p_de,p_ate,p_ml_conta,p_produto,p_op)),
  t as (select coalesce(sum(vendido),0) vendido, coalesce(sum(deducoes),0) deducoes, coalesce(sum(receita),0) receita, coalesce(sum(cmv),0) cmv,
          coalesce(sum(tarifas),0) tarifas, coalesce(sum(frete),0) frete, coalesce(sum(outras),0) outras, coalesce(sum(ganho),0) ganho,
          coalesce(sum(previsto),0) previsto, coalesce(sum(recebido),0) recebido, count(*) vendas, count(*) filter (where custo_pendente) pend,
          count(*) filter (where not conciliada and status not in ('cancelada')) nao_conc from a)
  select jsonb_build_object('vendido',vendido,'deducoes',deducoes,'receita',receita,'cmv',cmv,'tarifas',tarifas,'frete',frete,'outras',outras,
    'ganho',ganho,'previsto',previsto,'recebido',recebido,'diferenca',round(previsto-recebido,2),'vendas',vendas,'vendas_sem_custo',pend,'nao_conciliadas',nao_conc,
    'margem',case when receita=0 then null else round(ganho/receita*100,2) end,
    'situacao',case when receita=0 then 'Sem base para cálculo' when pend>0 then 'Margem pendente de conferência' else 'ok' end) from t
$$;

-- ---------------------------------------------------------------------
-- G. Permissões (RLS) das estruturas novas e ajustes
-- ---------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['fl_compras','fl_compra_itens','fl_compra_receb','fl_compra_receb_itens','fl_remessas','fl_remessa_itens','fl_remessa_hist',
    'fl_imp_arquivos','fl_extrato','fl_conciliacoes','fl_conc_itens','fl_convites'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists r on %I', t);
    execute format('drop policy if exists w on %I', t);
  end loop; end $$;
-- Roca: leitura para a operação (escrita só pelas funções acima)
create policy r on fl_compras for select using (fl_pode_roca() or fl_pode_fin('roca'));
create policy r on fl_compra_itens for select using (fl_pode_roca() or fl_pode_fin('roca'));
create policy r on fl_compra_receb for select using (fl_pode_roca() or fl_pode_fin('roca'));
create policy r on fl_compra_receb_itens for select using (fl_pode_roca() or fl_pode_fin('roca'));
create policy r on fl_remessas for select using (fl_pode_roca() or fl_pode_fin('roca'));
create policy r on fl_remessa_itens for select using (fl_pode_roca() or fl_pode_fin('roca'));
create policy r on fl_remessa_hist for select using (fl_pode_roca() or fl_pode_fin('roca'));
-- Financeiro: só quem tem a operação autorizada
create policy r on fl_imp_arquivos for select using (fl_pode_fin(fl_op_empresa(coalesce((select empresa_id from fl_ml_contas where id=ml_conta_id),(select empresa_id from fl_contas_fin where id=conta_fin_id)))));
create policy r on fl_extrato for select using (fl_pode_fin(fl_op_empresa((select empresa_id from fl_contas_fin where id=conta_fin_id))));
create policy r on fl_conciliacoes for select using (fl_pode_fin(null));
create policy r on fl_conc_itens for select using (fl_pode_fin(null));
create policy r on fl_convites for select using (fl_master());
create policy w on fl_convites for all using (fl_master()) with check (fl_master());

-- Ajustes de tabelas existentes para os novos perfis
drop policy if exists w on fl_produtos;
create policy w on fl_produtos for all using (fl_pode_roca()) with check (fl_pode_roca());
drop policy if exists r on fl_vendas; drop policy if exists r on fl_venda_itens;
create policy r on fl_vendas for select using (fl_pode_fin_empresa(empresa_id) or fl_tem('operacao') or (fl_pode_pdv() and operador=auth.uid()));
create policy r on fl_venda_itens for select using (exists(select 1 from fl_vendas v where v.id=venda_id));
drop policy if exists r on fl_lancamentos; drop policy if exists r on fl_contas_fin;
create policy r on fl_lancamentos for select using (fl_master() or (fl_tem('financeiro') and fl_pode_fin_empresa(empresa_id)));
create policy r on fl_contas_fin for select using (fl_master() or (fl_tem('financeiro') and fl_pode_fin_empresa(empresa_id)));
drop policy if exists r on fl_notas;
create policy r on fl_notas for select using (fl_master() or fl_tem('compras') or (fl_tem('financeiro') and fl_pode_fin_empresa(empresa_id)) or (tipo='saida' and fl_tem('operacao')));
-- perfis: master gerencia; cada um vê o seu
drop policy if exists fl_perfis_upd on fl_perfis;
create policy fl_perfis_upd on fl_perfis for update using (fl_master()) with check (fl_master());

-- funções internas
revoke all on function fl_travar(int,uuid) from public, anon, authenticated;
revoke all on function fl_remessa_checar(bigint) from public, anon, authenticated;
revoke all on function fl_remessa_log(bigint,text,text) from public, anon, authenticated;
