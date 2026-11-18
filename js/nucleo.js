// =====================================================================
// FL Gestão — núcleo: conexão, login, navegação e utilidades
// =====================================================================
const SUPABASE_URL='https://rxqlkfzsvoqydqqzffih.supabase.co';
const SUPABASE_KEY='sb_publishable__IZIszN0QheZChaDwqVA8A_vlQnP9tw';
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_KEY);

const PAPEIS={master:'Administrador',financeiro:'Financeiro',roca:'Operacional Roca Imports',pdv:'Operador de PDV FL Adega',compras:'Compras (antigo)',estoque:'Estoque (antigo)',operacao:'Operação (antiga)'};
const LOGO_SVG=`<svg width="40" height="40" viewBox="0 0 64 64" aria-label="FL Gestão"><rect width="64" height="64" rx="14" fill="#0a0a0a"/><rect x="4.5" y="4.5" width="55" height="55" rx="10.5" fill="none" stroke="#fff" stroke-opacity=".32"/><text x="32" y="39" text-anchor="middle" font-family="'Playfair Display',Georgia,'Times New Roman',serif" font-weight="700" font-size="29" letter-spacing="-1" fill="#fff">FL</text><path d="M21 46.5h22" stroke="#fff" stroke-width="1.2" stroke-opacity=".75"/><circle cx="32" cy="46.5" r="1.6" fill="#fff"/></svg>`;
const LOGO_GRANDE=`<svg width="72" height="72" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0a0a"/><rect x="4.5" y="4.5" width="55" height="55" rx="10.5" fill="none" stroke="#fff" stroke-opacity=".32"/><text x="32" y="36" text-anchor="middle" font-family="'Playfair Display',Georgia,'Times New Roman',serif" font-weight="700" font-size="27" letter-spacing="-1" fill="#fff">FL</text><path d="M20 42.5h24" stroke="#fff" stroke-width="1" stroke-opacity=".7"/><circle cx="32" cy="42.5" r="1.4" fill="#fff"/><text x="32" y="52" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-weight="600" font-size="5" letter-spacing="2.2" fill="#fff" fill-opacity=".85">GESTÃO</text></svg>`;
// [id, rótulo, papéis que veem ('__' = só administrador), grupo, regra extra, oculto do menu]
const OPS=p=>p&&(p.operacoes||[]);
const AREAS=[
 ['inicio','Início',[],''],
 ['roca','Estoque, recebimentos e remessas',['roca','estoque','compras'],'Roca Imports'],
 ['pdv','Abrir PDV',['pdv','operacao'],'FL Adega'],
 ['fechamento','Fechamento de caixa',['pdv','operacao','financeiro'],'FL Adega',p=>p.papel!=='financeiro'||OPS(p).includes('adega')],
 ['conc','Conciliação',['financeiro'],'Financeiro',p=>p.papel!=='financeiro'||OPS(p).length>0],
 ['usuarios','Usuários e permissões',['__'],'Administração'],
 ['visao','Visão geral',['__'],'Administração'],
 ['produtos','Cadastro mestre de produtos',['compras','estoque'],'Administração'],
 ['estoque','Estoque geral',['compras','estoque'],'Administração'],
 ['nfe','Notas fiscais de entrada',['compras'],'Administração'],
 ['nfs','Notas fiscais de saída',['operacao'],'Administração'],
 ['compras','Recebimento por nota fiscal',['compras','estoque'],'Administração'],
 ['expedicao','Expedição',['operacao','estoque'],'Administração'],
 ['custos','Custos e margens',['compras'],'Administração'],
 ['financeiro','Financeiro e fluxo de caixa',['__'],'Administração'],
 ['pendencias','Pendências',['__'],'Administração'],
 ['relatorios','Relatórios',['__'],'Administração'],
 ['integracoes','Integrações e configurações',['__'],'Administração'],
 ['vendas','Histórico de vendas',['financeiro'],'Financeiro',null,true],
];
let sessao=null,perfil=null,area=null,modoLogin='entrar';
const REF={empresas:[],unidades:[],locais:[],produtos:[],codigos:[],contasML:[],canalContas:[],config:{},perfis:[],contasFin:[],kits:[]};
const F={de:inicioMes(),ate:hojeISO(),empresa:'',canal:'',conta:'',unidade:'',categoria:'',produto:''}; // filtros globais

// ---------- utilidades ----------
const $=id=>document.getElementById(id);
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fuso(){return REF.config.fuso||'America/Sao_Paulo';}
function hojeISO(){return new Intl.DateTimeFormat('en-CA',{timeZone:(window.REF&&REF.config&&REF.config.fuso)||'America/Sao_Paulo'}).format(new Date());}
function inicioMes(d){const h=d||hojeISO();return h.slice(0,8)+'01';}
function addDias(iso,n){const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function diaLocal(ts){if(!ts)return null;if(/^\d{4}-\d{2}-\d{2}$/.test(ts))return ts;return new Intl.DateTimeFormat('en-CA',{timeZone:fuso()}).format(new Date(ts));}
function fd(s){if(!s)return '—';const p=diaLocal(s).split('-');return `${p[2]}/${p[1]}/${p[0]}`;}
function fdh(s){return s?new Date(s).toLocaleString('pt-BR',{timeZone:fuso(),day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';}
function mesNome(ym){const [a,m]=ym.split('-');return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][+m-1]+'/'+a.slice(2);}
function brl(n){if(n==null||isNaN(n))return '—';return Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
function brlc(n){if(n==null||isNaN(n))return '—';const a=Math.abs(n);if(a>=1e6)return 'R$ '+(n/1e6).toLocaleString('pt-BR',{maximumFractionDigits:2})+' mi';if(a>=1e4)return 'R$ '+(n/1e3).toLocaleString('pt-BR',{maximumFractionDigits:1})+' mil';return brl(n);}
function nf(n,d=0){if(n==null||isNaN(n))return '—';return Number(n).toLocaleString('pt-BR',{maximumFractionDigits:d,minimumFractionDigits:0});}
function pct(n){if(n==null||!isFinite(n))return '—';return (n*100).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';}
function num(v){if(v==null||v==='')return NaN;if(typeof v==='number')return v;let s=String(v).trim().replace(/[R$\s]/g,'');if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');return parseFloat(s);}
function norm(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();}
function val(id){const e=$(id);return e?e.value.trim():'';}
function soma(a,f){return a.reduce((s,x)=>s+(+f(x)||0),0);}
function agrupar(a,f){const m={};a.forEach(x=>{const k=f(x);(m[k]=m[k]||[]).push(x);});return m;}
function toast(m,t=3500){const e=$('toast');e.textContent=m;e.classList.remove('oculto');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add('oculto'),t);}
function msgErro(e){const m=(e&&(e.message||e.error_description||e.details))||String(e||'Erro inesperado.');
  if(/row-level security|permission denied|Sem permissão/i.test(m))return 'Seu perfil não tem permissão para esta ação.';
  if(/Failed to fetch|NetworkError/i.test(m))return 'Sem conexão com a internet. Tente de novo.';
  if(/duplicate key/i.test(m))return 'Este registro já existe (duplicidade bloqueada).';
  return m;}
function papel(){return perfil&&perfil.papel;}
function master(){return papel()==='master';}
function tem(...p){return master()||p.includes(papel());}
function veCusto(){return tem('financeiro','compras');}
function veFin(){return tem('financeiro');}
async function q(promessa){const {data,error}=await promessa;if(error)throw error;return data;}
async function tudo(fq){const out=[];for(let i=0;;i+=1000){const {data,error}=await fq().range(i,i+999);if(error)throw error;out.push(...data);if(data.length<1000)break;}return out;}
async function rpc(fn,args){const {data,error}=await sb.rpc(fn,args);if(error)throw error;return data;}
function produto(id){return REF.produtos.find(p=>p.id===id);}
function nomeProd(id){const p=produto(id);return p?p.nome:'(sem vínculo)';}
function empresa(id){return REF.empresas.find(e=>e.id==id)||{nome:'—'};}
function local(id){return REF.locais.find(l=>l.id==id)||{nome:'—'};}
function contaML(id){return REF.contasML.find(c=>c.id==id)||{apelido:'—'};}
function nomeUsuario(uid){const p=REF.perfis.find(x=>x.user_id===uid);return p?(p.nome||p.email):'';}
function baixarArquivo(nome,conteudo,tipo='text/csv;charset=utf-8'){const b=new Blob([conteudo],{type:tipo});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=nome;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);}
function paraCSV(cols,linhas){const e=v=>{v=v==null?'':String(v);return /[;"\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;};
  return '﻿'+cols.map(c=>e(c.t)).join(';')+'\n'+linhas.map(l=>cols.map(c=>{let v=c.csv?c.csv(l):c.v(l);if(typeof v==='number')v=String(v).replace('.',',');return e(v);}).join(';')).join('\n');}

// ---------- modal, confirmação e lista detalhada (drill-down) ----------
function abrir(html,largo){$('modal').className='modal'+(largo?' largo':'');$('modal').innerHTML=html;$('ov').classList.remove('oculto');$('ov').scrollTop=0;}
function fechar(){$('ov').classList.add('oculto');$('modal').innerHTML='';}
$('ov').addEventListener('mousedown',e=>{if(e.target.id==='ov')fechar();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('ov').classList.contains('oculto'))fechar();});
async function rodar(btn,fn){const err=$('modal').querySelector('.erro');if(err)err.textContent='';btn.disabled=true;
  try{await fn();}catch(e){console.error(e);if(err)err.textContent=msgErro(e);else toast(msgErro(e));}finally{btn.disabled=false;}}
function confirmar(titulo,texto,rotulo,fn){abrir(`<h2>${esc(titulo)}</h2><div class="sub">${texto}</div><div class="erro"></div>
  <div class="rodape"><button onclick="fechar()">Cancelar</button><button class="pri" id="cf_ok">${esc(rotulo)}</button></div>`);
  $('cf_ok').onclick=()=>rodar($('cf_ok'),async()=>{await fn();fechar();});}
// Tabela genérica: cols=[{t:'Título',v:l=>valor,h:l=>html,n:true(número),tot:true}]
function tabela(cols,linhas,opc={}){
  if(!linhas.length)return `<div class="vazio">${opc.vazio||'Nenhum registro.'}</div>`;
  const lim=opc.limite||400,mostrar=linhas.slice(0,lim);
  const tot=cols.some(c=>c.tot)?`<tfoot><tr>${cols.map((c,i)=>`<td class="${c.n?'n':''}">${c.tot?(c.fmt||brl)(soma(linhas,c.v)):(i===0?'Total ('+linhas.length+')':'')}</td>`).join('')}</tr></tfoot>`:'';
  const id='tb'+Math.random().toString(36).slice(2,8);
  window['_tb_'+id]={cols,linhas,clique:opc.clique};
  return `<div class="rolarx ${opc.rolar===false?'':'rolar'}"><table class="t" id="${id}"><thead><tr>${cols.map(c=>`<th class="${c.n?'n':''}">${esc(c.t)}</th>`).join('')}</tr></thead>
  <tbody>${mostrar.map((l,i)=>`<tr data-i="${i}" class="${opc.clique?'cl':''}">${cols.map(c=>`<td class="${c.n?'n':''}">${c.h?c.h(l):esc(c.n&&typeof c.v(l)==='number'?(c.fmt||brl)(c.v(l)):c.v(l))}</td>`).join('')}</tr>`).join('')}</tbody>${tot}</table></div>
  ${linhas.length>lim?`<div class="mut peq" style="margin-top:6px">Mostrando ${lim} de ${linhas.length}. Use os filtros ou exporte em CSV para ver tudo.</div>`:''}`;
}
document.addEventListener('click',e=>{const tr=e.target.closest('tr.cl');if(!tr||e.target.closest('button,a,input,select'))return;const tb=tr.closest('table');const d=window['_tb_'+tb.id];if(d&&d.clique)d.clique(d.linhas[+tr.dataset.i]);});
function exportarTabela(nome,cols,linhas){baixarArquivo(nome+'.csv',paraCSV(cols,linhas));}
// Abre a lista dos registros que compõem um total
function detalhar(titulo,explicacao,cols,linhas,opc={}){
  window._det={cols,linhas,titulo};
  abrir(`<h2>${esc(titulo)}</h2><div class="sub">${explicacao||''}</div>
   <div class="barra-acoes"><button class="sm" onclick="exportarTabela(window._det.titulo,window._det.cols,window._det.linhas)">Exportar CSV</button></div>
   ${tabela(cols,linhas,opc)}<div class="rodape"><button onclick="fechar()">Fechar</button></div>`,true);
}

// ---------- login ----------
function telaLogin(msg,ok){
  const cad=modoLogin==='criar',rec=modoLogin==='esqueci';
  $('raiz').innerHTML=`<div class="login"><div class="logo-g">${LOGO_GRANDE}</div><h1 class="marca-t">FL Gestão</h1>
  <div class="sub">${cad?'Crie seu acesso. O administrador libera o seu perfil.':rec?'Enviaremos um link para criar uma nova senha.':'Entre com seu e-mail e senha.'}</div>
  <form id="fl">${cad?'<div class="campo"><label>Seu nome</label><input id="l_nome" required></div>':''}
  <div class="campo"><label>E-mail</label><input id="l_email" type="email" autocomplete="email" required></div>
  ${rec?'':`<div class="campo"><label>Senha</label><input id="l_senha" type="password" minlength="8" autocomplete="${cad?'new-password':'current-password'}" required></div>`}
  <div class="erro" id="l_erro" style="${ok?'color:var(--grn)':''}">${esc(msg||'')}</div>
  <button class="pri" id="l_ok">${cad?'Criar acesso':rec?'Enviar link':'Entrar'}</button></form>
  <div class="alt">${cad||rec?'<button class="lk" data-m="entrar">Voltar</button>':'<button class="lk" data-m="criar">Criar acesso</button> · <button class="lk" data-m="esqueci">Esqueci a senha</button>'}</div></div>`;
  document.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{modoLogin=b.dataset.m;telaLogin();});
  $('fl').onsubmit=async e=>{e.preventDefault();const b=$('l_ok');b.disabled=true;$('l_erro').textContent='';const email=val('l_email');
    try{
      if(cad){const {data,error}=await sb.auth.signUp({email,password:$('l_senha').value,options:{data:{nome:val('l_nome')},emailRedirectTo:location.origin+location.pathname}});if(error)throw error;
        if(!data.session){modoLogin='entrar';return telaLogin('Acesso criado. Confirme pelo link enviado ao seu e-mail e depois entre.',true);}}
      else if(rec){const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});if(error)throw error;return telaLogin('Link enviado. Confira seu e-mail.',true);}
      else{const {error}=await sb.auth.signInWithPassword({email,password:$('l_senha').value});if(error)throw error;}
    }catch(err){$('l_erro').textContent=/Invalid login/i.test(err.message)?'E-mail ou senha incorretos.':msgErro(err);b.disabled=false;}};
}
function telaPendente(){
  $('raiz').innerHTML=`<div class="login"><div class="logo-g">${LOGO_GRANDE}</div><h1 class="marca-t">FL Gestão</h1><div class="sub">Olá, ${esc(perfil?.nome||sessao.user.email)}.</div>
  <p>Seu acesso foi criado e aguarda liberação do administrador.</p><button class="pri" onclick="carregarPerfil()">Verificar de novo</button>
  <div class="alt"><button class="lk" onclick="sb.auth.signOut()">Sair</button></div></div>`;
}
sb.auth.onAuthStateChange((ev,s)=>{
  if(ev==='PASSWORD_RECOVERY'){sessao=s;setTimeout(()=>{abrir(`<h2>Nova senha</h2><div class="campo"><label>Nova senha (mín. 8)</label><input id="ns" type="password" minlength="8"></div><div class="erro"></div><div class="rodape"><button class="pri" id="ns_ok">Salvar</button></div>`);
    $('ns_ok').onclick=()=>rodar($('ns_ok'),async()=>{const {error}=await sb.auth.updateUser({password:$('ns').value});if(error)throw error;fechar();toast('Senha alterada.');});},300);}
  if(ev==='SIGNED_IN'&&(!sessao||sessao.user.id!==s.user.id)){sessao=s;setTimeout(carregarPerfil,0);}
  if(ev==='SIGNED_OUT'){sessao=null;perfil=null;setTimeout(()=>telaLogin(),0);}
  if(s)sessao=s;
});
async function iniciar(){const {data:{session}}=await sb.auth.getSession();sessao=session;if(!sessao)return telaLogin();await carregarPerfil();}
async function carregarPerfil(){
  try{perfil=await rpc('fl_entrar');}catch(e){$('raiz').innerHTML=`<div class="login"><h1>FL Gestão</h1><p class="erro">Não foi possível carregar seu acesso: ${esc(msgErro(e))}</p><button onclick="location.reload()">Recarregar</button> <button onclick="sb.auth.signOut()">Sair</button></div>`;return;}
  if(!perfil||!perfil.papel||!perfil.ativo)return telaPendente();
  await carregarRef();
  const h=location.hash.replace('#','').split('?')[0];
  area=h&&AREAS.find(a=>a[0]===h)?h:(area||'inicio');
  montar();
}
async function carregarRef(){
  const [emp,uni,loc,prods,cods,ml,cfg,kits,cc]=await Promise.all([
    q(sb.from('fl_empresas').select('*').order('id')),q(sb.from('fl_unidades').select('*').order('id')),q(sb.from('fl_locais').select('*').order('id')),
    tudo(()=>sb.from('fl_produtos').select('*').order('nome')),tudo(()=>sb.from('fl_codigos').select('*')),
    q(sb.from('fl_ml_contas').select('*').order('id')),q(sb.from('fl_config').select('*')),q(sb.from('fl_kit_itens').select('*')),q(sb.from('fl_canal_contas').select('*').order('id'))]);
  Object.assign(REF,{empresas:emp,unidades:uni,locais:loc,produtos:prods,codigos:cods,contasML:ml,kits,canalContas:cc});
  REF.config={};cfg.forEach(c=>REF.config[c.chave]=c.valor);
  REF.perfis=master()?await q(sb.from('fl_perfis').select('*').order('nome')):[perfil];
  REF.contasFin=veFin()?await q(sb.from('fl_contas_fin').select('*').order('nome')):[];
}

// ---------- navegação ----------
function podeArea(a){if(!a)return false;if(master())return true;if(a[2].length&&!a[2].includes(papel()))return false;return !a[4]||a[4](perfil);}
function areasDoPapel(){return AREAS.filter(a=>podeArea(a));}
function montar(){
  $('raiz').innerHTML=`<div class="app"><aside class="lado" id="lado"><div class="marca"><div class="logo">${LOGO_SVG}</div><div><b class="marca-t">FL Gestão</b><small>Roca Imports · FL Adega</small></div></div>
   <nav id="nav"></nav></aside>
   <div class="principal"><div class="topo"><div style="display:flex;gap:10px;align-items:center"><button class="menu-mob sm" onclick="$('lado').classList.toggle('aberto')">☰</button><h1 id="titulo"></h1></div>
   <div class="quem"><span>${esc(perfil.nome||perfil.email)} · ${PAPEIS[perfil.papel]}</span><button class="sm" onclick="modalSenha()">Minha senha</button><button class="sm" onclick="sb.auth.signOut()">Sair</button></div></div>
   <div class="conteudo" id="conteudo"></div></div></div>`;
  ir(area);
}
async function contarPendencias(){try{const {count}=await sb.from('fl_pendencias').select('id',{count:'exact',head:true}).in('status',['aberta','em_analise']);return count||0;}catch(e){return 0;}}
async function ir(a,extra){
  if(a==='caixa')a='pdv';if(a==='conciliacao')a='pendencias';
  if(!AREAS.find(x=>x[0]===a))a='inicio';
  area=a;history.replaceState(null,'','#'+a);
  let grupo=null;
  $('nav').innerHTML=areasDoPapel().filter(x=>!x[5]).map(([id,nome,,g])=>{const cab=g!==grupo?(grupo=g,g?`<div class="grupo">${esc(g)}</div>`:''):'';
    return cab+`<button class="${id===a?'on':''}" onclick="ir('${id}');$('lado').classList.remove('aberto')">${esc(nome)}</button>`;}).join('');
  const def=AREAS.find(x=>x[0]===a);
  $('titulo').textContent=a==='pdv'?'FL Adega — PDV':a==='roca'?'Roca Imports':def[1];
  if(!podeArea(def)){$('conteudo').innerHTML=bloqueado();return;}
  $('conteudo').innerHTML='<div class="vazio">Carregando…</div>';
  try{await TELAS[a](extra);}catch(e){console.error(e);$('conteudo').innerHTML=/Sem permissão/i.test(e&&e.message||'')?bloqueado():`<div class="aviso">Não foi possível carregar: ${esc(msgErro(e))}</div>`;}
}
function bloqueado(){return `<div class="secao" style="max-width:560px"><h2>Acesso bloqueado</h2><div class="mut">Seu perfil (${esc(PAPEIS[papel()]||'sem perfil')}) não tem acesso a esta página. Se precisar, peça liberação ao administrador.</div>
  <div class="rodape" style="justify-content:flex-start"><button class="pri" onclick="ir('inicio')">Voltar ao início</button></div></div>`;}
const TELAS={};

// ---------- filtros globais ----------
function opcoes(lista,v,vazio,fv=x=>x.id,fn=x=>x.nome){return (vazio!=null?`<option value="">${esc(vazio)}</option>`:'')+lista.map(x=>`<option value="${esc(fv(x))}" ${String(fv(x))===String(v)?'selected':''}>${esc(fn(x))}</option>`).join('');}
function categorias(){return [...new Set(REF.produtos.map(p=>p.categoria).filter(Boolean))].sort();}
function barraFiltros(campos,aoMudar){
  const c=campos||['periodo','empresa','canal'];
  const h=[];
  if(c.includes('periodo'))h.push(`<div><label>De</label><input type="date" id="f_de" value="${F.de}"></div><div><label>Até</label><input type="date" id="f_ate" value="${F.ate}"></div>
    <div><label>Atalho</label><select id="f_at"><option value="">—</option><option value="hoje">Hoje</option><option value="mes">Este mês</option><option value="mesant">Mês anterior</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option><option value="ano">Este ano</option><option value="12m">Últimos 12 meses</option></select></div>`);
  if(c.includes('empresa'))h.push(`<div><label>Empresa</label><select id="f_emp">${opcoes(REF.empresas,F.empresa,'Todas')}</select></div>`);
  if(c.includes('unidade'))h.push(`<div><label>Unidade</label><select id="f_uni">${opcoes(REF.unidades,F.unidade,'Todas')}</select></div>`);
  if(c.includes('canal'))h.push(`<div><label>Canal</label><select id="f_can">${opcoes(Object.entries(CANAL).map(([id,nome])=>({id,nome})),F.canal,'Todos')}</select></div>`);
  if(c.includes('conta'))h.push(`<div><label>Conta ML</label><select id="f_cml">${opcoes(REF.contasML,F.conta,'Todas',x=>x.id,x=>x.apelido)}</select></div>`);
  if(c.includes('categoria'))h.push(`<div><label>Categoria</label><select id="f_cat">${opcoes(categorias().map(x=>({id:x,nome:x})),F.categoria,'Todas')}</select></div>`);
  if(c.includes('produto'))h.push(`<div><label>Produto</label><input id="f_prod" list="dl_prod" placeholder="Nome, código ou EAN" value="${esc(F.produto?nomeProd(F.produto):'')}"><datalist id="dl_prod">${REF.produtos.slice(0,3000).map(p=>`<option value="${esc(p.nome)}">`).join('')}</datalist></div>`);
  setTimeout(()=>{
    const m=()=>{F.de=val('f_de')||F.de;F.ate=val('f_ate')||F.ate;if($('f_emp'))F.empresa=val('f_emp');if($('f_uni'))F.unidade=val('f_uni');if($('f_can'))F.canal=val('f_can');if($('f_cml'))F.conta=val('f_cml');if($('f_cat'))F.categoria=val('f_cat');
      if($('f_prod')){const t=norm(val('f_prod'));F.produto=t?(REF.produtos.find(p=>norm(p.nome)===t)||{}).id||'':'';}aoMudar();};
    ['f_de','f_ate','f_emp','f_uni','f_can','f_cml','f_cat','f_prod'].forEach(id=>{if($(id))$(id).onchange=m;});
    if($('f_at'))$('f_at').onchange=()=>{const h=hojeISO(),v=val('f_at');
      if(v==='hoje'){F.de=h;F.ate=h;}if(v==='mes'){F.de=inicioMes(h);F.ate=h;}
      if(v==='mesant'){const fim=addDias(inicioMes(h),-1);F.de=inicioMes(fim);F.ate=fim;}
      if(v==='30'){F.de=addDias(h,-29);F.ate=h;}if(v==='90'){F.de=addDias(h,-89);F.ate=h;}
      if(v==='ano'){F.de=h.slice(0,4)+'-01-01';F.ate=h;}if(v==='12m'){F.de=inicioMes(addDias(inicioMes(h),-334));F.ate=h;}
      aoMudar();};
  },0);
  return `<div class="filtros">${h.join('')}</div>`;
}
function tsIni(d){return d+'T00:00:00'+offsetFuso();}
function tsFim(d){return d+'T23:59:59.999'+offsetFuso();}
function offsetFuso(){const f=fuso();if(f==='America/Sao_Paulo'||f==='America/Bahia'||f==='America/Fortaleza'||f==='America/Recife')return '-03:00';if(f==='America/Cuiaba'||f==='America/Manaus'||f==='America/Campo_Grande')return '-04:00';if(f==='America/Rio_Branco')return '-05:00';if(f==='America/Noronha')return '-02:00';return '-03:00';}

// ---------- carregamento de vendas (usado em várias telas) ----------
async function carregarVendas(de,ate,comItens=true){
  const sel='*'+(comItens?',fl_venda_itens(*'+(veCusto()?',fl_venda_itens_custo(*)':'')+')':'');
  return tudo(()=>sb.from('fl_vendas').select(sel).gte('data_venda',tsIni(de)).lte('data_venda',tsFim(ate)).order('data_venda',{ascending:false}));
}
function filtrarVendas(vs){return vs.filter(v=>(!F.empresa||v.empresa_id==F.empresa)&&(!F.canal||v.canal===F.canal)&&(!F.conta||v.ml_conta_id==F.conta)&&(!F.unidade||v.unidade_id==F.unidade)
  &&(!F.categoria&&!F.produto||(v.fl_venda_itens||[]).some(i=>{const p=produto(i.produto_id);return (!F.produto||i.produto_id===F.produto)&&(!F.categoria||(p&&p.categoria===F.categoria));})));}
function itensFiltrados(v){return (v.fl_venda_itens||[]).filter(i=>{const p=produto(i.produto_id);return (!F.produto||i.produto_id===F.produto)&&(!F.categoria||(p&&p.categoria===F.categoria));});}
function custoItem(i){const c=Array.isArray(i.fl_venda_itens_custo)?i.fl_venda_itens_custo[0]:i.fl_venda_itens_custo;return c||null;}
const CANAL={mercado_livre:'Mercado Livre',amazon:'Amazon',shopee:'Shopee',loja:'Loja física (Cuiabá)',outro:'Outro'};
const MODAL={full:'Full',flex:'Flex',agencia:'Agência',turbo:'Turbo',coleta:'Coleta',fba:'Amazon FBA',dba:'Amazon DBA',shopee_xpress:'Shopee Xpress',retirada:'Retirada',balcao:'Balcão',outra:'Outra'};
function tagModal(m){return m?`<span class="tag ${m==='flex'||m==='turbo'?'a':m==='full'||m==='fba'?'v':'b'}">${esc(MODAL[m]||m)}</span>`:'';}
function nomeConta(v){if(v.ml_conta_id)return 'ML · '+contaML(v.ml_conta_id).apelido;if(v.canal_conta_id){const c=REF.canalContas.find(x=>x.id==v.canal_conta_id);return (CANAL[v.canal]||'')+' · '+(c?c.apelido:'');}return (CANAL[v.canal]||'')+' · '+empresa(v.empresa_id).nome;}
const STATUS_V={concluida:['Concluída','v'],cancelada:['Cancelada','r'],devolvida:['Devolvida','r'],devolvida_parcial:['Devolução parcial','a'],pendente:['Pendente','a']};
function tagStatus(s){const x=STATUS_V[s]||[s,''];return `<span class="tag ${x[1]}">${esc(x[0])}</span>`;}

function modalSenha(){abrir(`<h2>Definir nova senha</h2><div class="campo"><label>Nova senha (mín. 8 caracteres)</label><input id="ms_s" type="password" minlength="8" autocomplete="new-password"></div><div class="erro"></div>
  <div class="rodape"><button onclick="fechar()">Cancelar</button><button class="pri" id="ms_ok">Salvar</button></div>`);
  $('ms_ok').onclick=()=>rodar($('ms_ok'),async()=>{const v=$('ms_s').value;if(v.length<8)throw new Error('A senha precisa ter ao menos 8 caracteres.');const {error}=await sb.auth.updateUser({password:v});if(error)throw error;fechar();toast('Senha salva.');});}
function novaChave(){return (crypto.randomUUID?crypto.randomUUID():'k'+Date.now().toString(36)+Math.random().toString(36).slice(2));}
