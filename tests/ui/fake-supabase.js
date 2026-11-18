// Cliente Supabase SIMULADO (somente para testes locais): envia as consultas ao servidor de teste.
(function(){
  const uid=()=>localStorage.getItem('fake_uid')||'';
  const ouvintes=[];
  async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return r.json();}
  class Q{
    constructor(t){this.q={table:t,op:'select',filters:[],order:[]};}
    select(s,o){if(this.q.op==='select'){this.q.select=s||'*';if(o&&o.head)this.q.head=true;}else this.q.ret=true;return this;}
    insert(v){this.q.op='insert';this.q.values=v;return this;} upsert(v,o){this.q.op='upsert';this.q.values=v;this.q.onConflict=o&&o.onConflict;return this;}
    update(v){this.q.op='update';this.q.values=v;return this;} delete(){this.q.op='delete';return this;}
    eq(c,v){this.q.filters.push([c,'eq',v]);return this;} neq(c,v){this.q.filters.push([c,'neq',v]);return this;} in(c,v){this.q.filters.push([c,'in',v]);return this;}
    gte(c,v){this.q.filters.push([c,'gte',v]);return this;} lte(c,v){this.q.filters.push([c,'lte',v]);return this;} gt(c,v){this.q.filters.push([c,'gt',v]);return this;} lt(c,v){this.q.filters.push([c,'lt',v]);return this;}
    ilike(c,v){this.q.filters.push([c,'ilike',v]);return this;} is(c,v){this.q.filters.push([c,'is',v]);return this;}
    order(c,o){this.q.order.push([c,!(o&&o.ascending===false)]);return this;} limit(n){this.q.limit=n;return this;} range(a,b){this.q.range=[a,b];return this;}
    single(){this.q.single=true;return this;} maybeSingle(){this.q.maybeSingle=true;return this;}
    then(ok,ko){return post('/api',{...this.q,uid:uid()}).then(r=>({data:r.data??null,error:r.error||null,count:r.count??null})).then(ok,ko);}
  }
  const sessao=()=>uid()?{user:{id:uid(),email:localStorage.getItem('fake_email')},access_token:'teste'}:null;
  window.supabase={createClient(){return {
    from:t=>new Q(t),
    rpc:(fn,args)=>post('/api',{op:'rpc',fn,args,uid:uid()}).then(r=>({data:r.data??null,error:r.error||null})),
    storage:{from:()=>({upload:async()=>({data:{},error:null}),createSignedUrl:async()=>({data:{signedUrl:'about:blank'},error:null})})},
    auth:{
      getSession:async()=>({data:{session:sessao()}}),
      onAuthStateChange(cb){ouvintes.push(cb);return {data:{subscription:{unsubscribe(){}}}};},
      async signInWithPassword({email}){const r=await post('/auth/login',{email});if(r.error)return {error:r.error};localStorage.setItem('fake_uid',r.user.id);localStorage.setItem('fake_email',r.user.email);
        ouvintes.forEach(cb=>cb('SIGNED_IN',sessao()));return {data:{session:sessao()},error:null};},
      async signOut(){localStorage.removeItem('fake_uid');ouvintes.forEach(cb=>cb('SIGNED_OUT',null));return {error:null};},
      async signUp(){return {data:{session:null},error:null};}, async resetPasswordForEmail(){return {error:null};},
      async updateUser(){return {data:{},error:null};},
      async signInWithOtp({email}){await post('/auth/otp',{email});window.__otp=(window.__otp||[]).concat(email);return {error:null};},
    }};}};
})();
