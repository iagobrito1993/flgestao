#!/bin/bash
# C9: dois operadores tentam vender a última garrafa ao mesmo tempo (rodar após db_cenarios.sql)
P="psql -h /tmp/pgt -p 5499 -U postgres -d t -qtA"
vender(){ $P <<SQL 2>&1
set role authenticated; select set_config('test.uid','$1',false);
begin;
select 'VENDEU '||(fl_pdv_vender(jsonb_build_object('chave','ultima-garrafa-$2','local_id',(select id from fl_locais where nome='Loja Cuiabá'),'forma_pagamento','pix',
  'itens',jsonb_build_array(jsonb_build_object('produto_id','22222222-0000-0000-0000-000000000002','qtd',1))))->>'numero');
select pg_sleep(1.5);
commit;
SQL
}
vender 00000000-0000-0000-0000-00000000000c op1 > /tmp/c9a.txt &
vender 00000000-0000-0000-0000-00000000000d op2 > /tmp/c9b.txt &
wait
echo "Operador 1: $(grep -E 'VENDEU|ERROR' /tmp/c9a.txt | sed 's/.*ERROR: *//' | head -1)"
echo "Operador 2: $(grep -E 'VENDEU|ERROR' /tmp/c9b.txt | sed 's/.*ERROR: *//' | head -1)"
SALDO=$($P -c "select fl_saldo_fisico((select id from fl_locais where nome='Loja Cuiabá'),'22222222-0000-0000-0000-000000000002')")
VENDAS=$($P -c "select count(*) from fl_vendas where origem_ref like 'cx:ultima-garrafa-%'")
echo "Saldo final: $SALDO | vendas gravadas: $VENDAS"
[ "$SALDO" = "0" ] && [ "$VENDAS" = "1" ] && echo "OK C9: só uma venda concluída, estoque terminou em zero" || { echo "FALHA C9"; exit 1; }
