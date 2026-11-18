// =====================================================================
// FL Gestão — Caixa da loja (Cuiabá), Expedição e ajustes de canais
// =====================================================================

// ---------- Caixa da loja ----------
const CX={itens:[],local:null,saldos:{}};
const FORMAS={dinheiro:'Dinheiro',pix:'PIX',debito:'Cartão de débito',credito:'Cartão de crédito'};
TELAS.caixa=async function(){
  const lojas=REF.locais.filter(l=>l.tipo==='loja'&&l.ativo);
  if(!lojas.length){$('conteudo').innerHTML='<div class="aviso">Nenhum local do tipo loja cadastrado. Cadastre em Integrações e configurações.</div>';return;}
  if(!CX.local||!lojas.find(l=>l.id==CX.local))CX.local=lojas[0].id;
  const sal=await rpc('fl_saldo_local',{p_local:CX.local});CX.saldos={};sal.forEach(s=>CX.saldos[s.produto_id]=+s.saldo);
  const prods=REF.produtos.filter(p=>p.ativo&&!p.eh_kit);
  $('conteudo').innerHTML=`<div class="grade2">
   <div class="secao"><h2>Venda de balcão <small>${lojas.length>1?`<select style="width:auto" onchange="CX.local=+this.value;ir('caixa')">${opcoes(lojas,CX.local,null)}</select>`:esc(lojas[0].nome)}</small></h2>
    <div class="campo"><label>Produto (nome, EAN ou código) — Enter adiciona</label><input id="cx_b" list="cx_dl" placeholder="Bipe o código de barras ou digite" autocomplete="off">
     <datalist id="cx_dl">${prods.slice(0,4000).map(p=>`<option value="${esc(p.nome)}">${p.ean?esc(p.ean):''}</option>`).join('')}</datalist></div>
    <div id="cx_itens"></div>
    <div class="c3"><div class="campo"><label>Desconto (R$)</label><input id="cx_d" inputmode="decimal" value="0"></div>
     <div class="campo"><label>Pagamento</label><select id="cx_f">${opcoes(Object.entries(FORMAS).map(([id,nome])=>({id,nome})),'pix',null)}</select></div>
     <div class="campo"><label>Cliente (opcional)</label><input id="cx_c"></div></div>
    <div class="erro" id="cx_e"></div>
    <div class="rodape"><button onclick="CX.itens=[];desenharCaixa()">Limpar</button><button class="pri" id="cx_ok">Finalizar venda</button></div></div>
   <div class="secao"><h2>Vendas de hoje <small>${esc(local(CX.local).nome)}</small></h2><div id="cx_hoje">Carregando…</div></div></div>`;
  const add=()=>{const t=norm(val('cx_b'));if(!t)return;const dig=t.replace(/\D/g,'');
    const p=prods.find(x=>norm(x.nome)===t)||(dig.length>=8&&prods.find(x=>x.ean===dig))||(()=>{const c=REF.codigos.find(k=>k.status==='confirmado'&&k.produto_id&&norm(k.codigo)===t);return c&&produto(c.produto_id);})();
    if(!p){$('cx_e').textContent='Produto não encontrado.';return;}
    $('cx_e').textContent='';const ex=CX.itens.find(i=>i.produto_id===p.id);if(ex)ex.qtd++;else CX.itens.push({produto_id:p.id,qtd:1,preco_unit:+p.preco_venda||0});
    $('cx_b').value='';desenharCaixa();};
  $('cx_b').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();add();}};$('cx_b').onchange=add;
  $('cx_d').oninput=desenharCaixa;
  $('cx_ok').onclick=async()=>{const b=$('cx_ok');b.disabled=true;$('cx_e').textContent='';
    try{if(!CX.itens.length)throw new Error('Inclua ao menos um produto.');
      if(CX.itens.some(i=>!(i.preco_unit>0)))throw new Error('Há item sem preço.');
      const sem=CX.itens.filter(i=>(CX.saldos[i.produto_id]||0)<i.qtd);
      if(sem.length&&!confirm('Estoque insuficiente no sistema para: '+sem.map(i=>nomeProd(i.produto_id)).join(', ')+'. Vender mesmo assim? (vai gerar pendência de estoque negativo)'))return;
      const id=await rpc('fl_venda_balcao',{p:{local_id:CX.local,forma_pagamento:val('cx_f'),desconto:num(val('cx_d'))||0,cliente:val('cx_c'),itens:CX.itens}});
      CX.itens=[];toast('Venda '+id+' registrada. Estoque baixado.');ir('caixa');
    }catch(e){$('cx_e').textContent=msgErro(e);}finally{b.disabled=false;}};
  desenharCaixa();setTimeout(()=>$('cx_b')&&$('cx_b').focus(),50);
  const hoje=hojeISO();
  const vs=await q(sb.from('fl_vendas').select('id,pedido,data_venda,valor_bruto,desconto,forma_pagamento,status,fl_venda_itens(descricao,qtd)').eq('canal','loja').eq('local_id',CX.local).gte('data_venda',tsIni(hoje)).order('data_venda',{ascending:false}));
  const ok=vs.filter(v=>v.status==='concluida');
  $('cx_hoje').innerHTML=`<div class="kpis">${Object.entries(FORMAS).map(([k,n])=>{const a=ok.filter(v=>v.forma_pagamento===k);return a.length?`<div class="kpi"><div class="l">${n}</div><div class="v">${brl(soma(a,v=>v.valor_bruto-v.desconto))}</div><div class="s">${a.length} venda(s)</div></div>`:'';}).join('')}
    <div class="kpi"><div class="l">Total do dia</div><div class="v">${brl(soma(ok,v=>v.valor_bruto-v.desconto))}</div><div class="s">${ok.length} venda(s)</div></div></div>`+
    tabela([{t:'Hora',v:v=>fdh(v.data_venda).slice(-5)},{t:'Venda',v:v=>v.pedido},{t:'Itens',v:v=>(v.fl_venda_itens||[]).map(i=>nf(i.qtd)+'× '+i.descricao).join(', ')},{t:'Pagamento',v:v=>FORMAS[v.forma_pagamento]||v.forma_pagamento||''},
      {t:'Total',v:v=>v.valor_bruto-v.desconto,n:1,tot:1},{t:'',v:()=>'',h:v=>v.status==='cancelada'?'<span class="tag r">cancelada</span>':tem('financeiro')?`<button class="sm perigo" onclick="cancelarBalcao(${v.id})">Cancelar</button>`:''}],vs,{rolar:false,vazio:'Nenhuma venda hoje.'});
};
function desenharCaixa(){
  const el=$('cx_itens');if(!el)return;
  const tot=soma(CX.itens,i=>i.qtd*i.preco_unit),d=num(val('cx_d'))||0;
  el.innerHTML=CX.itens.length?`<table class="t"><thead><tr><th>Produto</th><th class="n">Estoque</th><th class="n">Qtd</th><th class="n">Preço</th><th class="n">Total</th><th></th></tr></thead><tbody>
   ${CX.itens.map((i,k)=>{const s=CX.saldos[i.produto_id]||0;return `<tr><td>${esc(nomeProd(i.produto_id))}</td><td class="n" style="${s<i.qtd?'color:var(--red)':''}">${nf(s)}</td>
    <td class="n"><input style="width:64px;text-align:right" value="${i.qtd}" inputmode="numeric" onchange="CX.itens[${k}].qtd=Math.max(1,parseInt(this.value)||1);desenharCaixa()"></td>
    <td class="n"><input style="width:90px;text-align:right" value="${String(i.preco_unit).replace('.',',')}" inputmode="decimal" onchange="CX.itens[${k}].preco_unit=num(this.value)||0;desenharCaixa()"></td>
    <td class="n">${brl(i.qtd*i.preco_unit)}</td><td><button class="sm lk" onclick="CX.itens.splice(${k},1);desenharCaixa()">remover</button></td></tr>`;}).join('')}</tbody>
   <tfoot><tr><td colspan="4">Total a receber${d?' (com desconto de '+brl(d)+')':''}</td><td class="n">${brl(tot-d)}</td><td></td></tr></tfoot></table>`:'<div class="vazio">Nenhum item. Bipe ou busque um produto.</div>';
}
function cancelarBalcao(id){confirmar('Cancelar venda de balcão','A venda fica como cancelada, o estoque volta para a loja e o recebimento é cancelado.','Cancelar venda',async()=>{
  await q(sb.from('fl_vendas').update({status:'cancelada'}).eq('id',id));
  await sb.from('fl_lancamentos').update({status:'cancelado'}).eq('venda_id',id).eq('origem','caixa');
  toast('Venda cancelada.');ir('caixa');});}

// ---------- Expedição ----------
let fExp={modal:'',conta:''};
TELAS.expedicao=async function(){
  const l=await rpc('fl_fila_expedicao');
  const contas=[...new Set(l.map(x=>x.conta).filter(Boolean))].sort();
  const vis=l.filter(x=>(!fExp.modal||x.modalidade===fExp.modal)&&(!fExp.conta||x.conta===fExp.conta));
  const grupo=st=>vis.filter(x=>x.expedicao_status===st);
  const cont=m=>l.filter(x=>x.modalidade===m&&['a_separar','separado'].includes(x.expedicao_status)).length;
  const bloco=(st,titulo,prox,rot)=>{const a=grupo(st);return `<div class="secao"><h2>${titulo} <small>${a.length} pedido(s)</small>${prox&&a.length?`<span><button class="sm" onclick="marcarTodos('${st}')">Selecionar todos</button> <button class="sm pri" onclick="moverExp('${st}','${prox}')">${rot}</button></span>`:''}</h2>
    ${tabela([...(prox?[{t:'',v:()=>'',h:x=>`<input type="checkbox" class="ck_${st}" value="${x.venda_id}">`}]:[]),
      {t:'Venda',v:x=>fdh(x.data_venda)},{t:'Conta',v:x=>(CANAL[x.canal]||'')+' · '+(x.conta||x.empresa||'')},{t:'Modalidade',v:x=>MODAL[x.modalidade]||'—',h:x=>tagModal(x.modalidade)||'<span class="tag">—</span>'},
      {t:'Pedido',v:x=>x.pedido||''},{t:'Cliente',v:x=>x.cliente||''},
      {t:'Produtos',v:x=>(x.itens||[]).map(i=>nf(i.qtd)+'× '+i.descricao).join(' · '),h:x=>(x.itens||[]).map(i=>`<b>${nf(i.qtd)}×</b> ${esc(i.descricao)}`).join('<br>')},
      ...(st==='despachado'||st==='entregue'?[{t:'Despachado',v:x=>fdh(x.despachado_em)}]:[])],a,{rolar:false,vazio:'Nada aqui.'})}</div>`;};
  $('conteudo').innerHTML=`<div class="kpis">${['flex','turbo','agencia','coleta','dba','shopee_xpress'].map(m=>`<div class="kpi ${cont(m)&&(m==='flex'||m==='turbo')?'alerta':''}" onclick="fExp.modal=fExp.modal==='${m}'?'':'${m}';ir('expedicao')" style="${fExp.modal===m?'border-color:var(--pri)':''}"><div class="l">${MODAL[m]}</div><div class="v">${cont(m)}</div><div class="s">a separar/despachar</div></div>`).join('')}</div>
   <div class="filtros"><div><label>Modalidade</label><select onchange="fExp.modal=this.value;ir('expedicao')">${opcoes(Object.entries(MODAL).map(([id,nome])=>({id,nome})),fExp.modal,'Todas')}</select></div>
    <div><label>Conta</label><select onchange="fExp.conta=this.value;ir('expedicao')">${opcoes(contas.map(c=>({id:c,nome:c})),fExp.conta,'Todas')}</select></div>
    <div class="btn"><button onclick="ir('expedicao')">Atualizar</button></div></div>
   <div class="info">Flex e Turbo têm prazo curto: despache no mesmo dia. Full e Amazon FBA não aparecem aqui (quem envia é o marketplace). Pedido sem modalidade: abra em Vendas e escolha a modalidade.</div>
   ${bloco('a_separar','A separar','separado','Marcar como separado')}${bloco('separado','Separados — aguardando envio','despachado','Marcar como despachado')}${bloco('despachado','Despachados (últimos 3 dias)',null)}`;
};
function marcarTodos(st){document.querySelectorAll('.ck_'+st).forEach(c=>c.checked=true);}
async function moverExp(st,prox){const ids=[...document.querySelectorAll('.ck_'+st+':checked')].map(c=>+c.value);
  if(!ids.length)return toast('Marque os pedidos primeiro.');
  try{const n=await rpc('fl_expedicao',{p_vendas:ids,p_status:prox});toast(n+' pedido(s) atualizados.');ir('expedicao');}catch(e){toast(msgErro(e));}}
async function mudarModalidade(id,m){if(!m)return;try{await q(sb.from('fl_vendas').update({modalidade:m}).eq('id',id));toast('Modalidade alterada para '+MODAL[m]+'.');fechar();ir(area);}catch(e){toast(msgErro(e));}}

// ---------- Amazon e Shopee na tela de integrações ----------
(function(){const orig=TELAS.integracoes;TELAS.integracoes=async function(extra){await orig(extra);
  if(typeof abaInt!=='undefined'&&abaInt==='ml'&&$('conteudo')){
    $('conteudo').insertAdjacentHTML('beforeend',`<div class="secao"><h2>Amazon e Shopee <small>conexão automática na próxima fase</small></h2>
     <div class="mut" style="margin-bottom:8px">As contas já estão cadastradas. A conexão pelas APIs oficiais (Amazon Selling Partner e Shopee Open Platform) entra na Fase 2; até lá, as vendas podem ser lançadas pela importação de planilha.</div>
     ${tabela([{t:'Canal',v:c=>CANAL[c.canal]},{t:'Conta',v:c=>c.apelido},{t:'Empresa',v:c=>empresa(c.empresa_id).nome},{t:'Status',v:c=>c.status,h:c=>`<span class="tag a">${esc(c.status.replace('_',' '))}</span>`}],REF.canalContas,{rolar:false})}</div>`);
  }};})();
