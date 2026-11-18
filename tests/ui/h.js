const {chromium}=require('/opt/npm-tools/node_modules/playwright');
const URL='http://localhost:8099/';
async function abrir(browser,email){
  const ctx=await browser.newContext({viewport:{width:1360,height:900}});const page=await ctx.newPage();
  page.erros=[];page.on('pageerror',e=>page.erros.push(e.message));page.on('console',m=>{if(m.type()==='error')page.erros.push(m.text());});
  page.on('dialog',d=>d.accept(page.respostaPrompt||'ok'));
  await page.goto(URL);await page.fill('#l_email',email);await page.fill('#l_senha','qualquer123');await page.click('#l_ok');
  await page.waitForSelector('#nav button',{timeout:8000});await page.waitForTimeout(300);return page;
}
module.exports={chromium,abrir,URL};
