// node tests/conc_logic.test.js
const assert=require('assert');
const C=require('../js/conc_logic.js');
let ok=0;const t=(nome,fn)=>{fn();ok++;console.log('OK  '+nome);};

t('valores em formato brasileiro',()=>{
  assert.strictEqual(C.valorBR('R$ 1.234,56'),1234.56);assert.strictEqual(C.valorBR('-12,30'),-12.3);assert.strictEqual(C.valorBR('(45,00)'),-45);
  assert.strictEqual(C.valorBR('1.234'),1234);assert.strictEqual(C.valorBR('10.5'),10.5);assert.strictEqual(C.valorBR(7),7);assert.ok(isNaN(C.valorBR('abc')));
});
t('datas brasileiras, ISO, ML e Excel',()=>{
  assert.deepStrictEqual(C.dataBR('10/11/2026 14:32'),{data:'2026-11-10',hora:'14:32'});
  assert.strictEqual(C.dataBR('10 de novembro de 2026 14:32 hs.').data,'2026-11-10');
  assert.strictEqual(C.dataBR('2026-11-10').data,'2026-11-10');
  assert.strictEqual(C.dataBR(46336).data,'2026-11-10');
  assert.strictEqual(C.dataBR('31/02/2026'),null);assert.strictEqual(C.dataBR('ontem'),null);
  assert.strictEqual(C.dataBR('20261110120000[-3:BRT]').data,'2026-11-10');
});
t('planilha do ML: cabeçalho, mapeamento, agrupamento por venda e erros por linha',()=>{
  const aoa=[['Relatório de vendas'],[],['N.º de venda','Data da venda','Estado','SKU','Título do anúncio','Unidades','Receita por produtos (BRL)','Tarifa de venda e impostos (BRL)','Tarifas de envio (BRL)','Cancelamentos e reembolsos (BRL)','Total (BRL)'],
    ['2000001','10 de novembro de 2026 10:00 hs.','Entregue','FONE-X','Fone',1,'100,00','-10,00','0','0','90,00'],
    ['2000002','11/11/2026','Entregue','FONE-X','Fone',1,'100,00','-10,00','0','0','90,00'],
    ['2000003','12/11/2026','Cancelada pelo comprador','FONE-X','Fone',1,'50,00','0','0','-50,00','0'],
    ['','12/11/2026','Entregue','X','x',1,'1','0','0','0','1'],
    ['2000004','99/99/2026','Entregue','X','x',1,'1','0','0','0','1'],
    ['2000005','12/11/2026','Entregue','X','x',1,'abc','0','0','0','1']];
  const h=C.acharCabecalho(aoa,C.CAMPOS_VENDA);assert.strictEqual(h,2);
  const map=C.mapearColunas(aoa[h],C.CAMPOS_VENDA);
  assert.strictEqual(map.pedido,0);assert.strictEqual(map.bruto,6);assert.strictEqual(map.liquido,10);assert.strictEqual(map.tarifa,7);
  const {vendas,erros}=C.lerVendas(aoa.slice(h+1),map,h+2);
  assert.strictEqual(vendas.length,3);
  assert.deepStrictEqual(vendas.map(v=>[v.pedido,v.status,v.bruto,v.tarifa,v.liquido]),[['2000001','concluida',100,10,90],['2000002','concluida',100,10,90],['2000003','cancelada',50,0,0]]);
  assert.deepStrictEqual(erros.map(e=>e.linha),[7,8,9]);
  assert.ok(/vazio/.test(erros[0].motivo)&&/Data inválida/.test(erros[1].motivo)&&/Valor vendido inválido/.test(erros[2].motivo));
});
t('extrato CSV: crédito/débito, saldo ignorado, chave estável para reimportação',()=>{
  const aoa=[['Data','Histórico','Documento','Crédito','Débito'],['15/11/2026','TED MERCADO PAGO','123','180,00',''],['15/11/2026','SALDO DO DIA','','',''],['16/11/2026','TARIFA','','','35,00'],['16/11/2026','TARIFA','','','35,00']];
  const map=C.mapearColunas(aoa[0],C.CAMPOS_EXTRATO);
  const a=C.lerExtratoPlanilha(aoa.slice(1),map,2),b=C.lerExtratoPlanilha(aoa.slice(1),map,2);
  assert.deepStrictEqual(a.linhas.map(l=>l.valor),[180,-35,-35]);
  assert.notStrictEqual(a.linhas[1].chave,a.linhas[2].chave);
  assert.deepStrictEqual(a.linhas.map(l=>l.chave),b.linhas.map(l=>l.chave));
});
t('OFX',()=>{
  const ofx=`OFXHEADER:100\n<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261115120000[-3:BRT]<TRNAMT>180.00<FITID>A1<MEMO>TED MERCADO PAGO</STMTTRN><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261116<TRNAMT>-35.00<FITID>A2<NAME>TARIFA</STMTTRN></BANKTRANLIST></OFX>`;
  const r=C.lerOFX(ofx);assert.strictEqual(r.linhas.length,2);assert.deepStrictEqual(r.linhas.map(l=>[l.data,l.valor,l.chave]),[['2026-11-15',180,'fit:A1'],['2026-11-16',-35,'fit:A2']]);
});
t('conciliação: 2 vendas de R$ 90 previstos ↔ 1 crédito de R$ 180',()=>{
  const v=[{id:1,pedido:'2000001',previsto:90,data_ref:'2026-11-15'},{id:2,pedido:'2000002',previsto:90,data_ref:'2026-11-15'}];
  let r=C.sugerir([{id:10,data:'2026-11-15',valor:180,descricao:'TED MERCADO PAGO REPASSE 2000001 2000002'}],v);
  assert.strictEqual(r[10].tipo,'identificador');assert.deepStrictEqual(r[10].vendas.sort(),[1,2]);
  r=C.sugerir([{id:10,data:'2026-11-15',valor:180,descricao:'TED MERCADO PAGO'}],v);
  assert.strictEqual(r[10].tipo,'valor');  // só valor/data: exige confirmação manual
});
t('dois créditos de mesmo valor → vínculo ambíguo fica pendente',()=>{
  const v=[{id:1,pedido:'2000001',previsto:90,data_ref:'2026-11-15'}];
  const r=C.sugerir([{id:10,data:'2026-11-15',valor:90,descricao:'PIX'},{id:11,data:'2026-11-16',valor:90,descricao:'PIX'}],v);
  assert.strictEqual(r[10].tipo,'ambigua');assert.strictEqual(r[11].tipo,'ambigua');assert.deepStrictEqual(r[10].vendas,[]);
  const v2=[{id:1,pedido:'2000001',previsto:90,data_ref:'2026-11-15'},{id:2,pedido:'2000002',previsto:90,data_ref:'2026-11-15'}];
  const r2=C.sugerir([{id:10,data:'2026-11-15',valor:90,descricao:'PIX'}],v2);assert.strictEqual(r2[10].tipo,'ambigua');
});
t('margem: 60/200 = 30%; receita zero; custo pendente; sinal negativo preservado',()=>{
  assert.deepStrictEqual(C.margem(60,200,false),{texto:null,valor:30});
  assert.deepStrictEqual(C.margem(0,0,false),{texto:'Sem base para cálculo',valor:null});
  assert.strictEqual(C.margem(10,100,true).texto,'Margem pendente de conferência');
  assert.strictEqual(C.margem(-25,100,false).valor,-25);
});
console.log(`\n${ok} testes de lógica passaram`);
