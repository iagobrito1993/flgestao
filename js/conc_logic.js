// =====================================================================
// FL Gestão — leitura de arquivos (vendas do ML e extratos) e sugestões de conciliação.
// Funções puras: usadas no site e nos testes (node tests/conc_logic.test.js).
// =====================================================================
(function(root){
const semAcento=s=>String(s??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();

// "R$ 1.234,56" / "-12,30" / "1234.56" / 12.3 → número (NaN se inválido)
function valorBR(v){
  if(v==null||v==='')return NaN;
  if(typeof v==='number')return v;
  let s=String(v).trim().replace(/\s/g,'').replace(/^R\$/i,'').replace(/R\$/i,'');
  let neg=false;
  if(/^\(.*\)$/.test(s)){neg=true;s=s.slice(1,-1);}
  if(s.endsWith('-')){neg=true;s=s.slice(0,-1);}
  if(s.startsWith('-')){neg=!neg;s=s.slice(1);}
  if(s.startsWith('+'))s=s.slice(1);
  if(!/^[\d.,]+$/.test(s))return NaN;
  if(s.includes(',')){s=s.replace(/\./g,'').replace(',','.');}
  else if((s.match(/\./g)||[]).length>1){s=s.replace(/\./g,'');}
  else if(/^\d{1,3}\.\d{3}$/.test(s)){s=s.replace('.','');}
  const n=parseFloat(s);return isNaN(n)?NaN:(neg?-n:n);
}
const MESES={janeiro:1,fevereiro:2,marco:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12,
  jan:1,fev:2,mar:3,abr:4,mai:5,jun:6,jul:7,ago:8,set:9,out:10,nov:11,dez:12};
const p2=n=>String(n).padStart(2,'0');
function dataValida(a,m,d){const t=new Date(Date.UTC(a,m-1,d));return t.getUTCFullYear()===a&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;}
// Datas brasileiras, ISO, "10 de novembro de 2026 14:32 hs.", serial do Excel → {data:'YYYY-MM-DD', hora:'HH:MM'} ou null
function dataBR(v){
  if(v==null||v==='')return null;
  if(v instanceof Date&&!isNaN(v))return {data:`${v.getFullYear()}-${p2(v.getMonth()+1)}-${p2(v.getDate())}`,hora:`${p2(v.getHours())}:${p2(v.getMinutes())}`};
  if(typeof v==='number'&&v>20000&&v<80000){const ms=Math.round((v-25569)*864e5);const d=new Date(ms);
    return {data:`${d.getUTCFullYear()}-${p2(d.getUTCMonth()+1)}-${p2(d.getUTCDate())}`,hora:`${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`};}
  const s=semAcento(v);let m,a,me,d,h='00',mi='00';
  if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?/))){a=+m[1];me=+m[2];d=+m[3];if(m[4]){h=m[4];mi=m[5];}}
  else if((m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2}))?/))){d=+m[1];me=+m[2];a=+m[3];if(a<100)a+=2000;if(m[4]){h=p2(m[4]);mi=m[5];}}
  else if((m=s.match(/^(\d{1,2}) de ([a-z]+)\.? de (\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?/))){d=+m[1];me=MESES[m[2]];a=+m[3];if(m[4]){h=p2(m[4]);mi=m[5];}}
  else if((m=s.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2}))?/))){a=+m[1];me=+m[2];d=+m[3];if(m[4]){h=m[4];mi=m[5];}}
  else return null;
  if(!me||!dataValida(a,me,d))return null;
  return {data:`${a}-${p2(me)}-${p2(d)}`,hora:`${h}:${mi}`};
}
// Hash determinístico (FNV-1a 2×32 bits) para chaves de linhas sem identificador
function hashTexto(s){let h1=0x811c9dc5,h2=0x01000193^0x5bd1e995;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1^=c;h1=Math.imul(h1,0x01000193);h2^=c;h2=Math.imul(h2,0x5bd1e995);h2^=h2>>>13;}
  return (h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0');}

// ----- Planilhas: localizar o cabeçalho e mapear colunas -----
const CAMPOS_VENDA={
  pedido:{t:'Nº da venda',obr:true,s:['n.º de venda','nº de venda','n° de venda','numero de venda','numero da venda','n.o de venda','id da venda','id do pedido','order id','pedido','venda']},
  data:{t:'Data da venda',obr:true,s:['data da venda','data de venda','data do pedido','fecha de venta','data']},
  status:{t:'Estado / status',s:['estado','status','situacao','descricao do status']},
  sku:{t:'SKU',s:['sku','codigo do produto','seller sku']},
  descricao:{t:'Título / produto',s:['titulo do anuncio','titulo','produto','descricao do produto','descricao']},
  qtd:{t:'Unidades',s:['unidades','quantidade','qtd','qtde']},
  preco_unit:{t:'Preço unitário',s:['preco unitario de venda do anuncio (brl)','preco unitario','preco de venda','preco']},
  bruto:{t:'Receita por produtos (valor vendido)',obr:true,s:['receita por produtos (brl)','receita por produtos','valor da venda','valor do produto','valor bruto','receita']},
  tarifa:{t:'Tarifa de venda',s:['tarifa de venda e impostos (brl)','tarifa de venda e impostos','tarifa de venda','tarifa','comissao']},
  frete:{t:'Tarifa de envio (frete pago pela empresa)',s:['tarifas de envio (brl)','tarifas de envio','tarifa de envio','custo de envio','frete vendedor','frete']},
  cancelado:{t:'Cancelamentos e reembolsos',s:['cancelamentos e reembolsos (brl)','cancelamentos e reembolsos','reembolsos','cancelamentos','valor cancelado']},
  liquido:{t:'Total a receber (repasse previsto)',s:['total (brl)','total a receber','valor liquido','liquido','total']},
  data_liberacao:{t:'Data de liberação',s:['data de liberacao','data da liberacao','liberacao do dinheiro','data de disponibilizacao']},
  pack_id:{t:'Pacote',s:['n.º do pacote','nº do pacote','pacote','pack id']},
  cliente:{t:'Comprador',s:['comprador','cliente','nome do comprador']},
  logistica:{t:'Forma de entrega',s:['forma de entrega','tipo de envio','logistica']},
};
const CAMPOS_EXTRATO={
  data:{t:'Data',obr:true,s:['data do lancamento','data lancamento','data movimento','data','dt']},
  descricao:{t:'Descrição / histórico',obr:true,s:['descricao','historico','lancamento','memo','detalhes']},
  valor:{t:'Valor (+ crédito / − débito)',s:['valor (r$)','valor','quantia','montante']},
  credito:{t:'Crédito (se separado)',s:['credito','entradas','entrada']},
  debito:{t:'Débito (se separado)',s:['debito','saidas','saida']},
  ref:{t:'Documento / identificador',s:['documento','n documento','nº documento','identificador','id da transacao','id']},
};
function acharCabecalho(aoa,campos){
  let melhor=-1,pts=0;
  for(let i=0;i<Math.min(aoa.length,30);i++){
    const cel=(aoa[i]||[]).map(semAcento);let n=0;
    Object.values(campos).forEach(c=>{if(cel.some(x=>c.s.includes(x)))n++;});
    if(n>pts){pts=n;melhor=i;}
  }
  return pts>=2?melhor:0;
}
function mapearColunas(cabecalho,campos){
  const cab=cabecalho.map(semAcento),map={},usadas=new Set();
  for(const [k,c] of Object.entries(campos)){
    let idx=-1;
    for(const s of c.s){const i=cab.findIndex((x,j)=>x===s&&!usadas.has(j));if(i>=0){idx=i;break;}}
    if(idx<0)for(const s of c.s){if(s.length<4)continue;const i=cab.findIndex((x,j)=>x.startsWith(s)&&!usadas.has(j));if(i>=0){idx=i;break;}}
    if(idx>=0){map[k]=idx;usadas.add(idx);}
  }
  return map;
}
const statusVenda=s=>{const t=semAcento(s);if(!t)return 'concluida';if(/cancel/.test(t))return 'cancelada';if(/devolu|reembols/.test(t))return 'devolvida';if(/pend|aguard|nao pago|em processo/.test(t))return 'pendente';return 'concluida';};
const logisticaML=s=>{const t=semAcento(s);if(!t)return null;if(/full/.test(t))return 'fulfillment';if(/flex|mesmo dia/.test(t))return 'self_service';if(/agencia|ponto/.test(t))return 'xd_drop_off';if(/coleta/.test(t))return 'cross_docking';return null;};

// Linhas da planilha de vendas → vendas agrupadas por nº (uma linha por item). linhaInicial = nº da linha do 1º dado na planilha.
function lerVendas(linhas,map,linhaInicial=2){
  const erros=[],porPedido=new Map(),col=(r,k)=>map[k]==null?undefined:r[map[k]];
  linhas.forEach((r,i)=>{
    const n=linhaInicial+i;
    if(!r||r.every(c=>c==null||String(c).trim()===''))return;
    const pedido=String(col(r,'pedido')??'').trim().replace(/\.0$/,'').replace(/^#/,'');
    if(!pedido){erros.push({linha:n,motivo:'Nº da venda vazio'});return;}
    const dt=dataBR(col(r,'data'));
    if(!dt){erros.push({linha:n,motivo:`Data inválida: "${col(r,'data')??''}"`});return;}
    const vb=valorBR(col(r,'bruto'));const qtd=map.qtd==null?1:valorBR(col(r,'qtd'));const pu=valorBR(col(r,'preco_unit'));
    let bruto=isNaN(vb)?(!isNaN(pu)&&!isNaN(qtd)?pu*qtd:NaN):vb;
    if(isNaN(bruto)){erros.push({linha:n,motivo:`Valor vendido inválido: "${col(r,'bruto')??''}"`});return;}
    if(isNaN(qtd)||qtd<0){erros.push({linha:n,motivo:`Quantidade inválida: "${col(r,'qtd')??''}"`});return;}
    const num=(k)=>{const v=col(r,k);if(v==null||v==='')return 0;const x=valorBR(v);return isNaN(x)?null:x;};
    const t=num('tarifa'),f=num('frete'),c=num('cancelado'),lq=map.liquido==null?null:num('liquido');
    for(const [k,x] of [['tarifa',t],['frete',f],['cancelado',c],['liquido',lq]])if(x===null&&!(k==='liquido'&&map.liquido==null)){erros.push({linha:n,motivo:`Valor inválido em "${CAMPOS_VENDA[k].t}": "${col(r,k)}"`});return;}
    const lib=map.data_liberacao==null?null:dataBR(col(r,'data_liberacao'));
    let v=porPedido.get(pedido);
    if(!v){v={pedido,data:`${dt.data}T${dt.hora}:00-03:00`,status:statusVenda(col(r,'status')),cliente:col(r,'cliente')?String(col(r,'cliente')).trim():null,
      pack_id:col(r,'pack_id')?String(col(r,'pack_id')).replace(/\.0$/,''):null,logistica:logisticaML(col(r,'logistica')),
      bruto:0,tarifa:0,frete:0,cancelado:0,liquido:map.liquido==null?null:0,data_liberacao:lib?lib.data:null,itens:[],linhas:[]};porPedido.set(pedido,v);}
    v.linhas.push(n);
    v.bruto+=Math.abs(bruto);v.tarifa+=Math.abs(t);v.frete+=Math.abs(f);v.cancelado+=Math.abs(c);if(v.liquido!=null)v.liquido+=lq;
    if(bruto!==0||qtd>0)v.itens.push({sku:col(r,'sku')?String(col(r,'sku')).trim():null,descricao:String(col(r,'descricao')??'').trim()||pedido,qtd:qtd||1,
      preco_unit:+(Math.abs(bruto)/(qtd||1)).toFixed(4),tarifa:Math.abs(t)});
  });
  const vendas=[...porPedido.values()].map(v=>{const r=x=>Math.round(x*100)/100;
    if(v.status==='cancelada'&&v.cancelado===0)v.cancelado=v.bruto;
    return {...v,bruto:r(v.bruto),tarifa:r(v.tarifa),frete:r(v.frete),cancelado:r(v.cancelado),liquido:v.liquido==null?r(v.bruto-v.cancelado-v.tarifa-v.frete):r(v.liquido)};});
  return {vendas,erros};
}

// Extrato em planilha CSV → linhas {data,valor,descricao,ref,chave}
function lerExtratoPlanilha(linhas,map,linhaInicial=2){
  const erros=[],out=[],ocorr={},col=(r,k)=>map[k]==null?undefined:r[map[k]];
  if(map.valor==null&&(map.credito==null||map.debito==null))return {linhas:[],erros:[{linha:0,motivo:'Indique a coluna Valor ou as colunas Crédito e Débito'}]};
  linhas.forEach((r,i)=>{
    const n=linhaInicial+i;
    if(!r||r.every(c=>c==null||String(c).trim()===''))return;
    const dt=dataBR(col(r,'data'));
    if(!dt){const tx=semAcento(col(r,'descricao'));if(/saldo/.test(tx))return;erros.push({linha:n,motivo:`Data inválida: "${col(r,'data')??''}"`});return;}
    let valor;
    if(map.valor!=null){valor=valorBR(col(r,'valor'));}
    else{const c=valorBR(col(r,'credito')),d=valorBR(col(r,'debito'));valor=(isNaN(c)?0:Math.abs(c))-(isNaN(d)?0:Math.abs(d));if(isNaN(c)&&isNaN(d))valor=NaN;}
    if(isNaN(valor)){erros.push({linha:n,motivo:`Valor inválido: "${col(r,map.valor!=null?'valor':'credito')??''}"`});return;}
    const descricao=String(col(r,'descricao')??'').trim();
    if(/^saldo/i.test(semAcento(descricao)))return;
    if(!descricao){erros.push({linha:n,motivo:'Descrição vazia'});return;}
    const ref=col(r,'ref')!=null&&String(col(r,'ref')).trim()!==''?String(col(r,'ref')).trim():null;
    const base=[dt.data,valor.toFixed(2),semAcento(descricao),ref||''].join('|');
    ocorr[base]=(ocorr[base]||0)+1;
    out.push({data:dt.data,valor:Math.round(valor*100)/100,descricao,ref,chave:'h:'+hashTexto(base)+'#'+ocorr[base]});
  });
  return {linhas:out,erros};
}

// OFX (SGML ou XML) → linhas {data,valor,descricao,ref,chave}
function lerOFX(texto){
  const erros=[],out=[];
  const blocos=String(texto).split(/<STMTTRN>/i).slice(1);
  if(!blocos.length)return {linhas:[],erros:[{linha:0,motivo:'Arquivo OFX sem lançamentos (<STMTTRN>)'}]};
  const tag=(b,t)=>{const m=b.match(new RegExp('<'+t+'>([^<\\r\\n]*)','i'));return m?m[1].trim():null;};
  blocos.forEach((b,i)=>{
    const dt=dataBR(tag(b,'DTPOSTED')),v=valorBR(String(tag(b,'TRNAMT')||'').replace(',','.')),fit=tag(b,'FITID');
    const desc=[tag(b,'NAME'),tag(b,'MEMO')].filter(Boolean).join(' — ');
    if(!dt){erros.push({linha:i+1,motivo:'Lançamento '+(i+1)+': data inválida'});return;}
    if(isNaN(v)){erros.push({linha:i+1,motivo:'Lançamento '+(i+1)+': valor inválido'});return;}
    out.push({data:dt.data,valor:Math.round(v*100)/100,descricao:desc||'(sem descrição)',ref:tag(b,'CHECKNUM')||tag(b,'REFNUM')||fit,
      chave:fit?'fit:'+fit:'h:'+hashTexto([dt.data,v.toFixed(2),desc].join('|'))+'#'+(i+1)});
  });
  return {linhas:out,erros};
}

// ----- Sugestões de conciliação -----
// creditos: [{id,data,valor,descricao}], vendas: [{id,pedido,pack_id,previsto,data_ref}]
// Retorna {porCredito:{id:{tipo,vendas:[ids],motivo,soma}}}. tipo: identificador | valor | ambigua | nenhuma.
// "valor" e "ambigua" nunca são confirmados sozinhos: exigem confirmação manual (anexo ou justificativa).
function diasEntre(a,b){return Math.round((new Date(a+'T12:00:00Z')-new Date(b+'T12:00:00Z'))/864e5);}
function sugerir(creditos,vendas,opc={}){
  const janelaAntes=opc.janelaAntes??20,janelaDepois=opc.janelaDepois??3,tol=0.01;
  const res={};
  for(const c of creditos){
    if(!(c.valor>0)){res[c.id]={tipo:'nenhuma',vendas:[],motivo:'Débito — não é repasse'};continue;}
    const desc=semAcento(c.descricao).replace(/\s/g,'');
    const porId=vendas.filter(v=>(v.pedido&&String(v.pedido).length>=5&&desc.includes(semAcento(v.pedido)))||(v.pack_id&&String(v.pack_id).length>=5&&desc.includes(semAcento(v.pack_id))));
    if(porId.length){const s=porId.reduce((a,v)=>a+v.previsto,0);
      if(Math.abs(s-c.valor)<=tol){res[c.id]={tipo:'identificador',vendas:porId.map(v=>v.id),soma:s,motivo:'Nº das vendas aparece na descrição do crédito e o valor confere'};continue;}
      res[c.id]={tipo:'ambigua',vendas:porId.map(v=>v.id),soma:s,motivo:`Nº de venda na descrição, mas a soma prevista (${s.toFixed(2)}) difere do crédito`};continue;}
    const cand=vendas.filter(v=>{const d=diasEntre(c.data,v.data_ref);return d>=-janelaDepois&&d<=janelaAntes&&v.previsto>0;}).sort((a,b)=>b.previsto-a.previsto);
    const sols=[];
    // 1) uma venda
    cand.forEach(v=>{if(Math.abs(v.previsto-c.valor)<=tol)sols.push([v]);});
    // 2) subconjuntos (busca limitada)
    if(sols.length<2&&cand.length<=18){
      const lim=cand.slice(0,18);const atual=[];
      const dfs=(i,soma)=>{if(sols.length>=3)return;if(Math.abs(soma-c.valor)<=tol&&atual.length>1){sols.push([...atual]);return;}
        if(i>=lim.length||soma>c.valor+tol)return;
        atual.push(lim[i]);dfs(i+1,soma+lim[i].previsto);atual.pop();dfs(i+1,soma);};
      dfs(0,0);
    }
    if(!sols.length)res[c.id]={tipo:'nenhuma',vendas:[],motivo:'Nenhuma combinação de vendas pendentes soma este valor'};
    else if(sols.length>1)res[c.id]={tipo:'ambigua',vendas:[],opcoes:sols.map(s=>s.map(v=>v.id)),motivo:`${sols.length} combinações possíveis: escolha manualmente`};
    else res[c.id]={tipo:'valor',vendas:sols[0].map(v=>v.id),soma:c.valor,motivo:'Valor e data compatíveis — confirme anexando o relatório de repasses ou com justificativa'};
  }
  // vendas disputadas por mais de um crédito → todos ambíguos
  const uso={};
  Object.entries(res).forEach(([cid,r])=>{if(r.tipo==='valor'||r.tipo==='identificador')r.vendas.forEach(v=>(uso[v]=uso[v]||[]).push(cid));});
  Object.values(uso).forEach(cs=>{if(cs.length>1)cs.forEach(cid=>{const r=res[cid];if(r.tipo==='valor'||r.tipo==='identificador'){r.opcoes=[r.vendas];r.vendas=[];r.tipo='ambigua';r.motivo='Mais de um crédito pode corresponder às mesmas vendas: escolha manualmente';}});});
  return res;
}

// Margem: Ganho ÷ Receita × 100, com as regras de exibição
function margem(ganho,receita,pendente){
  if(!receita)return {texto:'Sem base para cálculo',valor:null};
  const m=Math.round(ganho/receita*10000)/100;
  return {texto:pendente?'Margem pendente de conferência':null,valor:m};
}

const api={semAcento,valorBR,dataBR,hashTexto,CAMPOS_VENDA,CAMPOS_EXTRATO,acharCabecalho,mapearColunas,lerVendas,lerExtratoPlanilha,lerOFX,sugerir,margem};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ConcLogic=api;
})(typeof window!=='undefined'?window:globalThis);
