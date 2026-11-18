// =====================================================================
// FL Gestão — Caixa da loja (Cuiabá), Expedição e ajustes de canais
// =====================================================================

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
