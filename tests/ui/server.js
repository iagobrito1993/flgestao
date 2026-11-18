// Servidor de TESTE: serve o site e responde às chamadas do cliente Supabase simulado,
// executando no Postgres local como role "authenticated" (RLS ativo) com o usuário logado.
const http=require('http'),fs=require('fs'),path=require('path');
const {Pool,types}=require('pg');
types.setTypeParser(20,v=>parseInt(v,10));
types.setTypeParser(1700,v=>parseFloat(v));
types.setTypeParser(1082,v=>v);
const ts=v=>v.replace(' ','T').replace(/([+-]\d\d)$/,'$1:00');
types.setTypeParser(1184,ts);types.setTypeParser(1114,v=>v.replace(' ','T'));
const pool=new Pool({host:'/tmp/pgt',port:5499,user:'postgres',database:'t',max:10});
const SITE='/home/claude/flgestao';
const ID=/^[a-z_][a-z0-9_]*$/;
const id=s=>{if(!ID.test(s))throw new Error('identificador inválido: '+s);return '"'+s+'"';};
let fkCache={};
async function fkDe(c,filho,pai){
  const k=filho+'>'+pai;if(fkCache[k])return fkCache[k];
  const r=await c.query(`select a.attname col, af.attname ref from pg_constraint co join pg_attribute a on a.attrelid=co.conrelid and a.attnum=co.conkey[1]
    join pg_attribute af on af.attrelid=co.confrelid and af.attnum=co.confkey[1] where co.contype='f' and co.conrelid=$1::regclass and co.confrelid=$2::regclass limit 1`,[filho,pai]);
  if(!r.rows[0])throw new Error(`sem FK ${filho}→${pai}`);return fkCache[k]=r.rows[0];
}
// "*,a(*,b(*)),c(*)" → {cols:['*'], embeds:[{t:'a',sel:'*,b(*)'},...]}
function parseSel(s){s=(s||'*').replace(/\s/g,'');const cols=[],emb=[];let i=0,cur='';
  while(i<s.length){const ch=s[i];
    if(ch==='('){let d=1,j=i+1;while(d){if(s[j]==='(')d++;if(s[j]===')')d--;j++;}emb.push({t:cur,sel:s.slice(i+1,j-1)});cur='';i=j;if(s[i]===',')i++;continue;}
    if(ch===','){if(cur)cols.push(cur);cur='';i++;continue;}cur+=ch;i++;}
  if(cur)cols.push(cur);return {cols:cols.length?cols:['*'],emb};}
function where(filters,params){
  return (filters||[]).map(([c,op,v])=>{
    if(op==='eq'){if(v===null)return `${id(c)} is null`;params.push(v);return `${id(c)}=$${params.length}`;}
    if(op==='neq'){params.push(v);return `${id(c)}<>$${params.length}`;}
    if(op==='in'){params.push(v);return `${id(c)}=any($${params.length})`;}
    if(['gte','lte','gt','lt'].includes(op)){params.push(v);return `${id(c)}${{gte:'>=',lte:'<=',gt:'>',lt:'<'}[op]}$${params.length}`;}
    if(op==='ilike'){params.push(v);return `${id(c)} ilike $${params.length}`;}
    if(op==='is'){return `${id(c)} is ${v===null?'null':v?'true':'false'}`;}
    throw new Error('filtro '+op);}).join(' and ');}
async function embed(c,tabela,rows,sel){
  for(const e of sel.emb){
    const fk=await fkDe(c,e.t,tabela);const ids=[...new Set(rows.map(r=>r[fk.ref]))];
    const sub=parseSel(e.sel);
    const r=ids.length?(await c.query(`select ${sub.cols.map(x=>x==='*'?'*':id(x)).join(',')}${sub.cols.includes('*')?'':','+id(fk.col)} from ${id(e.t)} where ${id(fk.col)}=any($1)`,[ids])).rows:[];
    await embed(c,e.t,r,sub);
    rows.forEach(p=>p[e.t]=r.filter(x=>x[fk.col]===p[fk.ref]));
  }
}
async function pk(c,t){const r=await c.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid=$1::regclass and i.indisprimary`,[t]);return r.rows.map(x=>x.attname);}
async function executar(c,q){
  const params=[];
  if(q.op==='rpc'){
    const f=(await c.query(`select p.proretset, t.typtype, t.typname from pg_proc p join pg_type t on t.oid=p.prorettype where proname=$1 limit 1`,[q.fn])).rows[0];
    if(!f)throw new Error('função não encontrada '+q.fn);
    const tipos=(await c.query(`select unnest(proargnames) n, format_type(unnest(proargtypes),null) t from pg_proc where proname=$1`,[q.fn])).rows;
    const tp=k=>(tipos.find(x=>x.n===k)||{}).t||'';
    const args=Object.entries(q.args||{}).filter(([,v])=>v!==undefined).map(([k,v])=>{params.push(v!==null&&typeof v==='object'&&(/json/.test(tp(k))||!Array.isArray(v))?JSON.stringify(v):v);return `${id(k)}=>$${params.length}`;}).join(',');
    if(f.proretset){return (await c.query(`select * from ${id(q.fn)}(${args})`,params)).rows;}
    if(f.typtype==='c'){const r=(await c.query(`select (${id(q.fn)}(${args})).*`,params)).rows[0];return r&&Object.values(r).every(v=>v===null)?null:r;}
    return (await c.query(`select ${id(q.fn)}(${args}) as v`,params)).rows[0].v;
  }
  const t=q.table;
  if(q.op==='select'){
    const sel=parseSel(q.select);const w=where(q.filters,params);
    if(q.head){const r=await c.query(`select count(*)::int n from ${id(t)}${w?' where '+w:''}`,params);return {count:r.rows[0].n,data:null};}
    let sql=`select ${sel.cols.map(x=>x==='*'?'*':id(x)).join(',')} from ${id(t)}${w?' where '+w:''}`;
    if(q.order&&q.order.length)sql+=' order by '+q.order.map(([col,asc])=>`${id(col)} ${asc?'asc':'desc'} nulls last`).join(',');
    if(q.range){sql+=` limit ${(q.range[1]-q.range[0]+1)|0} offset ${q.range[0]|0}`;}else if(q.limit)sql+=` limit ${q.limit|0}`;
    const rows=(await c.query(sql,params)).rows;await embed(c,t,rows,sel);return rows;
  }
  const vals=Array.isArray(q.values)?q.values:[q.values];
  if(q.op==='insert'||q.op==='upsert'){
    const out=[];
    for(const v of vals){const ks=Object.keys(v).filter(k=>v[k]!==undefined);const ps=[];
      const vv=ks.map(k=>{ps.push(v[k]!==null&&typeof v[k]==='object'&&!Array.isArray(v[k])?JSON.stringify(v[k]):v[k]);return '$'+ps.length;});
      let sql=`insert into ${id(t)}(${ks.map(id).join(',')}) values (${vv.join(',')})`;
      if(q.op==='upsert'){const conf=q.onConflict?q.onConflict.split(','):await pk(c,t);const upd=ks.filter(k=>!conf.includes(k));
        sql+=` on conflict (${conf.map(id).join(',')}) do ${upd.length?'update set '+upd.map(k=>`${id(k)}=excluded.${id(k)}`).join(','):'nothing'}`;}
      sql+=' returning *';out.push(...(await c.query(sql,ps)).rows);}
    return out;
  }
  if(q.op==='update'){const v=vals[0];const ks=Object.keys(v).filter(k=>v[k]!==undefined);
    const sets=ks.map(k=>{params.push(v[k]!==null&&typeof v[k]==='object'&&!Array.isArray(v[k])?JSON.stringify(v[k]):v[k]);return `${id(k)}=$${params.length}`;});
    if(!sets.length)return [];const w=where(q.filters,params);
    return (await c.query(`update ${id(t)} set ${sets.join(',')}${w?' where '+w:''} returning *`,params)).rows;}
  if(q.op==='delete'){const w=where(q.filters,params);return (await c.query(`delete from ${id(t)}${w?' where '+w:''} returning *`,params)).rows;}
  throw new Error('op '+q.op);
}
const LOG=[];
http.createServer(async(req,res)=>{
  try{
    if(req.method==='POST'){
      let body='';for await(const ch of req)body+=ch;const q=JSON.parse(body||'{}');
      const c=await pool.connect();
      try{
        if(req.url==='/auth/login'){const r=await c.query('select id,email from auth.users where lower(email)=lower($1)',[q.email]);res.end(JSON.stringify(r.rows[0]?{user:r.rows[0]}:{error:{message:'Invalid login credentials'}}));return;}
        if(req.url==='/auth/otp'){await c.query(`insert into auth.users(id,email,raw_user_meta_data) values (gen_random_uuid(),$1,'{}') on conflict do nothing`,[q.email]);res.end('{}');return;}
        await c.query('begin');await c.query('set local role authenticated');await c.query(`select set_config('test.uid',$1,true)`,[q.uid||'']);
        const d=await executar(c,q);await c.query('commit');
        LOG.push({q:q.op+' '+(q.table||q.fn),ok:true});
        let data=d,count=null;if(q.op==='select'&&q.head){count=d.count;data=null;}
        if(q.single||q.maybeSingle){if(Array.isArray(data)){if(data.length!==1&&q.single){res.end(JSON.stringify({error:{message:'JSON object requested, multiple (or no) rows returned'}}));return;}data=data[0]||null;}}
        res.end(JSON.stringify({data,count}));
      }catch(e){await c.query('rollback').catch(()=>{});LOG.push({q:q.op+' '+(q.table||q.fn),err:e.message});res.end(JSON.stringify({error:{message:e.message,code:e.code}}));}
      finally{c.release();}
      return;
    }
    if(req.url==='/__log'){res.end(JSON.stringify(LOG.splice(0)));return;}
    let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
    if(p==='/fake-supabase.js')return res.end(fs.readFileSync(path.join(__dirname,'fake-supabase.js')));
    if(p==='/xlsx.js')return res.end(fs.readFileSync(path.join(__dirname,'node_modules/xlsx/dist/xlsx.full.min.js')));
    let f=fs.readFileSync(path.join(SITE,p));
    if(p==='/index.html'){f=f.toString().replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^"]*"><\/script>/,'<script src="/fake-supabase.js"></script>')
      .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx[^"]*"( defer)?><\/script>/,'<script src="/xlsx.js"></script>').replace(/<link[^>]*fonts\.g[^>]*>/g,'');res.setHeader('content-type','text/html; charset=utf-8');}
    else if(p.endsWith('.js'))res.setHeader('content-type','application/javascript; charset=utf-8');
    res.end(f);
  }catch(e){res.statusCode=404;res.end(String(e.message));}
}).listen(8099,()=>console.log('teste em http://localhost:8099'));
