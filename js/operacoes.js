// =====================================================================
// FL Gestão — Início, Roca Imports (produtos, recebimentos, estoque, remessas),
// FL Adega (PDV e fechamento), Conciliação e Usuários e permissões.
// As regras valem no banco (funções e RLS); a tela só organiza o trabalho.
// =====================================================================
const pf=()=>perfil||{};
const podeRoca=()=>master()||['roca','estoque','compras'].includes(papel());
const podePDV=()=>master()||['pdv','operacao'].includes(papel());
const podeFin=op=>master()||(papel()==='financeiro'&&(op?OPS(perfil).includes(op):OPS(perfil).length>0));
const podeCusto=()=>master()||['financeiro','compras'].includes(papel())||pf().pode_editar_custo;
const locaisRoca=()=>REF.locais.filter(l=>l.ativo&&(empresa(l.empresa_id).operacao==='roca'));
const lojaAdega=()=>REF.locais.find(l=>l.ativo&&l.tipo==='loja'&&empresa(l.empresa_id).operacao==='adega');
const contasRoca=()=>REF.contasML.filter(c=>empresa(c.empresa_id).operacao==='roca');
function nfq(n){return nf(n,3);}

// ---------------------------------------------------------------- Início
TELAS.inicio=async function(){
  const cards=[];
  if(podeRoca())cards.push(`<div class="secao op"><h2>Roca Imports <small>atacado · contas · São Paulo · Full</small></h2>
    <div class="botoes"><button class="pri" onclick="ir('roca','sp')">Criar remessa para São Paulo</button><button class="pri" onclick="ir('roca','full')">Criar remessa para o Full</button>
    <button onclick="ir('roca','receber')">Receber mercadoria</button><button onclick="ir('roca','estoque')">Estoque por local e conta</button><button onclick="ir('roca','remessas')">Remessas</button><button onclick="ir('roca','produtos')">Produtos</button></div><div id="ini_roca" class="mut peq"></div></div>`);
  if(podePDV()||podeFin('adega'))cards.push(`<div class="secao op"><h2>FL Adega <small>vinhos · loja de Cuiabá</small></h2>
    <div class="botoes">${podePDV()?`<button class="pri" onclick="ir('pdv')">FL Adega → Abrir PDV</button>`:''}<button onclick="ir('fechamento')">Fechamento de caixa</button></div></div>`);
  if(podeFin())cards.push(`<div class="secao op"><h2>Financeiro <small>vendas, extratos, repasses e margens</small></h2>
    <div class="botoes"><button class="pri" onclick="ir('conc','vendas')">Importar arquivo de vendas</button><button class="pri" onclick="ir('conc','extrato')">Importar extrato bancário</button>
    <button onclick="ir('conc','conferencia')">Conferência dos repasses</button><button onclick="ir('conc','ganho')">Ganho e margem</button></div></div>`);
  if(master())cards.push(`<div class="secao op"><h2>Administração</h2><div class="botoes"><button onclick="ir('usuarios')">Usuários e permissões</button><button onclick="ir('visao')">Visão geral</button><button onclick="ir('integracoes')">Configurações</button></div></div>`);
  $('conteudo').innerHTML=`<div class="mut" style="margin-bottom:12px">Olá, ${esc(pf().nome||pf().email)}. Estas são as operações liberadas para o seu perfil.</div><div class="grade2">${cards.join('')||'<div class="aviso">Nenhuma operação liberada. Fale com o administrador.</div>'}</div>`;
  if(podeRoca()){try{const r=await q(sb.from('fl_remessas').select('status'));const c=s=>r.filter(x=>x.status===s).length;
    $('ini_roca').innerHTML=`${c('aberta')+c('separada')} remessa(s) em preparação · ${c('em_transito')} em trânsito · ${c('divergente')?'<b style="color:var(--red)">'+c('divergente')+' com divergência</b>':'0 com divergência'}`;}catch(e){}}
};

// ---------------------------------------------------------------- Roca Imports
let abaRoca='estoque';const fRoca={busca:'',local:''};
TELAS.roca=async function(extra){
  if(['estoque','produtos','recebimentos','remessas'].includes(extra))abaRoca=extra;
  if(extra==='receber'){abaRoca='recebimentos';}
  if(extra==='sp'||extra==='full'){abaRoca='remessas';}
  const ab=`<div class="barra-acoes"><button class="pri" onclick="modalRemessa('sp')">Criar remessa para São Paulo</button><button class="pri" onclick="modalRemessa('full')">Criar remessa para o Full</button>
    <button onclick="modalRecebimento()">Receber mercadoria</button><button onclick="modalProdutoRoca()">Novo produto</button></div>
    <div class="abas2">${[['estoque','Estoque'],['remessas','Remessas'],['recebimentos','Recebimentos'],['produtos','Produtos']].map(([k,n])=>`<button class="${abaRoca===k?'on':''}" onclick="abaRoca='${k}';ir('roca')">${n}</button>`).join('')}</div>`;
  if(abaRoca==='estoque')await rocaEstoque(ab);
  if(abaRoca==='produtos')await rocaProdutos(ab);
  if(abaRoca==='recebimentos')await rocaRecebimentos(ab);
  if(abaRoca==='remessas')await rocaRemessas(ab);
  if(extra==='receber')modalRecebimento();
  if(extra==='sp'||extra==='full')modalRemessa(extra);
};
async function rocaEstoque(ab){
  const l=await rpc('fl_estoque_roca');
  const t=norm(fRoca.busca);
  const vis=l.filter(x=>(!fRoca.local||x.local_id==fRoca.local)&&(!t||norm((x.sku||'')+' '+x.descricao).includes(t)));
  $('conteudo').innerHTML=ab+`<div class="filtros"><div><label>Buscar SKU ou descrição</label><input id="fr_b" value="${esc(fRoca.busca)}"></div>
    <div><label>Local</label><select id="fr_l">${opcoes(locaisRoca(),fRoca.local,'Todos')}</select></div></div>
    <div class="info">Físico = o que está no local. Reservado = separado para remessa (ainda no local). Disponível = físico − reservado. Em trânsito = saiu da origem e não chegou. Pendente de conferência = enviado e não recebido.</div>
    <div class="secao">${tabela([{t:'SKU',v:x=>x.sku||'—'},{t:'Descrição',v:x=>x.descricao},{t:'Local',v:x=>x.local},{t:'Conta',v:x=>x.conta||'—'},
      {t:'Físico',v:x=>+x.fisico,n:1,fmt:nfq},{t:'Reservado',v:x=>+x.reservado,n:1,fmt:nfq},{t:'Disponível',v:x=>+x.disponivel,n:1,fmt:nfq,h:x=>`<b>${nfq(+x.disponivel)}</b>`},
      {t:'Em trânsito',v:x=>+x.em_transito,n:1,fmt:nfq},{t:'Pendente conf.',v:x=>+x.pendente_conferencia,n:1,fmt:nfq,h:x=>+x.pendente_conferencia?`<span class="tag a">${nfq(+x.pendente_conferencia)}</span>`:'0'}],
      vis,{clique:x=>historicoMov(x.produto_id,x.local_id,x.descricao,x.local),vazio:'Nenhum saldo. Use “Receber mercadoria” para dar entrada.'})}</div>`;
  $('fr_b').oninput=()=>{fRoca.busca=val('fr_b');clearTimeout(rocaEstoque.t);rocaEstoque.t=setTimeout(()=>ir('roca'),350);};
  $('fr_l').onchange=()=>{fRoca.local=val('fr_l');ir('roca');};
}
const TIPO_MOV={compra:'Recebimento',transferencia_saida:'Saída (remessa)',transferencia_entrada:'Entrada (remessa)',venda:'Venda',estorno_venda:'Estorno de venda',ajuste:'Ajuste',saldo_inicial:'Saldo inicial',perda:'Perda',devolucao_venda:'Devolução'};
async function historicoMov(pid,loc,nome,nomeLoc){
  const m=await q(sb.from('fl_mov').select('data,tipo,qtd,documento,responsavel,origem,ml_conta_id,obs').eq('produto_id',pid).eq('local_id',loc).order('data',{ascending:false}).order('id',{ascending:false}).limit(500));
  detalhar(`${nome} · ${nomeLoc}`,'Histórico de movimentações (mais recente primeiro).',[{t:'Data',v:x=>fdh(x.data)},{t:'Tipo',v:x=>TIPO_MOV[x.tipo]||x.tipo},{t:'Qtd',v:x=>+x.qtd,n:1,fmt:nfq},
    {t:'Documento',v:x=>x.documento||''},{t:'Conta',v:x=>x.ml_conta_id?contaML(x.ml_conta_id).apelido:''},{t:'Responsável',v:x=>x.responsavel||''},{t:'Obs.',v:x=>x.obs||''}],m);
}
// --- produtos
async function rocaProdutos(ab){
  const t=norm(fRoca.busca);
  const ps=REF.produtos.filter(p=>!t||norm((p.sku||'')+' '+p.nome+' '+(p.ean||'')).includes(t));
  $('conteudo').innerHTML=ab+`<div class="filtros"><div><label>Buscar SKU, descrição ou código de barras</label><input id="fr_b" value="${esc(fRoca.busca)}"></div></div>
   <div class="secao">${tabela([{t:'SKU',v:p=>p.sku||'—'},{t:'Descrição',v:p=>p.nome},{t:'Código de barras',v:p=>p.ean||''},{t:'Unidade',v:p=>p.unidade},
     ...(podeCusto()?[{t:'Custo de aquisição',v:p=>p.custo_aquisicao==null?null:+p.custo_aquisicao,n:1}]:[]),{t:'Ativo',v:p=>p.ativo?'Sim':'Não'}],ps,{clique:p=>modalProdutoRoca(p)})}</div>`;
  $('fr_b').oninput=()=>{fRoca.busca=val('fr_b');clearTimeout(rocaProdutos.t);rocaProdutos.t=setTimeout(()=>ir('roca'),350);};
}
function modalProdutoRoca(p){
  const e=p||{};
  abrir(`<h2>${p?'Editar produto':'Novo produto'}</h2><div class="sub">Ao digitar um SKU que já existe, o cadastro dele é aberto (sem duplicar).</div>
   <div class="c2"><div class="campo"><label>SKU *</label><input id="pr_sku" value="${esc(e.sku||'')}" ${p?'':'autofocus'}></div><div class="campo"><label>Código de barras</label><input id="pr_ean" value="${esc(e.ean||'')}" inputmode="numeric"></div></div>
   <div class="campo"><label>Descrição *</label><input id="pr_nome" value="${esc(e.nome||'')}"></div>
   <div class="c2"><div class="campo"><label>Unidade de medida</label><select id="pr_un">${['UN','CX','PCT','KG','L','PAR','KIT'].map(u=>`<option ${(e.unidade||'UN')===u?'selected':''}>${u}</option>`).join('')}</select></div>
   <div class="campo"><label>Custo de aquisição (R$)</label><input id="pr_custo" inputmode="decimal" value="${e.custo_aquisicao!=null?String(e.custo_aquisicao).replace('.',','):''}" ${podeCusto()?'':'disabled placeholder="Sem permissão para editar custo"'}></div></div>
   <div class="erro"></div><div class="rodape"><button onclick="fechar()">Cancelar</button><button class="pri" id="pr_ok">Salvar</button></div>`);
  if(!p)$('pr_sku').onblur=()=>{const s=val('pr_sku').toUpperCase();const ex=REF.produtos.find(x=>x.sku&&x.sku.toUpperCase()===s);if(ex){toast('SKU já cadastrado: abrindo o cadastro.');modalProdutoRoca(ex);}};
  $('pr_ok').onclick=()=>rodar($('pr_ok'),async()=>{
    const d={sku:val('pr_sku').toUpperCase()||null,nome:val('pr_nome'),ean:val('pr_ean').replace(/\s/g,'')||null,unidade:val('pr_un')};
    if(!d.sku)throw new Error('Informe o SKU.');if(!d.nome)throw new Error('Informe a descrição.');
    if(podeCusto()){const c=num(val('pr_custo'));d.custo_aquisicao=val('pr_custo')===''?null:(isNaN(c)||c<0?(()=>{throw new Error('Custo inválido.');})():c);}
    const ex=REF.produtos.find(x=>x.sku&&x.sku.toUpperCase()===d.sku&&(!p||x.id!==p.id));if(ex){modalProdutoRoca(ex);throw new Error('Este SKU já existe — cadastro aberto.');}
    if(d.ean){const o=REF.produtos.find(x=>x.ean===d.ean&&(!p||x.id!==p.id));if(o)throw new Error('Código de barras já usado por: '+o.nome);}
    const r=p?await q(sb.from('fl_produtos').update(d).eq('id',p.id).select().single()):await q(sb.from('fl_produtos').insert(d).select().single());
    const i=REF.produtos.findIndex(x=>x.id===r.id);if(i>=0)REF.produtos[i]=r;else REF.produtos.push(r);
    fechar();toast('Produto salvo.');if(area==='roca')ir('roca');});
}
// seletor de produto por SKU / descrição / código de barras
function campoProduto(id,ph){return `<input id="${id}" list="${id}_dl" placeholder="${ph||'SKU, descrição ou código de barras'}" autocomplete="off"><datalist id="${id}_dl">${REF.produtos.filter(p=>p.ativo).slice(0,5000).map(p=>`<option value="${esc((p.sku?p.sku+' · ':'')+p.nome)}">`).join('')}</datalist>`;}
function acharProduto(txt){const t=String(txt||'').trim();if(!t)return null;const tu=t.toUpperCase();const sku=tu.split(' · ')[0];
  return REF.produtos.find(p=>p.sku&&p.sku.toUpperCase()===sku)||REF.produtos.find(p=>p.ean&&p.ean===t.replace(/\D/g,''))||REF.produtos.find(p=>norm((p.sku?p.sku+' · ':'')+p.nome)===norm(t))||REF.produtos.find(p=>norm(p.nome)===norm(t));}
// --- recebimentos
async function rocaRecebimentos(ab){
  const cs=await q(sb.from('fl_compras').select('*,fl_compra_itens(*),fl_compra_receb(*,fl_compra_receb_itens(*))').order('id',{ascending:false}).limit(300));
  cs.forEach(c=>{c.prev=soma(c.fl_compra_itens,i=>i.qtd);c.rec=soma(c.fl_compra_receb.flatMap(r=>r.fl_compra_receb_itens),i=>i.qtd);});
  $('conteudo').innerHTML=ab+`<div class="secao"><h2>Compras e recebimentos <small>clique para ver os itens e receber o restante</small></h2>
   ${tabela([{t:'Nº',v:c=>c.id},{t:'Data',v:c=>fd(c.data)},{t:'Fornecedor',v:c=>c.fornecedor},{t:'Documento',v:c=>c.documento||''},{t:'Local',v:c=>local(c.local_id).nome},
     {t:'Comprado',v:c=>c.prev,n:1,fmt:nfq},{t:'Recebido',v:c=>c.rec,n:1,fmt:nfq},{t:'Pendente',v:c=>c.prev-c.rec,n:1,fmt:nfq},
     {t:'Status',v:c=>c.status,h:c=>`<span class="tag ${c.status==='recebida'?'v':c.status==='parcial'?'a':''}">${c.status}</span>`}],cs,{clique:abrirCompra,vazio:'Nenhum recebimento ainda.'})}</div>`;
}
function abrirCompra(c){
  const rec=it=>soma(c.fl_compra_receb.flatMap(r=>r.fl_compra_receb_itens).filter(x=>x.item_id===it.id),x=>x.qtd);
  window._rc_chave=novaChave();
  abrir(`<h2>Compra ${c.id} · ${esc(c.fornecedor)}</h2><div class="sub">${esc(c.documento||'sem documento')} · ${fd(c.data)} · ${esc(local(c.local_id).nome)}</div>
   ${tabela([{t:'Produto',v:i=>nomeProd(i.produto_id)},{t:'Comprado',v:i=>+i.qtd,n:1,fmt:nfq},{t:'Recebido',v:i=>rec(i),n:1,fmt:nfq},{t:'Pendente',v:i=>i.qtd-rec(i),n:1,fmt:nfq},
     ...(c.status!=='recebida'?[{t:'Chegou agora',v:()=>'',h:i=>i.qtd-rec(i)>0?`<input class="rc_q" data-i="${i.id}" data-max="${i.qtd-rec(i)}" style="width:90px;text-align:right" inputmode="numeric" placeholder="0">`:''}]:[])],c.fl_compra_itens,{rolar:false})}
   <h3 style="font-size:14px">Recebimentos</h3>${tabela([{t:'Data',v:r=>fd(r.data)},{t:'Documento',v:r=>r.documento||''},{t:'Responsável',v:r=>r.responsavel_nome||''},{t:'Unidades',v:r=>soma(r.fl_compra_receb_itens,x=>x.qtd),n:1,fmt:nfq}],c.fl_compra_receb,{rolar:false})}
   ${c.status!=='recebida'?`<div class="c2"><div class="campo"><label>Data da chegada</label><input id="rc_d" type="date" value="${hojeISO()}"></div><div class="campo"><label>Documento desta entrega</label><input id="rc_doc" value="${esc(c.documento||'')}"></div></div>`:''}
   <div class="erro"></div><div class="rodape"><button onclick="fechar()">Fechar</button>${c.status!=='recebida'?'<button class="pri" id="rc_ok">Confirmar recebimento</button>':''}</div>`,true);
  if($('rc_ok'))$('rc_ok').onclick=()=>rodar($('rc_ok'),async()=>{
    const itens=[...document.querySelectorAll('.rc_q')].map(x=>({item_id:+x.dataset.i,qtd:num(x.value)||0,max:+x.dataset.max})).filter(x=>x.qtd>0);
    if(!itens.length)throw new Error('Informe a quantidade que chegou.');const ex=itens.find(x=>x.qtd>x.max);if(ex)throw new Error('Quantidade maior que a pendente.');
    await rpc('fl_compra_receber',{p_compra:c.id,p_itens:itens.map(({item_id,qtd})=>({item_id,qtd})),p_data:val('rc_d'),p_documento:val('rc_doc')||null,p_chave:window._rc_chave});
    fechar();toast('Recebimento registrado.');abaRoca='recebimentos';ir('roca');});
}
function modalRecebimento(){
  const locs=locaisRoca().filter(l=>l.tipo!=='full');window._rb={chave:novaChave(),itens:[]};
  abrir(`<h2>Receber mercadoria</h2><div class="sub">Informe o que foi comprado e o que chegou agora. O que faltar fica pendente para a próxima entrega.</div>
   <div class="c3"><div class="campo"><label>Fornecedor *</label><input id="rb_f"></div><div class="campo"><label>Documento de origem</label><input id="rb_doc" placeholder="NF, pedido…"></div><div class="campo"><label>Data</label><input id="rb_d" type="date" value="${hojeISO()}"></div></div>
   <div class="c2"><div class="campo"><label>Local de entrada</label><select id="rb_l">${opcoes(locs,(locs[0]||{}).id,null)}</select></div><div class="campo"><label>Produto</label>${campoProduto('rb_p')}</div></div>
   <div id="rb_it"></div><div class="erro"></div><div class="rodape"><button onclick="fechar()">Cancelar</button><button onclick="modalProdutoRoca()">+ Cadastrar produto</button><button class="pri" id="rb_ok">Confirmar entrada</button></div>`,true);
  const desenhar=()=>{$('rb_it').innerHTML=window._rb.itens.length?`<table class="t"><thead><tr><th>Produto</th><th class="n">Comprado</th><th class="n">Chegou agora</th>${podeCusto()?'<th class="n">Custo unit.</th>':''}<th></th></tr></thead><tbody>${window._rb.itens.map((i,k)=>`<tr><td>${esc((produto(i.produto_id).sku||'')+' · '+nomeProd(i.produto_id))}</td>
     <td class="n"><input style="width:80px;text-align:right" value="${i.qtd}" inputmode="numeric" onchange="_rb.itens[${k}].qtd=num(this.value)||0"></td>
     <td class="n"><input style="width:80px;text-align:right" value="${i.recebido}" inputmode="numeric" onchange="_rb.itens[${k}].recebido=num(this.value)||0"></td>
     ${podeCusto()?`<td class="n"><input style="width:90px;text-align:right" value="${i.custo_unit??''}" inputmode="decimal" onchange="_rb.itens[${k}].custo_unit=this.value===''?null:num(this.value)"></td>`:''}
     <td><button class="lk sm" onclick="_rb.itens.splice(${k},1);this.closest('table').dispatchEvent(new Event('redesenhar'))">remover</button></td></tr>`).join('')}</tbody></table>`:'<div class="vazio">Adicione os produtos (busque pelo SKU ou bipe o código de barras).</div>';
    const tb=$('rb_it').querySelector('table');if(tb)tb.addEventListener('redesenhar',desenhar);};
  window._rb_desenhar=desenhar;desenhar();
  const add=()=>{const p=acharProduto(val('rb_p'));if(!p){if(val('rb_p'))toast('Produto não encontrado. Cadastre antes.');return;}
    if(!window._rb.itens.find(i=>i.produto_id===p.id))window._rb.itens.push({produto_id:p.id,qtd:1,recebido:1,custo_unit:p.custo_aquisicao});$('rb_p').value='';desenhar();};
  $('rb_p').onchange=add;$('rb_p').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();add();}};
  $('rb_ok').onclick=()=>rodar($('rb_ok'),async()=>{const it=window._rb.itens;
    if(!val('rb_f'))throw new Error('Informe o fornecedor.');if(!it.length)throw new Error('Inclua ao menos um produto.');
    for(const i of it){if(!(i.qtd>0))throw new Error('Quantidade comprada inválida.');if(i.recebido<0||i.recebido>i.qtd)throw new Error('Chegou agora não pode passar do comprado.');}
    const id=await rpc('fl_compra_criar',{p:{fornecedor:val('rb_f'),documento:val('rb_doc'),data:val('rb_d'),local_id:+val('rb_l'),chave:window._rb.chave,
      itens:it.map(i=>({produto_id:i.produto_id,qtd:i.qtd,recebido:i.recebido,custo_unit:i.custo_unit}))}});
    fechar();toast('Entrada registrada (compra '+id+').');abaRoca='recebimentos';ir('roca');});
}
// --- remessas
const ST_REM={aberta:['Aberta',''],separada:['Separada (reservada)','b'],em_transito:['Em trânsito','a'],recebida:['Recebida','v'],divergente:['Com divergência','r'],cancelada:['Cancelada','']};
async function rocaRemessas(ab){
  const rs=await q(sb.from('fl_remessas').select('*,fl_remessa_itens(*)').order('id',{ascending:false}).limit(300));
  $('conteudo').innerHTML=ab+`<div class="secao"><h2>Remessas <small>clique para separar, confirmar saída, receber e conferir</small></h2>
   ${tabela([{t:'Nº',v:r=>r.numero},{t:'Tipo',v:r=>r.tipo==='full'?'Full':'São Paulo'},{t:'Data',v:r=>fd(r.data)},{t:'Origem',v:r=>local(r.origem_id).nome},{t:'Destino',v:r=>local(r.destino_id).nome},
     {t:'Conta',v:r=>r.ml_conta_id?contaML(r.ml_conta_id).apelido:'—'},{t:'Unidades',v:r=>soma(r.fl_remessa_itens,i=>i.qtd),n:1,fmt:nfq},{t:'Responsável',v:r=>r.responsavel_nome||''},
     {t:'Status',v:r=>r.status,h:r=>`<span class="tag ${ST_REM[r.status][1]}">${ST_REM[r.status][0]}</span>`}],rs,{clique:r=>abrirRemessa(r.id),vazio:'Nenhuma remessa ainda.'})}</div>`;
}
async function modalRemessa(tipo){
  const est=await rpc('fl_estoque_roca');window._rm={tipo,chave:novaChave(),itens:[],est};
  const locs=locaisRoca().filter(l=>l.tipo!=='full');const sp=locs.find(l=>/são paulo/i.test(l.nome));const cba=locs.find(l=>l!==sp);
  const origem0=tipo==='full'?(sp||cba):cba;
  abrir(`<h2>${tipo==='full'?'Criar remessa para o Full':'Criar remessa para São Paulo'}</h2><div class="sub">${tipo==='full'?'Envio para o Full do Mercado Livre. Se a mercadoria passou por São Paulo, a origem é São Paulo.':'Transferência entre locais da Roca.'} O sistema bloqueia quantidades acima do disponível.</div>
   <div class="c3"><div class="campo"><label>Origem</label><select id="rm_o">${opcoes(locs,(origem0||{}).id,null)}</select></div>
   ${tipo==='full'?`<div class="campo"><label>Conta do Mercado Livre *</label><select id="rm_c">${opcoes(contasRoca(),'','Escolha a conta',x=>x.id,x=>x.apelido)}</select></div>`
     :`<div class="campo"><label>Destino</label><select id="rm_d">${opcoes(locs,(sp||{}).id,null)}</select></div>`}
   <div class="campo"><label>Data</label><input id="rm_dt" type="date" value="${hojeISO()}"></div></div>
   <div class="c3">${tipo==='full'?`<div class="campo"><label>ID do envio (inbound)</label><input id="rm_env"></div><div class="campo"><label>Centro de destino</label><input id="rm_cd" placeholder="ex.: SP02"></div>`
     :`<div class="campo"><label>Conta atendida (opcional)</label><select id="rm_c">${opcoes(contasRoca(),'','—',x=>x.id,x=>x.apelido)}</select></div>`}
   <div class="campo"><label>Produto</label>${campoProduto('rm_p')}</div></div>
   <div id="rm_it"></div><div class="erro"></div><div class="rodape"><button onclick="fechar()">Cancelar</button><button class="pri" id="rm_ok">Criar remessa</button></div>`,true);
  const disp=pid=>{const o=+val('rm_o');const x=window._rm.est.find(e=>e.produto_id===pid&&e.local_id===o);return x?+x.disponivel:0;};
  const desenhar=()=>{$('rm_it').innerHTML=window._rm.itens.length?`<table class="t"><thead><tr><th>Produto</th><th class="n">Disponível na origem</th><th class="n">Quantidade</th><th></th></tr></thead><tbody>${window._rm.itens.map((i,k)=>{const d=disp(i.produto_id);return `<tr><td>${esc((produto(i.produto_id).sku||'')+' · '+nomeProd(i.produto_id))}</td><td class="n">${nfq(d)}</td>
     <td class="n"><input style="width:80px;text-align:right;${i.qtd>d?'border-color:var(--red)':''}" value="${i.qtd}" inputmode="numeric" onchange="_rm.itens[${k}].qtd=num(this.value)||0;_rm_desenhar()"></td><td><button class="lk sm" onclick="_rm.itens.splice(${k},1);_rm_desenhar()">remover</button></td></tr>`;}).join('')}</tbody></table>`:'<div class="vazio">Adicione os produtos.</div>';};
  window._rm_desenhar=desenhar;desenhar();$('rm_o').onchange=desenhar;
  const add=()=>{const p=acharProduto(val('rm_p'));if(!p){if(val('rm_p'))toast('Produto não encontrado.');return;}if(!window._rm.itens.find(i=>i.produto_id===p.id))window._rm.itens.push({produto_id:p.id,qtd:1});$('rm_p').value='';desenhar();};
  $('rm_p').onchange=add;$('rm_p').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();add();}};
  $('rm_ok').onclick=()=>rodar($('rm_ok'),async()=>{const it=window._rm.itens;
    if(!it.length)throw new Error('Inclua ao menos um produto.');
    if(tipo==='full'&&!val('rm_c'))throw new Error('Escolha a conta do Mercado Livre.');
    if(tipo==='sp'&&val('rm_o')===val('rm_d'))throw new Error('Origem e destino iguais.');
    const acima=it.find(i=>i.qtd>disp(i.produto_id));if(acima)throw new Error('Quantidade acima do disponível: '+nomeProd(acima.produto_id));
    if(it.some(i=>!(i.qtd>0)))throw new Error('Quantidade inválida.');
    const id=await rpc('fl_remessa_criar',{p:{tipo,origem_id:+val('rm_o'),destino_id:tipo==='sp'?+val('rm_d'):null,ml_conta_id:val('rm_c')?+val('rm_c'):null,
      envio_id:tipo==='full'?val('rm_env'):null,centro_destino:tipo==='full'?val('rm_cd'):null,data:val('rm_dt'),chave:window._rm.chave,itens:it}});
    await carregarRef();fechar();toast('Remessa criada.');abaRoca='remessas';await ir('roca');abrirRemessa(id);});
}
async function abrirRemessa(id){
  const r=await q(sb.from('fl_remessas').select('*,fl_remessa_itens(*),fl_remessa_hist(*)').eq('id',id).single());
  const pend=i=>i.qtd-(i.qtd_recebida||0)-i.qtd_conferida_depois-i.qtd_perda;
  const acoes=[];
  if(r.status==='aberta')acoes.push(`<button class="pri" data-a="separar">Confirmar separação</button>`);
  if(r.status==='aberta'||r.status==='separada')acoes.push(`<button class="pri" data-a="saida">Confirmar saída</button>`,`<button class="perigo" data-a="cancelar">Cancelar remessa</button>`);
  if(r.status==='em_transito')acoes.push(`<button class="pri" data-a="receber">Confirmar recebimento</button>`);
  if(r.status==='divergente')acoes.push(`<button class="pri" data-a="conferir">Registrar conferência</button>`);
  abrir(`<h2>Remessa ${esc(r.numero)} · ${r.tipo==='full'?'Full':'São Paulo'} <span class="tag ${ST_REM[r.status][1]}">${ST_REM[r.status][0]}</span></h2>
   <div class="sub">${esc(local(r.origem_id).nome)} → ${esc(local(r.destino_id).nome)} · ${r.ml_conta_id?'Conta '+esc(contaML(r.ml_conta_id).apelido)+' · ':''}${fd(r.data)} · responsável ${esc(r.responsavel_nome||'')}${r.envio_id?' · envio '+esc(r.envio_id):''}${r.centro_destino?' · centro '+esc(r.centro_destino):''}</div>
   ${tabela([{t:'Produto',v:i=>(produto(i.produto_id)?.sku||'')+' · '+nomeProd(i.produto_id)},{t:'Enviado',v:i=>+i.qtd,n:1,fmt:nfq},{t:'Recebido',v:i=>i.qtd_recebida==null?null:+i.qtd_recebida,n:1,fmt:nfq},
     {t:'Achado depois',v:i=>+i.qtd_conferida_depois,n:1,fmt:nfq},{t:'Perda',v:i=>+i.qtd_perda,n:1,fmt:nfq},{t:'Pendente conf.',v:i=>i.qtd_recebida==null?0:pend(i),n:1,fmt:nfq},
     ...(r.status==='em_transito'?[{t:'Chegou',v:()=>'',h:i=>`<input class="rr_q" data-i="${i.id}" data-max="${i.qtd}" value="${i.qtd}" style="width:80px;text-align:right" inputmode="numeric">`}]:[]),
     ...(r.status==='divergente'?[{t:'Encontrado',v:()=>'',h:i=>pend(i)>0?`<input class="rc_e" data-i="${i.id}" style="width:70px;text-align:right" inputmode="numeric" placeholder="0">`:''},{t:'Perda',v:()=>'',h:i=>pend(i)>0?`<input class="rc_p" data-i="${i.id}" style="width:70px;text-align:right" inputmode="numeric" placeholder="0">`:''}]:[])],r.fl_remessa_itens,{rolar:false})}
   ${r.status==='divergente'?'<div class="campo"><label>Observação da conferência</label><input id="rc_obs"></div>':''}
   <h3 style="font-size:14px">Histórico</h3>${tabela([{t:'Quando',v:h=>fdh(h.em)},{t:'Evento',v:h=>h.evento},{t:'Detalhe',v:h=>h.detalhe||''},{t:'Usuário',v:h=>h.usuario||''}],(r.fl_remessa_hist||[]).sort((a,b)=>a.id-b.id),{rolar:false})}
   <div class="erro"></div><div class="rodape"><button onclick="fechar()">Fechar</button>${acoes.join('')}</div>`,true);
  document.querySelectorAll('#modal [data-a]').forEach(b=>b.onclick=()=>rodar(b,async()=>{const a=b.dataset.a;
    document.querySelectorAll('#modal [data-a]').forEach(x=>x.disabled=true);
    try{
      if(a==='separar')await rpc('fl_remessa_separar',{p_rem:id});
      if(a==='saida')await rpc('fl_remessa_saida',{p_rem:id});
      if(a==='cancelar'){const m=prompt('Motivo do cancelamento:');if(!m)return;await rpc('fl_remessa_cancelar',{p_rem:id,p_motivo:m});}
      if(a==='receber'){const it=[...document.querySelectorAll('.rr_q')].map(x=>({item_id:+x.dataset.i,qtd:num(x.value)}));
        if(it.some(x=>isNaN(x.qtd)||x.qtd<0))throw new Error('Quantidade recebida inválida.');
        const st=await rpc('fl_remessa_receber',{p_rem:id,p_itens:it});if(st==='divergente')toast('Recebido com divergência: o que faltou ficou pendente de conferência.',6000);}
      if(a==='conferir'){for(const e of document.querySelectorAll('.rc_e')){const enc=num(e.value)||0,per=num(document.querySelector(`.rc_p[data-i="${e.dataset.i}"]`).value)||0;
        if(enc||per)await rpc('fl_remessa_conferir',{p_item:+e.dataset.i,p_encontrado:enc,p_perda:per,p_obs:val('rc_obs')||null});}}
    }finally{document.querySelectorAll('#modal [data-a]').forEach(x=>x.disabled=false);}
    toast('Remessa atualizada.');if(area==='roca'){abaRoca='remessas';await ir('roca');}abrirRemessa(id);}));
}

// ---------------------------------------------------------------- FL Adega: PDV
const FORMAS_PDV={pix:'Pix',dinheiro:'Dinheiro',debito:'Débito',credito:'Crédito'};
const PDV={itens:[],chave:null,forma:'pix',prods:[],loja:null,pendente:null};
TELAS.pdv=async function(){
  const loja=lojaAdega();if(!loja){$('conteudo').innerHTML='<div class="aviso">Loja da FL Adega não cadastrada.</div>';return;}
  PDV.loja=loja.id;PDV.prods=await rpc('fl_pdv_produtos',{p_local:loja.id});if(!PDV.chave)PDV.chave=novaChave();
  const podeDesc=master()||pf().pode_desconto;
  $('conteudo').innerHTML=`<div class="pdv"><div class="secao"><h2>Venda no balcão <small>${esc(loja.nome)} · operador ${esc(pf().nome||pf().email)}</small></h2>
    <div class="campo"><label>Buscar vinho (nome, SKU ou código de barras) — Enter adiciona</label><input id="pv_b" autocomplete="off" placeholder="Bipe ou digite"></div>
    <div id="pv_res"></div><div id="pv_itens"></div>
    <div class="c2" style="margin-top:10px"><div class="campo"><label>Desconto (R$)${podeDesc?'':' — sem permissão'}</label><input id="pv_desc" inputmode="decimal" value="0" ${podeDesc?'':'disabled'}></div>
     <div class="campo"><label>Cliente (opcional)</label><input id="pv_cli"></div></div>
    <div class="campo"><label>Forma de pagamento</label><div class="formas">${Object.entries(FORMAS_PDV).map(([k,n])=>`<button data-f="${k}" class="${PDV.forma===k?'on':''}">${n}</button>`).join('')}</div></div>
    <div id="pv_din" class="c2"></div>
    <div id="pv_tot" class="pdv-total"></div><div class="erro" id="pv_e"></div>
    <div class="rodape"><button onclick="PDV.itens=[];PDV.chave=novaChave();desenharPDV()">Limpar</button><button class="pri" id="pv_ok" style="min-width:190px;padding:12px">Confirmar venda</button></div></div>
   <div class="secao"><h2>Minhas vendas de hoje <small><button class="lk" onclick="ir('fechamento')">Fechamento de caixa →</button></small></h2><div id="pv_hoje">Carregando…</div></div></div>`;
  const busca=$('pv_b');
  const achar=t=>{const tt=norm(t),dig=t.replace(/\D/g,'');return PDV.prods.filter(p=>(dig.length>=8&&p.ean===dig)||(p.sku&&p.sku.toUpperCase()===t.toUpperCase().trim())||norm(p.nome+' '+(p.sku||'')).includes(tt)).slice(0,8);};
  busca.oninput=()=>{const t=busca.value.trim();if(!t){$('pv_res').innerHTML='';return;}const r=achar(t);
    $('pv_res').innerHTML=r.length?`<div class="lista-res">${r.map(p=>`<button data-p="${p.produto_id}"><span>${esc(p.nome)} <small class="mut">${esc(p.sku||'')}${p.safra?' · '+p.safra:''}</small></span><span>${p.preco!=null?brl(+p.preco):'<span class="tag r">sem preço</span>'} · <b>${nf(+p.disponivel)}</b> em Cuiabá</span></button>`).join('')}</div>`:'<div class="mut peq">Nada encontrado.</div>';
    $('pv_res').querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>{addPDV(b.dataset.p);busca.value='';$('pv_res').innerHTML='';busca.focus();});};
  busca.onkeydown=e=>{if(e.key!=='Enter')return;e.preventDefault();const r=achar(busca.value.trim());if(r.length){addPDV(r[0].produto_id);busca.value='';$('pv_res').innerHTML='';}};
  document.querySelectorAll('.formas [data-f]').forEach(b=>b.onclick=()=>{PDV.forma=b.dataset.f;document.querySelectorAll('.formas [data-f]').forEach(x=>x.classList.toggle('on',x===b));desenharPDV();});
  $('pv_desc').oninput=desenharPDV;
  $('pv_ok').onclick=confirmarPDV;
  desenharPDV();busca.focus();carregarHojePDV();
};
function addPDV(pid){const p=PDV.prods.find(x=>x.produto_id===pid);if(!p)return;if(p.preco==null){$('pv_e').textContent='Produto sem preço de venda cadastrado.';return;}
  const ex=PDV.itens.find(i=>i.produto_id===pid);const q=(ex?ex.qtd:0)+1;
  if(q>+p.disponivel){$('pv_e').textContent=`Só há ${nf(+p.disponivel)} unidade(s) de ${p.nome} em Cuiabá.`;return;}
  $('pv_e').textContent='';if(ex)ex.qtd=q;else PDV.itens.push({produto_id:pid,qtd:1});desenharPDV();}
function totalPDV(){const b=soma(PDV.itens,i=>i.qtd*(+PDV.prods.find(p=>p.produto_id===i.produto_id).preco));const d=num(val('pv_desc'))||0;return {bruto:b,desconto:d,total:Math.round((b-d)*100)/100};}
function desenharPDV(){
  if(!$('pv_itens'))return;
  $('pv_itens').innerHTML=PDV.itens.length?`<table class="t"><thead><tr><th>Vinho</th><th class="n">Preço</th><th class="n">Qtd</th><th class="n">Total</th><th></th></tr></thead><tbody>${PDV.itens.map((i,k)=>{const p=PDV.prods.find(x=>x.produto_id===i.produto_id);return `<tr><td>${esc(p.nome)} <span class="mut peq">${esc(p.sku||'')} · ${nf(+p.disponivel)} disp.</span></td><td class="n">${brl(+p.preco)}</td>
    <td class="n"><button class="sm" onclick="qtdPDV(${k},-1)">−</button> <b style="display:inline-block;min-width:26px;text-align:center">${i.qtd}</b> <button class="sm" onclick="qtdPDV(${k},1)">+</button></td><td class="n">${brl(i.qtd*p.preco)}</td><td><button class="lk sm" onclick="PDV.itens.splice(${k},1);desenharPDV()">remover</button></td></tr>`;}).join('')}</tbody></table>`:'<div class="vazio">Nenhum item. Bipe ou busque um vinho.</div>';
  const t=totalPDV();
  $('pv_din').innerHTML=PDV.forma==='dinheiro'?`<div class="campo"><label>Valor recebido (R$)</label><input id="pv_rec" inputmode="decimal" value="${PDV.recebido??''}"></div><div class="campo"><label>Troco</label><div id="pv_troco" class="pdv-troco">—</div></div>`:'';
  const tr=()=>{const r=num(val('pv_rec'));PDV.recebido=val('pv_rec');$('pv_troco').innerHTML=isNaN(r)?'—':(r<t.total?`<span style="color:var(--red)">Falta ${brl(t.total-r)}</span>`:brl(r-t.total));};
  if($('pv_rec')){$('pv_rec').oninput=tr;tr();}
  $('pv_tot').innerHTML=`<span>Total${t.desconto?` <small class="mut">(${brl(t.bruto)} − desconto ${brl(t.desconto)})</small>`:''}</span><b>${brl(t.total)}</b>`;
  if(PDV.pendente)$('pv_e').innerHTML=`A confirmação anterior não foi concluída (${esc(PDV.pendente)}). Clique em <b>Confirmar venda</b> para tentar de novo — a venda não será duplicada.`;
}
function qtdPDV(k,d){const i=PDV.itens[k],p=PDV.prods.find(x=>x.produto_id===i.produto_id);const q=i.qtd+d;if(q<1)return;if(q>+p.disponivel){$('pv_e').textContent=`Só há ${nf(+p.disponivel)} unidade(s) em Cuiabá.`;return;}i.qtd=q;desenharPDV();}
async function confirmarPDV(){
  const b=$('pv_ok');if(b.disabled)return;b.disabled=true;$('pv_e').textContent='';
  try{const t=totalPDV();if(!PDV.itens.length)throw new Error('Inclua ao menos um vinho.');
    if(t.desconto<0||t.total<0)throw new Error('Desconto inválido.');
    let rec=null;if(PDV.forma==='dinheiro'){rec=num(val('pv_rec'));if(isNaN(rec)||rec<t.total)throw new Error('Informe o valor recebido (no mínimo '+brl(t.total)+').');}
    const r=await rpc('fl_pdv_vender',{p:{chave:PDV.chave,local_id:PDV.loja,forma_pagamento:PDV.forma,valor_recebido:rec,desconto:t.desconto,cliente:val('pv_cli'),itens:PDV.itens}});
    PDV.itens=[];PDV.chave=novaChave();PDV.recebido='';PDV.pendente=null;
    mostrarResumoPDV(r);TELAS.pdv();
  }catch(e){const m=msgErro(e);
    if(/conexão|Failed|network|fetch|timeout/i.test(m)){PDV.pendente=m;desenharPDV();}else{$('pv_e').textContent=m;}
  }finally{b.disabled=false;}
}
function mostrarResumoPDV(r,depois){
  abrir(`<div id="cupom"><h2>Venda ${esc(r.numero)} ${r.status==='cancelada'?'<span class="tag r">cancelada</span>':'<span class="tag v">concluída</span>'}</h2>
   <div class="sub">${fdh(r.data)} · operador ${esc(r.operador||'')} · FL Adega — Cuiabá</div>
   ${tabela([{t:'Item',v:i=>i.descricao},{t:'Qtd',v:i=>+i.qtd,n:1,fmt:nf},{t:'Preço',v:i=>+i.preco,n:1},{t:'Total',v:i=>+i.total,n:1}],r.itens||[],{rolar:false})}
   <div class="pdv-total"><span>Total${+r.desconto?` <small class="mut">(desconto ${brl(+r.desconto)})</small>`:''}</span><b>${brl(+r.total)}</b></div>
   <div>Pagamento: <b>${FORMAS_PDV[r.forma_pagamento]||r.forma_pagamento}</b>${r.forma_pagamento==='dinheiro'?` · recebido ${brl(+r.valor_recebido)} · <b>troco ${brl(+r.troco)}</b>`:''}</div>
   ${r.motivo_cancelamento?`<div class="aviso" style="margin-top:8px">Cancelada: ${esc(r.motivo_cancelamento)}</div>`:''}</div>
   <div class="erro"></div><div class="rodape"><button onclick="window.print()">Imprimir</button>${r.status!=='cancelada'&&(master()||pf().pode_cancelar)?`<button class="perigo" onclick="cancelarPDV(${r.id})">Cancelar venda</button>`:''}<button class="pri" onclick="fechar();${depois||''}">${depois?'Fechar':'Nova venda'}</button></div>`);
}
async function carregarHojePDV(){
  const h=hojeISO();let r;try{r=await rpc('fl_pdv_fechamento',{p_de:tsIni(h),p_ate:tsFim(h),p_local:PDV.loja,p_todos:false});}catch(e){$('pv_hoje').innerHTML=`<div class="erro">${esc(msgErro(e))}</div>`;return;}
  $('pv_hoje').innerHTML=`<div class="kpis">${r.por_forma.map(f=>`<div class="kpi"><div class="l">${FORMAS_PDV[f.forma]||f.forma}</div><div class="v">${brl(+f.total)}</div><div class="s">${f.vendas} venda(s)</div></div>`).join('')}
    <div class="kpi"><div class="l">Total</div><div class="v">${brl(+r.total)}</div><div class="s">${r.qtd_vendas} venda(s)${r.canceladas?' · '+r.canceladas+' cancelada(s)':''}</div></div></div>`+
    tabela([{t:'Hora',v:v=>fdh(v.data).slice(-5)},{t:'Venda',v:v=>v.numero},{t:'Pagamento',v:v=>FORMAS_PDV[v.forma]||v.forma},{t:'Total',v:v=>+v.total,n:1},{t:'',v:v=>v.status,h:v=>v.status==='cancelada'?'<span class="tag r">cancelada</span>':''}],r.vendas,{rolar:false,vazio:'Nenhuma venda hoje.',clique:async v=>mostrarResumoPDV(await rpc('fl_pdv_resumo',{p_venda:v.id}),"ir(area)")});
}
function cancelarPDV(id){abrir(`<h2>Cancelar venda</h2><div class="sub">O estoque volta para a loja e o pagamento é estornado. Informe o motivo.</div><div class="campo"><label>Motivo *</label><input id="cn_m"></div><div class="erro"></div>
  <div class="rodape"><button onclick="fechar()">Voltar</button><button class="perigo" id="cn_ok">Confirmar cancelamento</button></div>`);
  $('cn_ok').onclick=()=>rodar($('cn_ok'),async()=>{if(!val('cn_m'))throw new Error('Informe o motivo.');const r=await rpc('fl_pdv_cancelar',{p_venda:id,p_motivo:val('cn_m')});toast('Venda cancelada.');mostrarResumoPDV(r,"ir(area)");if(area==='pdv'||area==='fechamento')ir(area);});}

// ---------------------------------------------------------------- FL Adega: fechamento de caixa
const FC={de:null,ate:null,todos:false};
TELAS.fechamento=async function(){
  const h=hojeISO();FC.de=FC.de||h;FC.ate=FC.ate||h;const loja=lojaAdega();
  const podeTodos=master()||podeFin('adega');if(!podePDV())FC.todos=true;
  const r=await rpc('fl_pdv_fechamento',{p_de:tsIni(FC.de),p_ate:tsFim(FC.ate),p_local:loja?loja.id:null,p_todos:podeTodos&&FC.todos});
  $('conteudo').innerHTML=`<div class="filtros"><div><label>De</label><input type="date" id="fc_de" value="${FC.de}"></div><div><label>Até</label><input type="date" id="fc_ate" value="${FC.ate}"></div>
    ${podeTodos?`<div><label>Operadores</label><select id="fc_t"><option value="0" ${FC.todos?'':'selected'}>Só o meu caixa</option><option value="1" ${FC.todos?'selected':''}>Todos</option></select></div>`:''}
    <div class="btn"><button onclick="window.print()">Imprimir</button></div></div>
   <div class="secao" id="fech"><h2>Fechamento de caixa — FL Adega Cuiabá <small>${fd(FC.de)} a ${fd(FC.ate)} · ${r.escopo==='todos'?'todos os operadores':'caixa de '+esc(pf().nome||pf().email)}</small></h2>
    <div class="kpis">${Object.keys(FORMAS_PDV).map(k=>{const f=r.por_forma.find(x=>x.forma===k)||{total:0,vendas:0};return `<div class="kpi"><div class="l">${FORMAS_PDV[k]}</div><div class="v">${brl(+f.total)}</div><div class="s">${f.vendas} venda(s)</div></div>`;}).join('')}
     <div class="kpi"><div class="l">Total do período</div><div class="v">${brl(+r.total)}</div><div class="s">${r.qtd_vendas} venda(s) · ${r.canceladas} cancelada(s)</div></div></div>
    <div class="mut peq" style="margin-bottom:10px">Dinheiro: recebido ${brl(+r.dinheiro_recebido)} − troco ${brl(+r.troco_dado)} = <b>${brl(r.dinheiro_recebido-r.troco_dado)}</b> na gaveta.</div>
    ${tabela([{t:'Data',v:v=>fdh(v.data)},{t:'Venda',v:v=>v.numero},{t:'Operador',v:v=>v.operador||''},{t:'Pagamento',v:v=>FORMAS_PDV[v.forma]||v.forma},{t:'Total',v:v=>v.status==='cancelada'?0:+v.total,n:1,tot:1},
      {t:'Situação',v:v=>v.status,h:v=>v.status==='cancelada'?`<span class="tag r">cancelada</span> <span class="mut peq">${esc(v.motivo||'')}</span>`:'<span class="tag v">ok</span>'}],r.vendas,{clique:async v=>mostrarResumoPDV(await rpc('fl_pdv_resumo',{p_venda:v.id}),"ir('fechamento')"),vazio:'Nenhuma venda no período.'})}</div>`;
  $('fc_de').onchange=()=>{FC.de=val('fc_de');ir('fechamento');};$('fc_ate').onchange=()=>{FC.ate=val('fc_ate');ir('fechamento');};
  if($('fc_t'))$('fc_t').onchange=()=>{FC.todos=val('fc_t')==='1';ir('fechamento');};
};

// ---------------------------------------------------------------- Conciliação
let abaConc='vendas';const FCo={de:null,ate:null,conta:'',produto:'',contaFin:''};
TELAS.conc=async function(extra){
  await rpc('fl_exige_fin');   // bloqueio no servidor
  if(['vendas','extrato','conferencia','ganho','arquivos'].includes(extra))abaConc=extra;
  if(!FCo.de){FCo.de=inicioMes(hojeISO());FCo.ate=hojeISO();}
  REF.contasFin=await q(sb.from('fl_contas_fin').select('*').order('nome'));
  const ab=`<div class="abas2">${[['vendas','Importar arquivo de vendas'],['extrato','Importar extrato bancário'],['conferencia','Conferência dos repasses'],['ganho','Ganho e margem'],['arquivos','Arquivos importados']].map(([k,n])=>`<button class="${abaConc===k?'on':''}" onclick="abaConc='${k}';ir('conc')">${n}</button>`).join('')}
    <button class="sm" style="margin-left:auto" onclick="ir('vendas')">Histórico de vendas</button></div>`;
  if(abaConc==='vendas')return telaImportar(ab,'vendas');
  if(abaConc==='extrato')return telaImportar(ab,'extrato');
  if(abaConc==='conferencia')return telaConferencia(ab);
  if(abaConc==='ganho')return telaGanho(ab);
  if(abaConc==='arquivos')return telaArquivos(ab);
};
const contasMLFin=()=>REF.contasML.filter(c=>podeFin(empresa(c.empresa_id).operacao));
const contasBancoFin=()=>REF.contasFin.filter(c=>podeFin(empresa(c.empresa_id).operacao));
const IMP={};
function telaImportar(ab,tipo){
  const vendas=tipo==='vendas';
  $('conteudo').innerHTML=ab+`<div class="secao"><h2>${vendas?'Importar arquivo de vendas':'Importar extrato bancário'} <small>${vendas?'relatório de vendas do Mercado Livre em CSV ou XLSX':'extrato em CSV ou OFX'}</small></h2>
   <div class="c3"><div class="campo"><label>${vendas?'Conta do Mercado Livre *':'Conta bancária *'}</label><select id="im_c">${vendas?opcoes(contasMLFin(),'','Escolha a conta',x=>x.id,x=>x.apelido+' · '+empresa(x.empresa_id).nome):opcoes(contasBancoFin(),'','Escolha a conta',x=>x.id,x=>x.nome+' · '+empresa(x.empresa_id).nome)}</select>
     ${!vendas&&master()?'<button class="lk sm" onclick="novaContaBanco()">+ nova conta bancária</button>':''}</div>
    <div class="campo" style="grid-column:span 2"><label>Arquivo</label><div class="drop" id="im_drop">Arraste o arquivo aqui ou <button class="lk" onclick="$('im_f').click()">escolha no computador</button><input type="file" id="im_f" accept="${vendas?'.csv,.xlsx,.xls':'.csv,.ofx,.txt'}" style="display:none"></div></div></div>
   <div id="im_area"></div></div>
   <div class="info">Reimportar o mesmo arquivo ou um período que se sobrepõe não duplica nada: ${vendas?'cada venda é identificada pelo nº da venda':'cada lançamento é identificado pelo ID do banco (OFX) ou pela linha'}. O arquivo original fica guardado com data e responsável.</div>`;
  const f=$('im_f'),d=$('im_drop');
  f.onchange=()=>f.files[0]&&lerArquivo(f.files[0],tipo);
  d.ondragover=e=>{e.preventDefault();d.classList.add('on');};d.ondragleave=()=>d.classList.remove('on');
  d.ondrop=e=>{e.preventDefault();d.classList.remove('on');if(e.dataTransfer.files[0])lerArquivo(e.dataTransfer.files[0],tipo);};
}
function novaContaBanco(){abrir(`<h2>Nova conta bancária</h2><div class="c2"><div class="campo"><label>Nome</label><input id="nb_n" placeholder="ex.: Itaú Roca"></div><div class="campo"><label>Empresa</label><select id="nb_e">${opcoes(REF.empresas,'',null)}</select></div></div><div class="erro"></div>
  <div class="rodape"><button onclick="fechar()">Cancelar</button><button class="pri" id="nb_ok">Salvar</button></div>`);
  $('nb_ok').onclick=()=>rodar($('nb_ok'),async()=>{if(!val('nb_n'))throw new Error('Informe o nome.');await q(sb.from('fl_contas_fin').insert({nome:val('nb_n'),empresa_id:+val('nb_e'),tipo:'banco'}));fechar();ir('conc');});}
async function sha256(buf){const h=await crypto.subtle.digest('SHA-256',buf);return [...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function lerArquivo(file,tipo){
  const area=$('im_area');area.innerHTML='Lendo…';
  try{
    const buf=await file.arrayBuffer();const ext=file.name.split('.').pop().toLowerCase();
    IMP.file=file;IMP.buf=buf;IMP.tipo=tipo;IMP.sha=await sha256(buf);IMP.ext=ext;
    if(tipo==='extrato'&&(ext==='ofx'||/<OFX>/i.test(new TextDecoder('latin1').decode(buf.slice(0,4000))))){
      IMP.formato='ofx';const txt=new TextDecoder(/utf-?8/i.test(new TextDecoder('latin1').decode(buf.slice(0,500)))?'utf-8':'latin1').decode(buf);
      const r=ConcLogic.lerOFX(txt);IMP.resultado=r;return previaImport();
    }
    IMP.formato=ext==='csv'||ext==='txt'?'csv':'xlsx';
    let wb;if(IMP.formato==='csv'){let txt=new TextDecoder('utf-8').decode(buf);if(txt.includes('�'))txt=new TextDecoder('latin1').decode(buf);
      const sep=(txt.split('\n')[0].match(/;/g)||[]).length>=(txt.split('\n')[0].match(/,/g)||[]).length?';':',';wb=XLSX.read(txt,{type:'string',FS:sep,raw:true});}
    else wb=XLSX.read(buf,{type:'array',cellDates:true});
    const ws=wb.Sheets[wb.SheetNames[0]];IMP.aoa=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null});
    const campos=tipo==='vendas'?ConcLogic.CAMPOS_VENDA:ConcLogic.CAMPOS_EXTRATO;
    IMP.cab=ConcLogic.acharCabecalho(IMP.aoa,campos);IMP.map=ConcLogic.mapearColunas(IMP.aoa[IMP.cab]||[],campos);
    mapeamentoImport();
  }catch(e){console.error(e);area.innerHTML=`<div class="erro">Não foi possível ler o arquivo: ${esc(e.message||e)}</div>`;}
}
function mapeamentoImport(){
  const campos=IMP.tipo==='vendas'?ConcLogic.CAMPOS_VENDA:ConcLogic.CAMPOS_EXTRATO;const cab=(IMP.aoa[IMP.cab]||[]).map((c,i)=>({id:i,nome:(c==null||c===''?'(coluna '+(i+1)+')':String(c))}));
  $('im_area').innerHTML=`<h3 style="font-size:14px">Colunas do arquivo <small class="mut">confira e ajuste o que cada coluna representa</small></h3>
   <div class="c3">${Object.entries(campos).map(([k,c])=>`<div class="campo"><label>${esc(c.t)}${c.obr?' *':''}</label><select data-m="${k}">${opcoes(cab,IMP.map[k]??'','— não usar —')}</select></div>`).join('')}</div>
   <div class="c3"><div class="campo"><label>Linha do cabeçalho</label><input id="im_cab" type="number" min="1" value="${IMP.cab+1}"></div></div>
   <div class="rodape" style="justify-content:flex-start"><button class="pri" id="im_prev">Ver prévia</button></div><div id="im_prev_area"></div>`;
  document.querySelectorAll('[data-m]').forEach(s=>s.onchange=()=>{IMP.map[s.dataset.m]=s.value===''?undefined:+s.value;});
  $('im_cab').onchange=()=>{IMP.cab=Math.max(0,(+$('im_cab').value||1)-1);IMP.map=ConcLogic.mapearColunas(IMP.aoa[IMP.cab]||[],campos);mapeamentoImport();};
  $('im_prev').onclick=()=>{const falta=Object.entries(campos).filter(([k,c])=>c.obr&&IMP.map[k]==null).map(([,c])=>c.t);
    if(falta.length){$('im_prev_area').innerHTML=`<div class="erro">Indique a coluna de: ${esc(falta.join(', '))}</div>`;return;}
    const linhas=IMP.aoa.slice(IMP.cab+1);
    IMP.resultado=IMP.tipo==='vendas'?ConcLogic.lerVendas(linhas,IMP.map,IMP.cab+2):ConcLogic.lerExtratoPlanilha(linhas,IMP.map,IMP.cab+2);
    previaImport();};
}
async function previaImport(){
  const r=IMP.resultado,vendas=IMP.tipo==='vendas';const el=$('im_prev_area')||$('im_area');
  const ja=await q(sb.from('fl_imp_arquivos').select('nome,importado_em,importado_por_nome').eq('sha256',IMP.sha).limit(1));
  const lista=vendas?r.vendas:r.linhas;
  el.innerHTML=`<h3 style="font-size:14px">Prévia <small class="mut">${lista.length} ${vendas?'venda(s)':'lançamento(s)'} válidos · ${r.erros.length} linha(s) com erro</small></h3>
   ${ja.length?`<div class="aviso">Este mesmo arquivo já foi importado em ${fdh(ja[0].importado_em)} por ${esc(ja[0].importado_por_nome||'')}. Importar de novo não duplica nada; só atualiza o que mudou.</div>`:''}
   ${r.erros.length?`<div class="aviso"><b>Linhas com erro (não serão importadas):</b><br>${r.erros.slice(0,50).map(e=>`Linha ${e.linha}: ${esc(e.motivo)}`).join('<br>')}${r.erros.length>50?'<br>…':''}</div>`:''}
   ${vendas?tabela([{t:'Venda',v:v=>v.pedido},{t:'Data',v:v=>fdh(v.data)},{t:'Status',v:v=>v.status},{t:'Itens',v:v=>v.itens.map(i=>nf(i.qtd)+'× '+(i.sku||i.descricao)).join(', ')},
      {t:'Vendido',v:v=>v.bruto,n:1,tot:1},{t:'Cancel./reemb.',v:v=>v.cancelado,n:1,tot:1},{t:'Tarifa',v:v=>v.tarifa,n:1,tot:1},{t:'Frete',v:v=>v.frete,n:1,tot:1},{t:'Previsto p/ repasse',v:v=>v.liquido,n:1,tot:1},{t:'Linhas',v:v=>v.linhas.join(', ')}],lista,{limite:200})
     :tabela([{t:'Data',v:l=>fd(l.data)},{t:'Descrição',v:l=>l.descricao},{t:'Documento',v:l=>l.ref||''},{t:'Valor',v:l=>l.valor,n:1,tot:1,h:l=>`<span style="color:${l.valor<0?'var(--red)':'var(--grn)'}">${brl(l.valor)}</span>`}],lista,{limite:200})}
   <div class="erro" id="im_e"></div><div class="rodape" style="justify-content:flex-start"><button class="pri" id="im_ok" ${lista.length?'':'disabled'}>Confirmar importação</button></div>`;
  $('im_ok').onclick=async()=>{const b=$('im_ok');b.disabled=true;$('im_e').textContent='';
    try{const conta=+val('im_c');if(!conta)throw new Error(vendas?'Escolha a conta do Mercado Livre.':'Escolha a conta bancária.');
      let caminho=null;try{const pth=`importacoes/${IMP.sha.slice(0,16)}-${IMP.file.name.replace(/[^\w.\-]/g,'_')}`;const up=await sb.storage.from('fl-docs').upload(pth,new Blob([IMP.buf]),{upsert:true});if(!up.error)caminho=pth;}catch(e){}
      const aid=await rpc('fl_imp_registrar',{p:{tipo:IMP.tipo,ml_conta_id:vendas?conta:null,conta_fin_id:vendas?null:conta,nome:IMP.file.name,sha256:IMP.sha,caminho,formato:IMP.formato,linhas:lista.length}});
      let tot={novos:0,atualizados:0,iguais:0};
      for(let i=0;i<lista.length;i+=150){const lote=lista.slice(i,i+150);
        const r=vendas?await rpc('fl_importar_vendas',{p_arquivo:aid,p_conta:conta,p_vendas:lote.map(({linhas,...v})=>v)}):await rpc('fl_importar_extrato',{p_arquivo:aid,p_conta_fin:conta,p_linhas:lote});
        tot.novos+=r.novos||0;tot.atualizados+=r.atualizados||0;tot.iguais+=r.iguais||0;b.textContent=`Gravando… ${Math.min(i+150,lista.length)}/${lista.length}`;}
      if(vendas)await sb.from('fl_imp_arquivos').update({}).eq('id',aid);
      el.innerHTML=`<div class="info"><b>Importação concluída.</b> Novos: ${tot.novos} · atualizados: ${tot.atualizados} · já existentes (não duplicados): ${tot.iguais} · linhas com erro: ${r.erros.length}.${caminho?'':' <span class="mut">(Arquivo original não pôde ser guardado no armazenamento.)</span>'}</div>
       <div class="rodape" style="justify-content:flex-start"><button class="pri" onclick="abaConc='conferencia';ir('conc')">Ir para a conferência dos repasses</button></div>`;
    }catch(e){$('im_e').textContent=msgErro(e);b.disabled=false;b.textContent='Confirmar importação';}};
}
// --- conferência
async function telaConferencia(ab){
  const cBanco=FCo.contaFin||(contasBancoFin()[0]||{}).id||'';FCo.contaFin=cBanco;
  const [ext,concs,vendas]=await Promise.all([
    tudo(()=>sb.from('fl_extrato').select('*').eq('conta_fin_id',cBanco||0).order('data',{ascending:false})),
    tudo(()=>sb.from('fl_conciliacoes').select('*,fl_conc_itens(*)').order('id',{ascending:false})),
    tudo(()=>sb.from('fl_vendas').select('id,pedido,pack_id,data_venda,data_liberacao,data_pagamento,status,valor_bruto,valor_liquido_previsto,ml_conta_id,empresa_id,canal').eq('canal','mercado_livre').eq('status','concluida').order('data_venda',{ascending:false}))]);
  const conciliadas=new Set(concs.flatMap(c=>c.fl_conc_itens.map(i=>i.venda_id)));const extConc=new Map(concs.map(c=>[c.extrato_id,c]));
  const pendV=vendas.filter(v=>!conciliadas.has(v.id)&&(!FCo.conta||v.ml_conta_id==FCo.conta)).map(v=>({...v,previsto:+(v.valor_liquido_previsto??v.valor_bruto),data_ref:(v.data_liberacao||diaLocal(v.data_venda))}));
  const creditos=ext.filter(e=>+e.valor>0);const pendC=creditos.filter(e=>!extConc.has(e.id));
  const sug=ConcLogic.sugerir(pendC.map(e=>({id:e.id,data:e.data,valor:+e.valor,descricao:(e.descricao||'')+' '+(e.ref||'')})),pendV);
  window._cf={pendV,ext,sug,concs,vendas};
  const TIPO={identificador:['Vínculo por identificador','v'],valor:['Sugestão por valor e data','b'],ambigua:['Ambíguo — escolha manual','a'],nenhuma:['Sem correspondência','']};
  $('conteudo').innerHTML=ab+`<div class="filtros"><div><label>Conta bancária</label><select id="cf_b">${opcoes(contasBancoFin(),cBanco,null,x=>x.id,x=>x.nome)}</select></div>
     <div><label>Conta do Mercado Livre</label><select id="cf_c">${opcoes(contasMLFin(),FCo.conta,'Todas',x=>x.id,x=>x.apelido)}</select></div></div>
   <div class="info">Um crédito só é conciliado automaticamente quando o nº das vendas aparece na descrição e o valor confere. Valores iguais sem identificador viram sugestão: confirme anexando o relatório de repasses ou escrevendo a justificativa. O crédito bancário confirma o recebimento — não gera receita nova.</div>
   <div class="kpis"><div class="kpi"><div class="l">Créditos a conciliar</div><div class="v">${pendC.length}</div><div class="s">${brl(soma(pendC,e=>+e.valor))}</div></div>
    <div class="kpi"><div class="l">Vendas sem repasse identificado</div><div class="v">${pendV.length}</div><div class="s">${brl(soma(pendV,v=>v.previsto))} previstos</div></div>
    <div class="kpi"><div class="l">Conciliados</div><div class="v">${creditos.length-pendC.length}</div><div class="s">${brl(soma(creditos.filter(e=>extConc.has(e.id)),e=>+e.valor))}</div></div></div>
   <div class="secao"><h2>Créditos pendentes ${pendC.some(e=>sug[e.id].tipo==='identificador')?'<button class="sm pri" id="cf_auto">Confirmar todos os vínculos por identificador</button>':''}</h2>
    ${tabela([{t:'Data',v:e=>fd(e.data)},{t:'Descrição',v:e=>e.descricao},{t:'Valor',v:e=>+e.valor,n:1,tot:1},{t:'Situação',v:e=>sug[e.id].tipo,h:e=>`<span class="tag ${TIPO[sug[e.id].tipo][1]}">${TIPO[sug[e.id].tipo][0]}</span><div class="mut peq">${esc(sug[e.id].motivo)}</div>`},
      {t:'Vendas sugeridas',v:e=>sug[e.id].vendas.map(id=>pendV.find(v=>v.id===id)?.pedido).join(', ')},{t:'',v:()=>'',h:e=>`<button class="sm" onclick="modalConciliar(${e.id})">${sug[e.id].tipo==='identificador'?'Confirmar':'Conferir'}</button>`}],pendC,{vazio:'Nenhum crédito pendente nesta conta.'})}</div>
   <div class="secao"><h2>Conciliados</h2>${tabela([{t:'Data',v:c=>fd((ext.find(e=>e.id===c.extrato_id)||{}).data)},{t:'Crédito',v:c=>+(ext.find(e=>e.id===c.extrato_id)||{}).valor,n:1},{t:'Vendas',v:c=>c.fl_conc_itens.map(i=>(vendas.find(v=>v.id===i.venda_id)||{}).pedido).join(', ')},
      {t:'Método',v:c=>c.metodo==='identificador'?'Identificador':'Manual'},{t:'Diferença',v:c=>+c.diferenca,n:1},{t:'Por',v:c=>c.por_nome||''},{t:'Justificativa',v:c=>c.obs||'',h:c=>esc(c.obs||'')+(c.anexo?` <button class="lk sm" onclick="abrirAnexo('${esc(c.anexo)}')">anexo</button>`:'')},
      {t:'',v:()=>'',h:c=>`<button class="sm perigo" onclick="desfazerConc(${c.id})">Desfazer</button>`}],concs.filter(c=>ext.some(e=>e.id===c.extrato_id)),{vazio:'Nada conciliado ainda.'})}</div>`;
  $('cf_b').onchange=()=>{FCo.contaFin=val('cf_b');ir('conc');};$('cf_c').onchange=()=>{FCo.conta=val('cf_c');ir('conc');};
  if($('cf_auto'))$('cf_auto').onclick=()=>rodar($('cf_auto'),async()=>{let n=0;for(const e of pendC.filter(e=>sug[e.id].tipo==='identificador')){await rpc('fl_conciliar',{p_extrato:e.id,p_vendas:sug[e.id].vendas,p_metodo:'identificador'});n++;}toast(n+' crédito(s) conciliado(s).');ir('conc');});
}
function modalConciliar(eid){
  const {pendV,ext,sug}=window._cf;const e=ext.find(x=>x.id===eid);const s=sug[eid];const sel=new Set(s.vendas);
  const cands=pendV.filter(v=>Math.abs((new Date(e.data)-new Date(v.data_ref))/864e5)<=40).sort((a,b)=>b.data_ref.localeCompare(a.data_ref));
  abrir(`<h2>Conciliar crédito de ${brl(+e.valor)}</h2><div class="sub">${fd(e.data)} · ${esc(e.descricao||'')}</div>
   ${s.tipo==='ambigua'?`<div class="aviso">${esc(s.motivo)}</div>`:''}
   <div class="campo"><label>Vendas que formam este repasse (pendentes, até 40 dias)</label></div>
   <div class="rolar" style="max-height:300px">${tabela([{t:'',v:()=>'',h:v=>`<input type="checkbox" class="cv" value="${v.id}" ${sel.has(v.id)?'checked':''}>`},{t:'Venda',v:v=>v.pedido},{t:'Data',v:v=>fd(v.data_venda)},{t:'Liberação',v:v=>fd(v.data_liberacao)},{t:'Previsto',v:v=>v.previsto,n:1}],cands,{rolar:false,vazio:'Nenhuma venda pendente no período.'})}</div>
   <div id="cv_soma" class="pdv-total"></div>
   ${s.tipo==='identificador'?'':`<div class="c2"><div class="campo"><label>Relatório de repasses (anexo)</label><input type="file" id="cv_f"></div><div class="campo"><label>Justificativa</label><input id="cv_o" placeholder="ex.: conferido no relatório de liberações do ML"></div></div>`}
   <div class="erro"></div><div class="rodape"><button onclick="fechar()">Cancelar</button><button class="pri" id="cv_ok">Confirmar vínculo</button></div>`,true);
  const atualiza=()=>{const ids=[...document.querySelectorAll('.cv:checked')].map(x=>+x.value);const t=soma(pendV.filter(v=>ids.includes(v.id)),v=>v.previsto);const d=Math.round((+e.valor-t)*100)/100;
    $('cv_soma').innerHTML=`<span>${ids.length} venda(s) · previsto ${brl(t)}</span><b style="color:${Math.abs(d)<=0.01?'var(--grn)':'var(--red)'}">${Math.abs(d)<=0.01?'valor confere':'diferença '+brl(d)}</b>`;};
  document.querySelectorAll('.cv').forEach(c=>c.onchange=atualiza);atualiza();
  $('cv_ok').onclick=()=>rodar($('cv_ok'),async()=>{const ids=[...document.querySelectorAll('.cv:checked')].map(x=>+x.value);if(!ids.length)throw new Error('Marque as vendas.');
    const ident=s.tipo==='identificador'&&ids.length===s.vendas.length&&ids.every(i=>s.vendas.includes(i));
    let anexo=null;const f=$('cv_f')&&$('cv_f').files[0];
    if(f){const pth=`repasses/${Date.now()}-${f.name.replace(/[^\w.\-]/g,'_')}`;const up=await sb.storage.from('fl-docs').upload(pth,f);if(up.error)throw new Error('Não foi possível enviar o anexo: '+up.error.message);anexo=pth;}
    await rpc('fl_conciliar',{p_extrato:eid,p_vendas:ids,p_metodo:ident?'identificador':'manual',p_anexo:anexo,p_obs:$('cv_o')?val('cv_o')||null:null});
    fechar();toast('Crédito conciliado.');ir('conc');});
}
function desfazerConc(id){confirmar('Desfazer conciliação','O crédito e as vendas voltam a ficar pendentes.','Desfazer',async()=>{await rpc('fl_desconciliar',{p_conc:id});ir('conc');});}
async function abrirAnexo(p){const {data,error}=await sb.storage.from('fl-docs').createSignedUrl(p,300);if(error)return toast(msgErro(error));window.open(data.signedUrl,'_blank');}
// --- ganho e margem
async function telaGanho(ab){
  const op='roca';
  const args={p_de:FCo.de,p_ate:FCo.ate,p_ml_conta:FCo.conta?+FCo.conta:null,p_produto:FCo.produto||null,p_op:op};
  const [t,linhas]=await Promise.all([rpc('fl_apuracao_total',args),rpc('fl_apuracao',args)]);
  const m=ConcLogic.margem(+t.ganho,+t.receita,+t.vendas_sem_custo>0);
  window._ap=linhas;
  const cor=v=>v<0?'color:var(--red)':'';
  const kpi=(l,v,s,f)=>`<div class="kpi" onclick="${f}"><div class="l">${l}</div><div class="v" style="${typeof v==='number'?cor(v):''}">${typeof v==='number'?brl(v):v}</div><div class="s">${s||''}</div></div>`;
  $('conteudo').innerHTML=ab+`<div class="filtros"><div><label>De</label><input type="date" id="g_de" value="${FCo.de}"></div><div><label>Até</label><input type="date" id="g_ate" value="${FCo.ate}"></div>
    <div><label>Conta</label><select id="g_c">${opcoes(contasMLFin().filter(c=>empresa(c.empresa_id).operacao==='roca'),FCo.conta,'Todas',x=>x.id,x=>x.apelido)}</select></div>
    <div><label>Produto</label><input id="g_p" list="g_pl" value="${esc(FCo.produto?(produto(FCo.produto)?.sku||'')+' · '+nomeProd(FCo.produto):'')}" placeholder="Todos"><datalist id="g_pl">${REF.produtos.slice(0,4000).map(p=>`<option value="${esc((p.sku?p.sku+' · ':'')+p.nome)}">`).join('')}</datalist></div></div>
   <div class="kpis">
    ${kpi('Valor vendido',+t.vendido,`${t.vendas} venda(s)`,"detalharAp('vendido')")}
    ${kpi('Previsto para repasse',+t.previsto,'pelo arquivo de vendas',"detalharAp('previsto')")}
    ${kpi('Recebido no banco',+t.recebido,'créditos conciliados',"detalharAp('recebido')")}
    ${kpi('Diferença a conferir',+t.diferenca,`${t.nao_conciliadas} venda(s) sem crédito`,"detalharAp('diferenca')")}
    ${kpi('Ganho em R$',+t.ganho,m.texto&&m.valor!=null?m.texto:'',"detalharAp('ganho')")}
    <div class="kpi ${m.texto?'alerta':''}" onclick="detalharAp('ganho')"><div class="l">Margem (%)</div><div class="v" style="${m.valor!=null?cor(m.valor):''}">${m.valor==null?'—':m.valor.toLocaleString('pt-BR',{maximumFractionDigits:2})+'%'}</div><div class="s">${esc(m.texto||'Ganho ÷ receita apurada × 100')}</div></div></div>
   <div class="secao"><h2>Base do cálculo <small>clique em uma linha para ver os lançamentos</small></h2>
    <table class="t" style="max-width:640px"><tbody>
     <tr class="cl" onclick="detalharAp('vendido')"><td>Valor vendido</td><td class="n">${brl(+t.vendido)}</td></tr>
     <tr class="cl" onclick="detalharAp('deducoes')"><td>(−) Descontos, cancelamentos e devoluções</td><td class="n">${brl(-t.deducoes)}</td></tr>
     <tr><td><b>= Receita apurada</b></td><td class="n"><b>${brl(+t.receita)}</b></td></tr>
     <tr class="cl" onclick="detalharAp('cmv')"><td>(−) Custo das mercadorias vendidas${+t.vendas_sem_custo?` <span class="tag a">${t.vendas_sem_custo} sem custo</span>`:''}</td><td class="n">${brl(-t.cmv)}</td></tr>
     <tr class="cl" onclick="detalharAp('tarifas')"><td>(−) Tarifas de venda</td><td class="n">${brl(-t.tarifas)}</td></tr>
     <tr class="cl" onclick="detalharAp('frete')"><td>(−) Frete assumido pela empresa</td><td class="n">${brl(-t.frete)}</td></tr>
     <tr class="cl" onclick="detalharAp('outras')"><td>(−) Outras despesas identificadas</td><td class="n">${brl(-t.outras)}</td></tr>
     <tr><td><b>= Ganho em R$</b></td><td class="n" style="${cor(+t.ganho)}"><b>${brl(+t.ganho)}</b></td></tr>
     <tr><td><b>Margem (%)</b> = Ganho ÷ Receita apurada × 100</td><td class="n"><b>${m.valor==null?esc(m.texto):m.valor.toLocaleString('pt-BR',{maximumFractionDigits:2})+'%'}</b>${m.valor!=null&&m.texto?'<br><span class="tag a">'+esc(m.texto)+'</span>':''}</td></tr>
    </tbody></table>
    <div class="mut peq" style="margin-top:8px">O CMV usa o custo médio da mercadoria na data da venda, guardado no histórico. O crédito no banco confirma o recebimento e não entra como receita. Cada tarifa é descontada uma vez (por venda).</div></div>`;
  ['g_de','g_ate'].forEach(id=>$(id).onchange=()=>{FCo.de=val('g_de');FCo.ate=val('g_ate');ir('conc');});
  $('g_c').onchange=()=>{FCo.conta=val('g_c');ir('conc');};
  $('g_p').onchange=()=>{const p=acharProduto(val('g_p'));FCo.produto=p?p.id:'';ir('conc');};
}
function detalharAp(qual){const L=window._ap||[];const nomes={vendido:'Valor vendido',previsto:'Previsto para repasse',recebido:'Recebido no banco',diferenca:'Diferença a conferir',ganho:'Ganho em R$',deducoes:'Descontos, cancelamentos e devoluções',cmv:'Custo das mercadorias vendidas',tarifas:'Tarifas',frete:'Frete',outras:'Outras despesas'};
  const l=qual==='diferenca'?L.filter(x=>Math.abs(x.previsto-x.recebido)>0.01&&x.status!=='cancelada'):qual==='cmv'?L.filter(x=>+x.cmv||x.custo_pendente):L.filter(x=>qual==='ganho'||qual==='vendido'||+x[qual]);
  detalhar(nomes[qual],'Lançamentos que formam este número. Clique na venda para abrir.',[{t:'Venda',v:x=>x.pedido},{t:'Data',v:x=>fd(x.data_venda)},{t:'Conta',v:x=>x.conta||''},{t:'Status',v:x=>x.status},
    {t:'Vendido',v:x=>+x.vendido,n:1,tot:1},{t:'Deduções',v:x=>+x.deducoes,n:1,tot:1},{t:'Receita',v:x=>+x.receita,n:1,tot:1},{t:'CMV',v:x=>+x.cmv,n:1,tot:1,h:x=>x.custo_pendente?'<span class="tag a">sem custo</span>':brl(+x.cmv)},
    {t:'Tarifas',v:x=>+x.tarifas,n:1,tot:1},{t:'Frete',v:x=>+x.frete,n:1,tot:1},{t:'Outras',v:x=>+x.outras,n:1,tot:1},{t:'Ganho em R$',v:x=>+x.ganho,n:1,tot:1},
    {t:'Previsto',v:x=>+x.previsto,n:1,tot:1},{t:'Recebido',v:x=>+x.recebido,n:1,tot:1},{t:'Conciliada',v:x=>x.conciliada?'Sim':'Não'}],l,
    {clique:async x=>{const v=await q(sb.from('fl_vendas').select('*,fl_venda_itens(*,fl_venda_itens_custo(*))').eq('id',x.venda_id).single());abrirVenda(v);}});}
async function telaArquivos(ab){
  const a=await q(sb.from('fl_imp_arquivos').select('*').order('id',{ascending:false}).limit(300));
  $('conteudo').innerHTML=ab+`<div class="secao">${tabela([{t:'Quando',v:x=>fdh(x.importado_em)},{t:'Tipo',v:x=>x.tipo==='vendas'?'Vendas':'Extrato'},{t:'Conta',v:x=>x.ml_conta_id?contaML(x.ml_conta_id).apelido:(REF.contasFin.find(c=>c.id===x.conta_fin_id)||{}).nome||''},
    {t:'Arquivo',v:x=>x.nome,h:x=>x.caminho?`<button class="lk" onclick="abrirAnexo('${esc(x.caminho)}')">${esc(x.nome)}</button>`:esc(x.nome)},{t:'Linhas',v:x=>x.linhas,n:1,fmt:nf},{t:'Novos',v:x=>x.novos,n:1,fmt:nf},{t:'Atualizados',v:x=>x.atualizados,n:1,fmt:nf},{t:'Já existiam',v:x=>x.iguais,n:1,fmt:nf},{t:'Responsável',v:x=>x.importado_por_nome||''}],a,{vazio:'Nenhum arquivo importado.'})}</div>`;
}

// ---------------------------------------------------------------- Usuários e permissões
TELAS.usuarios=async function(){
  if(!master()){$('conteudo').innerHTML=bloqueado();return;}
  const [ps,cv]=await Promise.all([q(sb.from('fl_perfis').select('*').order('nome')),q(sb.from('fl_convites').select('*').order('criado_em',{ascending:false}))]);
  const opsTxt=o=>(o||[]).map(x=>x==='roca'?'Roca Imports':'FL Adega').join(', ')||'—';
  const flags=p=>[p.pode_editar_custo&&'edita custo',p.pode_desconto&&'dá desconto',p.pode_cancelar&&'cancela venda'].filter(Boolean).join(', ')||'—';
  $('conteudo').innerHTML=`<div class="barra-acoes"><button class="pri" onclick="modalUsuario()">Convidar funcionário</button></div>
   <div class="info"><b>Administrador</b>: tudo. <b>Operacional Roca Imports</b>: produtos, recebimentos, estoque e remessas (custo só com permissão). <b>Operador de PDV FL Adega</b>: caixa de Cuiabá, preços, disponibilidade, vendas e o próprio fechamento. <b>Financeiro</b>: importação, extratos, repasses e margens das operações marcadas. As permissões valem no servidor: quem digitar o endereço de uma página não liberada é bloqueado.</div>
   <div class="secao"><h2>Funcionários</h2>${tabela([{t:'Nome',v:p=>p.nome||''},{t:'E-mail',v:p=>p.email},{t:'Perfil',v:p=>PAPEIS[p.papel]||'Pendente'},{t:'Operações',v:p=>p.papel==='master'?'Todas':opsTxt(p.operacoes)},{t:'Permissões extras',v:p=>flags(p)},
     {t:'Situação',v:p=>p.ativo&&p.papel?'Ativo':'Inativo',h:p=>p.ativo&&p.papel?'<span class="tag v">ativo</span>':'<span class="tag r">inativo</span>'},{t:'Último acesso',v:p=>fdh(p.ultimo_acesso)}],ps,{clique:p=>p.user_id===sessao.user.id?toast('Você não pode alterar o próprio perfil.'):modalUsuario(p)})}</div>
   <div class="secao"><h2>Convites</h2>${tabela([{t:'E-mail',v:c=>c.email},{t:'Nome',v:c=>c.nome||''},{t:'Perfil',v:c=>PAPEIS[c.papel]},{t:'Operações',v:c=>opsTxt(c.operacoes)},{t:'Situação',v:c=>c.usado_em?'Aceito em '+fdh(c.usado_em):'Aguardando primeiro acesso'},
     {t:'',v:()=>'',h:c=>c.usado_em?'':`<button class="sm" onclick="reenviarConvite('${esc(c.email)}')">Reenviar e-mail</button> <button class="sm perigo" onclick="apagarConvite('${esc(c.email)}')">Excluir</button>`}],cv,{rolar:false,vazio:'Nenhum convite.'})}</div>`;
};
function modalUsuario(p){
  const e=p||{papel:'roca',operacoes:['roca']};
  abrir(`<h2>${p?'Editar acesso':'Convidar funcionário'}</h2><div class="sub">${p?esc(p.email):'O funcionário recebe um e-mail com o link de acesso. No primeiro acesso ele define a senha em “Minha senha”.'}</div>
   ${p?'':`<div class="c2"><div class="campo"><label>Nome</label><input id="us_n"></div><div class="campo"><label>E-mail *</label><input id="us_e" type="email"></div></div>`}
   <div class="c2"><div class="campo"><label>Perfil</label><select id="us_p">${['roca','pdv','financeiro','master'].map(k=>`<option value="${k}" ${e.papel===k?'selected':''}>${PAPEIS[k]}</option>`).join('')}</select></div>
    <div class="campo"><label>Operações</label><label><input type="checkbox" id="us_or" ${(e.operacoes||[]).includes('roca')?'checked':''}> Roca Imports</label> &nbsp; <label><input type="checkbox" id="us_oa" ${(e.operacoes||[]).includes('adega')?'checked':''}> FL Adega</label></div></div>
   <div class="campo"><label>Permissões específicas</label>
    <label><input type="checkbox" id="us_c" ${e.pode_editar_custo?'checked':''}> Editar custos (Roca)</label> &nbsp; <label><input type="checkbox" id="us_d" ${e.pode_desconto?'checked':''}> Dar desconto no PDV</label> &nbsp; <label><input type="checkbox" id="us_x" ${e.pode_cancelar?'checked':''}> Cancelar vendas do PDV</label></div>
   ${p?`<div class="campo"><label><input type="checkbox" id="us_a" ${p.ativo?'checked':''}> Acesso ativo</label></div>`:''}
   <div class="erro"></div><div class="rodape"><button onclick="fechar()">Cancelar</button><button class="pri" id="us_ok">${p?'Salvar':'Convidar'}</button></div>`);
  const sinc=()=>{const pp=val('us_p');if(pp==='roca'){$('us_or').checked=true;$('us_oa').checked=false;}if(pp==='pdv'){$('us_oa').checked=true;$('us_or').checked=false;}};
  $('us_p').onchange=sinc;
  $('us_ok').onclick=()=>rodar($('us_ok'),async()=>{
    const d={papel:val('us_p'),operacoes:[...($('us_or').checked?['roca']:[]),...($('us_oa').checked?['adega']:[])],pode_editar_custo:$('us_c').checked,pode_desconto:$('us_d').checked,pode_cancelar:$('us_x').checked};
    if(d.papel==='financeiro'&&!d.operacoes.length)throw new Error('Marque ao menos uma operação para o financeiro.');
    if(p){d.ativo=$('us_a').checked;await q(sb.from('fl_perfis').update(d).eq('user_id',p.user_id));fechar();toast('Acesso atualizado.');return ir('usuarios');}
    const email=val('us_e').toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw new Error('E-mail inválido.');
    const ex=(await q(sb.from('fl_perfis').select('*').ilike('email',email)))[0];
    if(ex){await q(sb.from('fl_perfis').update({...d,ativo:true,nome:val('us_n')||ex.nome}).eq('user_id',ex.user_id));fechar();toast('Usuário já tinha conta: acesso liberado.');return ir('usuarios');}
    await q(sb.from('fl_convites').upsert({email,nome:val('us_n')||null,...d,usado_em:null}));
    const {error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:location.origin+location.pathname,data:{nome:val('us_n')||null}}});
    fechar();toast(error?'Convite salvo. O e-mail não foi enviado ('+error.message+'): peça para a pessoa usar “Criar acesso” com este e-mail.':'Convite enviado para '+email+'.',7000);ir('usuarios');});
}
async function reenviarConvite(email){const {error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:location.origin+location.pathname}});toast(error?'Não foi possível enviar: '+error.message:'E-mail reenviado.');}
function apagarConvite(email){confirmar('Excluir convite','O e-mail deixa de receber o perfil no primeiro acesso.','Excluir',async()=>{await q(sb.from('fl_convites').delete().eq('email',email));ir('usuarios');});}
