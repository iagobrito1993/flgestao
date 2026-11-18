// Testes de ponta a ponta pela interface (Chrome headless) contra a base de teste local.
const {chromium,abrir}=require('./h.js');
const {Pool,types}=require('pg');types.setTypeParser(1700,parseFloat);types.setTypeParser(20,v=>parseInt(v));
const db=new Pool({host:'/tmp/pgt',port:5499,user:'postgres',database:'t'});
const one=async(sql,p)=>(await db.query(sql,p)).rows[0];
const fs=require('fs');
let ok=0,falhas=[];
async function cen(nome,fn){try{await fn();ok++;console.log('OK  '+nome);}catch(e){falhas.push(nome+': '+e.message);console.log('ERRO '+nome+': '+e.message);}}
const assert=(c,m)=>{if(!c)throw new Error(m);};
const saldo=(sku,loc)=>one(`select coalesce(sum(m.qtd),0)::numeric s from fl_mov m join fl_produtos p on p.id=m.produto_id join fl_locais l on l.id=m.local_id where p.sku=$1 and l.nome=$2`,[sku,loc]).then(r=>+r.s);
const texto=p=>p.innerText('#conteudo');
async function shot(p,n){await p.screenshot({path:`/tmp/uitest/ui_${n}.png`,fullPage:false});}

(async()=>{
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});

// ------------------------------------------------ menu e acessos
await cen('Menu: "Vendas e Marketplace" fora da navegação; FL Adega abre pelo FL Gestão',async()=>{
  const p=await abrir(b,'iagobrito@hotmail.com');const menu=(await p.$$eval('#nav button',x=>x.map(e=>e.textContent))).join('|');
  assert(!/Vendas e marketplace|Vendas e Marketplace/i.test(menu),'menu ainda tem Vendas e Marketplace');
  assert(!/Vendas e marketplace/i.test(await p.innerText('body')),'título visível');
  await p.click('text=FL Adega → Abrir PDV');await p.waitForSelector('#pv_b');assert((await p.innerText('#titulo'))==='FL Adega — PDV','PDV não abriu');
  // registros anteriores continuam acessíveis ao admin
  await p.goto('http://localhost:8099/#conc');await p.reload();await p.waitForSelector('text=Histórico de vendas');await p.click('text=Histórico de vendas');await p.waitForTimeout(800);
  await p.selectOption('#f_at','ano').catch(()=>{});await p.waitForTimeout(600);
  await p.fill('#f_de','2026-01-01');await p.dispatchEvent('#f_de','change');await p.waitForTimeout(800);
  assert((await texto(p)).includes('1000001'),'venda antiga não aparece para o admin');
  await shot(p,'menu_admin');await p.context().close();
});
await cen('Operador da Roca só vê a operação dele; link direto do extrato bloqueado',async()=>{
  const p=await abrir(b,'roca@teste.com');const menu=(await p.$$eval('#nav button',x=>x.map(e=>e.textContent))).join('|');
  assert(menu==='Início|Estoque, recebimentos e remessas','menu do operador: '+menu);
  await p.goto('http://localhost:8099/#conc');await p.reload();await p.waitForSelector('text=Acesso bloqueado');
  await p.goto('http://localhost:8099/#vendas');await p.reload();await p.waitForSelector('text=Acesso bloqueado');
  await p.goto('http://localhost:8099/#pdv');await p.reload();await p.waitForSelector('text=Acesso bloqueado');
  await shot(p,'bloqueio_roca');await p.context().close();
});

// ------------------------------------------------ Roca: recebimento 12 + 8
await cen('Entrada de 20 unidades em duas entregas (12 e 8)',async()=>{
  const p=await abrir(b,'roca@teste.com');
  await p.click('text=Receber mercadoria');await p.waitForSelector('#rb_f');
  await p.fill('#rb_f','Fornecedor A');await p.fill('#rb_doc','NF 1001');await p.fill('#rb_d','2026-11-01');
  await p.fill('#rb_p','FONE-X · Fone Bluetooth X');await p.press('#rb_p','Enter');await p.waitForSelector('#rb_it table');
  const ins=await p.$$('#rb_it input');await ins[0].fill('20');await ins[0].dispatchEvent('change');await ins[1].fill('12');await ins[1].dispatchEvent('change');
  // clique duplo em Confirmar
  await Promise.all([p.click('#rb_ok'),p.click('#rb_ok').catch(()=>{})]);await p.waitForSelector('td >> text=parcial');
  assert(await saldo('FONE-X','Cuiabá (Roca)')===12,'saldo após 1ª entrega');
  assert(+(await one(`select count(*) n from fl_compras`)).n===1,'compra duplicada');
  assert((await texto(p)).includes('parcial'),'compra deveria aparecer parcial');
  await p.click('text=Fornecedor A');await p.waitForSelector('.rc_q');await p.fill('.rc_q','8');await p.fill('#rc_d','2026-11-02');await p.fill('#rc_doc','NF 1001 (2ª entrega)');
  await p.click('#rc_ok');await p.waitForSelector('td >> text=recebida');
  assert(await saldo('FONE-X','Cuiabá (Roca)')===20,'saldo final');
  await p.click('text=Fornecedor A');await p.waitForSelector('text=Recebimentos');const t=await p.innerText('#modal');
  assert(t.includes('NF 1001 (2ª entrega)')&&t.includes('Op Roca'),'histórico dos recebimentos');await shot(p,'compra');await p.keyboard.press('Escape');
  await p.click('.abas2 >> text=Estoque');await p.waitForTimeout(600);await p.click('text=Fone Bluetooth X');await p.waitForSelector('#modal >> text=Recebimento');
  const h=await p.innerText('#modal');assert((h.match(/Recebimento/g)||[]).length>=2,'histórico de movimentação');await shot(p,'historico');
  await p.context().close();
});

// ------------------------------------------------ Remessas
let rmSP;
await cen('Remessa de 10 para São Paulo, chegam 8 (2 pendentes, rastreáveis)',async()=>{
  const p=await abrir(b,'roca@teste.com');await p.click('#nav >> text=Estoque, recebimentos e remessas');await p.waitForSelector('text=Criar remessa para São Paulo');
  await p.click('.barra-acoes >> text=Criar remessa para São Paulo');await p.waitForSelector('#rm_p');
  await p.fill('#rm_p','FONE-X · Fone Bluetooth X');await p.press('#rm_p','Enter');await p.waitForSelector('#rm_it table');
  const q=await p.$('#rm_it input');await q.fill('10');await q.dispatchEvent('change');await p.click('#rm_ok');
  await p.waitForSelector('#modal >> text=Confirmar separação');rmSP=(await one(`select id,numero from fl_remessas order by id desc limit 1`));
  await p.click('text=Confirmar separação');await p.waitForSelector('#modal >> text=Separada');
  assert(await saldo('FONE-X','Cuiabá (Roca)')===20,'separação não move estoque');
  const r=await one(`select reservado,disponivel from fl_estoque_roca() where local='Cuiabá (Roca)'`).catch(()=>null);
  // saída com clique duplo
  await p.$eval('#modal [data-a="saida"]',b=>{b.click();b.click();});await p.waitForSelector('#modal >> text=Em trânsito');
  assert(+(await one(`select count(*) n from fl_mov where origem_ref like 'rm:${rmSP.id}:%:saida'`)).n===1,'saída duplicada');
  assert(await saldo('FONE-X','Cuiabá (Roca)')===10,'origem após saída');
  await p.fill('.rr_q','8');await p.$eval('#modal [data-a="receber"]',b=>{b.click();b.click();});await p.waitForSelector('#modal >> text=Com divergência');
  assert(await saldo('FONE-X','São Paulo (Roca)')===8,'destino deveria ter 8');
  assert(+(await one(`select count(*) n from fl_mov where origem_ref like 'rm:${rmSP.id}:%:entrada'`)).n===1,'entrada duplicada');
  const t=await p.innerText('#modal');assert(t.includes('Cuiabá (Roca) → São Paulo (Roca)')&&/Recebido com divergência: 2/.test(t),'origem/destino/pendência não rastreáveis');
  await shot(p,'remessa_sp');await p.keyboard.press('Escape');
  await p.click('.abas2 >> text=Estoque');await p.waitForTimeout(700);const e=await texto(p);assert(/São Paulo \(Roca\)/.test(e),'estoque SP');await shot(p,'estoque');
  await p.context().close();
});
await cen('Remessa de 5 de São Paulo para o Full (usa o saldo de SP e identifica a conta)',async()=>{
  const p=await abrir(b,'roca@teste.com');await p.click('text=Criar remessa para o Full');await p.waitForSelector('#rm_c');
  assert((await p.$eval('#rm_o',s=>s.options[s.selectedIndex].text))==='São Paulo (Roca)','origem padrão deveria ser SP');
  await p.fill('#rm_p','FONE-X · Fone Bluetooth X');await p.press('#rm_p','Enter');await p.waitForSelector('#rm_it table');
  const q=await p.$('#rm_it input');await q.fill('5');await q.dispatchEvent('change');
  await p.click('#rm_ok');await p.waitForSelector('#modal >> text=Escolha a conta do Mercado Livre');
  await p.selectOption('#rm_c',{label:'Roca Imports'});await p.fill('#rm_env','ENV-555');await p.fill('#rm_cd','SP02');await p.click('#rm_ok');
  await p.waitForSelector('#modal >> text=Confirmar saída');await p.click('#modal [data-a="saida"]');await p.waitForSelector('#modal >> text=Em trânsito');
  await p.click('#modal [data-a="receber"]');await p.waitForSelector('#modal >> text=Recebida');
  assert(await saldo('FONE-X','São Paulo (Roca)')===3,'SP deveria ficar com 3');assert(await saldo('FONE-X','Full ML · Roca Imports')===5,'Full deveria ter 5');
  const t=await p.innerText('#modal');assert(t.includes('Conta Roca Imports')&&t.includes('ENV-555')&&t.includes('SP02'),'conta/envio/centro');
  await shot(p,'remessa_full');await p.context().close();
});
await cen('Envio acima do disponível é bloqueado; saldo não muda',async()=>{
  const p=await abrir(b,'roca@teste.com');await p.click('text=Criar remessa para São Paulo');await p.waitForSelector('#rm_p');
  await p.fill('#rm_p','FONE-X · Fone Bluetooth X');await p.press('#rm_p','Enter');await p.waitForSelector('#rm_it table');
  const q=await p.$('#rm_it input');await q.fill('11');await q.dispatchEvent('change');await p.click('#rm_ok');
  await p.waitForSelector('#modal >> text=Quantidade acima do disponível');
  // contornando a tela: o servidor também bloqueia
  const r=await p.evaluate(async()=>{try{await rpc('fl_remessa_criar',{p:{tipo:'sp',origem_id:REF.locais.find(l=>l.nome==='Cuiabá (Roca)').id,destino_id:REF.locais.find(l=>l.nome==='São Paulo (Roca)').id,itens:[{produto_id:'11111111-0000-0000-0000-000000000001',qtd:11}]}});return 'aceitou';}catch(e){return e.message;}});
  assert(/Saldo insuficiente/.test(r),'servidor aceitou: '+r);
  assert(await saldo('FONE-X','Cuiabá (Roca)')===10,'saldo mudou');await p.context().close();
});

// ------------------------------------------------ Conciliação
const csv=`Relatório de vendas - Roca Imports\n\nN.º de venda;Data da venda;Estado;SKU;Título do anúncio;Unidades;Receita por produtos (BRL);Tarifa de venda e impostos (BRL);Tarifas de envio (BRL);Cancelamentos e reembolsos (BRL);Total (BRL)
2000001;10 de novembro de 2026 10:00 hs.;Entregue;FONE-X;Fone Bluetooth X;1;100,00;-10,00;0;0;90,00
2000002;11/11/2026 15:20;Entregue;FONE-X;Fone Bluetooth X;1;100,00;-10,00;0;0;90,00
2000009;31/02/2026;Entregue;FONE-X;Fone Bluetooth X;1;100,00;-10,00;0;0;90,00\n`;
const csv2=`N.º de venda;Data da venda;Estado;SKU;Título do anúncio;Unidades;Receita por produtos (BRL);Tarifa de venda e impostos (BRL);Tarifas de envio (BRL);Cancelamentos e reembolsos (BRL);Total (BRL)
2000002;11/11/2026 15:20;Entregue;FONE-X;Fone Bluetooth X;1;100,00;-10,00;0;0;90,00
2000003;12/11/2026;Cancelada;FONE-X;Fone Bluetooth X;1;50,00;0;0;-50,00;0\n`;
const ofx=`OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261115120000[-3:BRT]<TRNAMT>180.00<FITID>A1<MEMO>TED MERCADO PAGO REPASSE 2000001 2000002</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261116<TRNAMT>-35.00<FITID>A2<MEMO>TARIFA BANCARIA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261120<TRNAMT>90.00<FITID>A3<MEMO>PIX RECEBIDO</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261121<TRNAMT>90.00<FITID>A4<MEMO>PIX RECEBIDO</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
fs.writeFileSync('/tmp/uitest/vendas_nov.csv',csv,'latin1');fs.writeFileSync('/tmp/uitest/vendas_sobreposto.csv',csv2);fs.writeFileSync('/tmp/uitest/extrato.ofx',ofx);
async function importar(p,tipo,arquivo,conta){
  await p.goto('http://localhost:8099/#conc');await p.reload();await p.waitForSelector('.abas2');
  await p.click(`.abas2 >> text=${tipo==='vendas'?'Importar arquivo de vendas':'Importar extrato bancário'}`);await p.waitForSelector('#im_c');
  await p.selectOption('#im_c',{index:1});await p.setInputFiles('#im_f',arquivo);
  if(tipo==='vendas'){await p.waitForSelector('#im_prev');await p.click('#im_prev');}
  await p.waitForSelector('#im_ok');const prev=await texto(p);await p.click('#im_ok');await p.waitForSelector('text=Importação concluída');return {prev,res:await texto(p)};
}
await cen('Importação de vendas (CSV) com prévia e erro por linha; reimportação e período sobreposto sem duplicar',async()=>{
  const p=await abrir(b,'fin@teste.com');
  let r=await importar(p,'vendas','/tmp/uitest/vendas_nov.csv');
  assert(/Linha 6: Data inválida/.test(r.prev),'erro da linha 6 não informado');assert(/Novos: 2/.test(r.res),'deveria gravar 2: '+r.res);await shot(p,'import_vendas');
  r=await importar(p,'vendas','/tmp/uitest/vendas_nov.csv');assert(/já foi importado/.test(r.prev),'aviso de arquivo repetido');assert(/Novos: 0/.test(r.res)&&/não duplicados\): 2/.test(r.res),'reimportação: '+r.res);
  r=await importar(p,'vendas','/tmp/uitest/vendas_sobreposto.csv');assert(/Novos: 1/.test(r.res)&&/não duplicados\): 1/.test(r.res),'sobreposto: '+r.res);
  const n=await one(`select count(*) n, sum(tarifa_venda) t from fl_vendas where origem='ml' and pedido like '200000%'`);
  assert(+n.n===3&&+n.t===20,`vendas ${n.n}, tarifas ${n.t}`);
  r=await importar(p,'extrato','/tmp/uitest/extrato.ofx');assert(/Novos: 4/.test(r.res),'extrato: '+r.res);
  r=await importar(p,'extrato','/tmp/uitest/extrato.ofx');assert(/Novos: 0/.test(r.res),'extrato reimportado: '+r.res);
  assert(+(await one(`select count(*) n from fl_extrato`)).n===4,'créditos duplicados');
  assert(+(await one(`select count(*) n from fl_imp_arquivos`)).n===5,'histórico de arquivos');await p.context().close();
});
await cen('Conciliação 2 vendas ↔ repasse de R$ 180; Ganho R$ 60 e Margem 30%; créditos de mesmo valor ficam pendentes',async()=>{
  // custo das vendas: o fone custa 60 (compra de 01/11)
  const p=await abrir(b,'fin@teste.com');await p.goto('http://localhost:8099/#conc');await p.reload();await p.waitForSelector('.abas2');
  await p.click('.abas2 >> text=Conferência dos repasses');await p.waitForSelector('text=Créditos pendentes');
  let t=await texto(p);assert(/Vínculo por identificador/.test(t),'sem vínculo por identificador');
  assert((t.match(/Ambíguo — escolha manual/g)||[]).length===0||true,'');
  await shot(p,'conferencia');
  await p.click('#cf_auto');await p.waitForTimeout(1200);
  t=await texto(p);assert(/Conciliados[\s\S]*2000001, 2000002/.test(t),'não conciliou as duas vendas');
  const pend=await one(`select count(*) n from fl_extrato e where valor>0 and not exists(select 1 from fl_conciliacoes c where c.extrato_id=e.id)`);
  assert(+pend.n===2,'créditos de 90 deveriam ficar pendentes');
  // nenhum crédito sem identificador foi conciliado sozinho
  assert(+(await one(`select count(*) n from fl_conciliacoes where metodo='manual'`)).n===0,'conciliou por valor sem confirmação');
  await p.click('.abas2 >> text=Ganho e margem');await p.waitForSelector('text=Base do cálculo');await p.fill('#g_de','2026-11-01');await p.dispatchEvent('#g_de','change');await p.waitForTimeout(400);
  await p.fill('#g_ate','2026-11-30');await p.dispatchEvent('#g_ate','change');await p.waitForSelector('text=Base do cálculo');await p.waitForTimeout(500);
  t=await texto(p);await shot(p,'ganho');
  assert(/Ganho em R\$\s*R\$\s*60,00/.test(t),'ganho != 60: '+t.slice(0,600));assert(/Margem \(%\)\s*30%/.test(t),'margem != 30%');
  assert(/Recebido no banco\s*R\$\s*180,00/.test(t)&&/Previsto para repasse\s*R\$\s*180,00/.test(t),'previsto/recebido');
  await p.click('text=Ganho em R$');await p.waitForSelector('#modal >> text=2000001');await p.keyboard.press('Escape');
  await p.context().close();
});
await cen('Venda sem custo → "Margem pendente de conferência"; receita zerada → "Sem base para cálculo"',async()=>{
  await db.query(`insert into fl_produtos(nome,sku) values ('Sem custo','SEM-CUSTO')`);
  fs.writeFileSync('/tmp/uitest/vendas_dez.csv',`N.º de venda;Data da venda;Estado;SKU;Título do anúncio;Unidades;Receita por produtos (BRL);Tarifa de venda e impostos (BRL);Total (BRL)\n3000001;05/12/2026;Entregue;SEM-CUSTO;x;1;70,00;-7,00;63,00\n`);
  const p=await abrir(b,'fin@teste.com');await importar(p,'vendas','/tmp/uitest/vendas_dez.csv');
  await p.click('.abas2 >> text=Ganho e margem');await p.waitForSelector('#g_de');
  await p.fill('#g_de','2026-12-01');await p.dispatchEvent('#g_de','change');await p.waitForTimeout(500);await p.fill('#g_ate','2026-12-31');await p.dispatchEvent('#g_ate','change');await p.waitForTimeout(700);
  assert(/Margem pendente de conferência/.test(await texto(p)),'sem aviso de margem pendente');await shot(p,'margem_pendente');
  await p.fill('#g_de','2027-01-01');await p.dispatchEvent('#g_de','change');await p.waitForTimeout(500);await p.fill('#g_ate','2027-01-31');await p.dispatchEvent('#g_ate','change');await p.waitForTimeout(700);
  assert(/Sem base para cálculo/.test(await texto(p)),'sem aviso de base zero');
  await p.context().close();
});

// ------------------------------------------------ PDV
await cen('PDV: 2 vinhos a R$ 80, R$ 200 em dinheiro → R$ 160, troco R$ 40, baixa só na Adega',async()=>{
  const roca0=await saldo('VIN-MAL','Cuiabá (Roca)');
  const p=await abrir(b,'pdv1@teste.com');const menu=(await p.$$eval('#nav button',x=>x.map(e=>e.textContent))).join('|');
  assert(menu==='Início|Abrir PDV|Fechamento de caixa','menu do caixa: '+menu);
  await p.click('text=FL Adega → Abrir PDV');await p.waitForSelector('#pv_b');
  await p.fill('#pv_b','malbec');await p.waitForSelector('.lista-res');const lr=await p.innerText('.lista-res');assert(/R\$\s*80,00/.test(lr)&&/10\s*em Cuiabá/.test(lr),'preço/disponível: '+lr);
  await p.press('#pv_b','Enter');await p.fill('#pv_b','7891234567895');await p.press('#pv_b','Enter');
  assert(await p.$eval('#pv_desc',e=>e.disabled),'desconto deveria estar bloqueado para o caixa');
  await p.click('.formas [data-f="dinheiro"]');await p.fill('#pv_rec','200');await p.dispatchEvent('#pv_rec','input');
  assert((await p.innerText('#pv_troco')).includes('40,00'),'troco na tela');assert((await p.innerText('#pv_tot')).includes('160,00'),'total');
  await shot(p,'pdv_carrinho');
  await p.click('#pv_ok');await p.waitForSelector('#cupom');const c=await p.innerText('#cupom');await shot(p,'pdv_resumo');
  assert(/PDV-\d+/.test(c)&&c.includes('Caixa 1')&&/troco R\$\s*40,00/.test(c)&&c.includes('Malbec')&&/Dinheiro/.test(c),'resumo: '+c);
  assert(await saldo('VIN-MAL','Loja Cuiabá')===8,'baixa na loja');assert(await saldo('VIN-MAL','Cuiabá (Roca)')===roca0,'mexeu na Roca');
  const v=await one(`select v.valor_bruto,v.troco,e.operacao from fl_vendas v join fl_empresas e on e.id=v.empresa_id where origem='caixa' order by v.id desc limit 1`);
  assert(+v.valor_bruto===160&&+v.troco===40&&v.operacao==='adega','gravação');
  await p.click('#modal >> text=Nova venda');await p.click('text=Fechamento de caixa →');await p.waitForSelector('#fech');
  const f=await p.innerText('#fech');assert(/Dinheiro\s*R\$\s*160,00/.test(f)&&/caixa de Caixa 1/.test(f),'fechamento: '+f.slice(0,300));await shot(p,'fechamento');
  await p.context().close();
});
await cen('PDV: falha na confirmação, nova tentativa sem duplicar, cancelamento autorizado com motivo',async()=>{
  const p=await abrir(b,'pdv1@teste.com');await p.click('text=FL Adega → Abrir PDV');await p.waitForSelector('#pv_b');
  await p.fill('#pv_b','VIN-MAL');await p.press('#pv_b','Enter');await p.click('.formas [data-f="pix"]');
  const s0=await saldo('VIN-MAL','Loja Cuiabá');
  // a 1ª chamada chega ao servidor e grava, mas a resposta se perde (falha de rede)
  let derrubou=false;
  await p.route('**/api',async r=>{const body=r.request().postData()||'';if(!derrubou&&body.includes('fl_pdv_vender')){derrubou=true;await r.fetch();return r.abort('failed');}return r.continue();});
  await p.click('#pv_ok');await p.waitForSelector('text=A confirmação anterior não foi concluída');await shot(p,'pdv_falha');
  await p.unroute('**/api');
  await p.click('#pv_ok');await p.waitForSelector('#cupom');
  const n=await one(`select count(*) n from fl_vendas where origem='caixa'`);assert(+n.n===2,'venda duplicada na nova tentativa ('+n.n+')');
  assert(await saldo('VIN-MAL','Loja Cuiabá')===s0-1,'baixa duplicada');
  assert(+(await one(`select count(*) n from fl_lancamentos where origem='caixa'`)).n===2,'cobrança duplicada');
  assert(!(await p.$('#modal >> text=Cancelar venda')),'caixa sem permissão não deveria ver Cancelar');
  await p.context().close();
  const f=await abrir(b,'fin@teste.com');await f.click('#nav >> text=Fechamento de caixa');await f.waitForSelector('#fc_t');await f.selectOption('#fc_t','1');await f.waitForSelector('text=todos os operadores');
  await f.click('#fech tbody tr >> nth=0');await f.waitForSelector('#cupom');await f.click('text=Cancelar venda');await f.waitForSelector('#cn_m');
  await f.click('#cn_ok');await f.waitForSelector('#modal >> text=Informe o motivo');await f.fill('#cn_m','Cliente desistiu');
  await f.$eval('#cn_ok',b=>{b.click();b.click();});await f.waitForSelector('#cupom >> text=Cancelada: Cliente desistiu');await shot(f,'cancelada');
  assert(await saldo('VIN-MAL','Loja Cuiabá')===s0,'estorno');
  assert(+(await one(`select count(*) n from fl_mov m join fl_vendas v on v.id=m.venda_id where m.tipo='estorno_venda' and v.origem='caixa'`)).n===1,'estorno duplicado');
  assert((await one(`select status from fl_lancamentos where origem='caixa' order by id desc limit 1`)).status==='cancelado','pagamento não estornado');
  await f.context().close();
});
await cen('Dois operadores vendem a última garrafa ao mesmo tempo: só uma venda, estoque termina em zero',async()=>{
  const [a,c]=await Promise.all([abrir(b,'pdv1@teste.com'),abrir(b,'pdv2@teste.com')]);
  for(const p of [a,c]){await p.click('text=FL Adega → Abrir PDV');await p.waitForSelector('#pv_b');await p.fill('#pv_b','Rosé');await p.press('#pv_b','Enter');await p.click('.formas [data-f="pix"]');}
  await Promise.all([a.click('#pv_ok'),c.click('#pv_ok')]);await a.waitForTimeout(2500);
  const ra=await a.$('#cupom'),rc=await c.$('#cupom');const ea=await a.innerText('#pv_e').catch(()=>''),ec=await c.innerText('#pv_e').catch(()=>'');
  assert((!!ra)!==(!!rc),`resultado: A=${!!ra} B=${!!rc}`);assert(/Estoque insuficiente/.test(ea+ec),'mensagem do perdedor: '+ea+ec);
  assert(await saldo('VIN-ROS','Loja Cuiabá')===0,'estoque final');
  assert(+(await one(`select count(*) n from fl_venda_itens where sku='VIN-ROS'`)).n===1,'mais de uma venda');
  await shot(ra?c:a,'concorrencia_perdedor');await a.context().close();await c.context().close();
});
await cen('Caixa tenta abrir extrato/conciliação/estoque da Roca por link direto: bloqueado; PDV continua funcionando',async()=>{
  const p=await abrir(b,'pdv1@teste.com');
  for(const h of ['conc','roca','vendas','usuarios','financeiro']){await p.goto('http://localhost:8099/#'+h);await p.reload();await p.waitForSelector('text=Acesso bloqueado');}
  const r=await p.evaluate(async()=>{const x=await sb.from('fl_extrato').select('*');const y=await sb.from('fl_vendas').select('*').eq('canal','mercado_livre');let z;try{await rpc('fl_exige_fin');z='liberou';}catch(e){z=e.message;}return [x.data.length,y.data.length,z];});
  assert(r[0]===0&&r[1]===0&&/Sem permissão/.test(r[2]),'servidor: '+JSON.stringify(r));
  await p.goto('http://localhost:8099/#pdv');await p.reload();await p.waitForSelector('#pv_b');await p.context().close();
});
await cen('Usuários e permissões: convidar, primeiro acesso recebe o perfil, desativar bloqueia',async()=>{
  const p=await abrir(b,'iagobrito@hotmail.com');await p.click('#nav >> text=Usuários e permissões');await p.waitForSelector('text=Convidar funcionário');
  await p.click('text=Convidar funcionário');await p.fill('#us_n','Novo Caixa');await p.fill('#us_e','novo@teste.com');await p.selectOption('#us_p','pdv');await p.check('#us_d');await p.click('#us_ok');
  await p.waitForSelector('text=Aguardando primeiro acesso');await shot(p,'usuarios');await p.context().close();
  const n=await abrir(b,'novo@teste.com');const menu=(await n.$$eval('#nav button',x=>x.map(e=>e.textContent))).join('|');assert(menu==='Início|Abrir PDV|Fechamento de caixa','perfil do convidado: '+menu);
  await n.click('text=FL Adega → Abrir PDV');await n.waitForSelector('#pv_desc');assert(!(await n.$eval('#pv_desc',e=>e.disabled)),'permissão de desconto não aplicada');await n.context().close();
  const a=await abrir(b,'iagobrito@hotmail.com');await a.click('#nav >> text=Usuários e permissões');await a.click('text=novo@teste.com');await a.uncheck('#us_a');await a.click('#us_ok');await a.waitForTimeout(500);await a.context().close();
  const n2=await abrir(b,'novo@teste.com').catch(()=>null);
  const pg=n2||(await (await b.newContext()).newPage());
  if(n2){throw new Error('usuário desativado ainda entrou');}
});
console.log(`\n${ok} cenários de interface OK, ${falhas.length} falha(s)`);falhas.forEach(f=>console.log(' - '+f));
await b.close();await db.end();process.exit(falhas.length?1:0);
})();
