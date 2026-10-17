const enc = s => encodeURIComponent(s);
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export default {async fetch(request,env){
  const origin=request.headers.get('Origin');
  const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
  if(origin&&!allowed.includes(origin)) return json({error:'Origin denied'},403);
  const headers={'Access-Control-Allow-Origin':origin||allowed[0]||'', 'Vary':'Origin','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Order-Token,X-Sync-Secret,X-Customer-JWT','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'};
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
  if(request.method==='POST'&&['/orders','/auth/login'].includes(new URL(request.url).pathname)&&env.RATE_LIMITER){const check=await env.RATE_LIMITER.limit({key:(request.headers.get('CF-Connecting-IP')||'unknown')+':'+new URL(request.url).pathname});if(!check.success)return new Response(JSON.stringify({error:'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่'}),{status:429,headers:{...headers,'Content-Type':'application/json'}});}
  const stub=env.STORE.get(env.STORE.idFromName('wanderer-central'));
  const result=await stub.fetch(request);
  const response=new Response(result.body,result);Object.entries(headers).forEach(([k,v])=>response.headers.set(k,v));return response;
}};
export class Store {
 constructor(state,env){this.state=state;this.env=env;}
 async fetch(request){return this.state.blockConcurrencyWhile(async()=>{try{return await this.route(request);}catch(e){return json({error:e.status?e.message:'Central server unavailable; check Worker logs'},e.status||502);}});}
 async aw(path,{method='GET',body,session}={}){
  const e=this.env;const headers={'X-Appwrite-Project':e.APPWRITE_PROJECT_ID};
  if(session) headers['X-Appwrite-Session']=session;else headers['X-Appwrite-Key']=e.APPWRITE_API_KEY;
  if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(e.APPWRITE_ENDPOINT.replace(/\/$/,'')+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=r.status===204?{}:await r.json(); if(!r.ok)throw Object.assign(new Error(data.message||'Appwrite error'),{status:r.status});return data;
 }
 base(table){return `/tablesdb/${enc(this.env.APPWRITE_DATABASE_ID)}/tables/${enc(table)}/rows`;}
 async row(table,id){try{return await this.aw(this.base(table)+'/'+enc(id));}catch(e){if(e.status===404)return null;throw e;}}
 async put(table,id,payload,existing){const data={payload:JSON.stringify(payload)};if(data.payload.length>3900000)fail('ข้อมูลหรือรูปภาพใหญ่เกินไป กรุณาลดขนาด');return this.aw(this.base(table)+(existing?'/'+enc(id):''),{method:existing?'PATCH':'POST',body:existing?{data}:{rowId:id,data,permissions:[]}});}
 async body(r){const t=await r.text();if(t.length>3900000)fail('ไฟล์ใหญ่เกินไป',413);try{return JSON.parse(t);}catch{fail('Invalid JSON');}}
 async admin(r){const token=(r.headers.get('Authorization')||'').replace(/^Bearer /,'');if(!token)fail('กรุณาเข้าสู่ระบบแอดมิน',401);const user=await this.aw('/account',{session:token});if(!(this.env.ADMIN_USER_IDS||'').split(',').map(s=>s.trim()).includes(user.$id))fail('ไม่มีสิทธิ์แอดมิน',403);return user;}
  async customer(r,{optional=false}={}){
    const jwt=r.headers.get('X-Customer-JWT');
    if(!jwt){if(optional)return null;fail('กรุณาเข้าสู่ระบบสมาชิก',401);}
    const response=await fetch(this.env.APPWRITE_ENDPOINT.replace(/\/$/,'')+'/account',{
      headers:{'X-Appwrite-Project':this.env.APPWRITE_PROJECT_ID,'X-Appwrite-JWT':jwt}
    });
    if(!response.ok)fail('เซสชันสมาชิกหมดอายุ กรุณาเข้าสู่ระบบใหม่',401);
    const user=await response.json();
    if(!user.$id)fail('ไม่สามารถตรวจสอบสมาชิก',401);
    return user;
  }
  available(pkg){
    const status=String(pkg.status??pkg.stockStatus??pkg.availability??'').trim().toLowerCase().replace(/[\s-]+/g,'_');
    if(['out_of_stock','not_ready','waiting','unavailable','notready','not_ready_to_send'].includes(status))return false;
    return pkg.inStock!==false && pkg.active!==false && pkg.isActive!==false;
  }
  calculateCart(c,input){
    const packs=Array.isArray(c.packages)?c.packages:[],apps=Array.isArray(c.apps)?c.apps:[],cats=Array.isArray(c.categories)?c.categories:[];
    const promos=c.promotions||{},combos=Array.isArray(promos.combos)?promos.combos:[];
    const tiers=promos.androidPrices||{3:90,6:170,9:250};
    const catIds=new Set(cats.filter(x=>/แอ[พป].*android|android.*แอ[พป]/i.test(x.name||'')).map(x=>String(x.id)));
    const appMap=new Map(apps.map(a=>[String(a.id),a]));
    const byApp=new Map();let subtotal=0;
    const items=input.map(i=>{
      const qty=Number(i.qty??i.quantity??1);
      if(!Number.isInteger(qty)||qty<1||qty>100)fail('จำนวนสินค้าไม่ถูกต้อง');
      if(i.promotionType==='combo'){
        const combo=combos.find(x=>String(x.id)===String(i.promotionId)&&x.enabled!==false);
        if(!combo||!Array.isArray(combo.packageIds)||combo.packageIds.length!==2)fail('โปรโมชั่นจับคู่ไม่พร้อมขาย');
        if(combo.packageIds.some(id=>!packs.some(p=>String(p.id)===String(id)&&this.available(p))))fail('แพ็กเกจในโปรโมชั่นไม่พร้อมขาย');
        const price=Number(combo.price);
        if(!Number.isFinite(price)||price<0)fail('ราคาโปรโมชั่นไม่ถูกต้อง');
        subtotal+=Math.round(price*100)*qty;
        return {id:'promo-combo-'+combo.id,name:String(combo.name||'โปรโมชั่นจับคู่'),appId:'promo-combo',appName:'โปรโมชั่นจับคู่',price,qty,promotionType:'combo',promotionId:combo.id,promotionPackageIds:combo.packageIds};
      }
      const pkg=packs.find(x=>String(x.id)===String(i.id));
      if(!pkg||!this.available(pkg))fail('สินค้าหมดหรือไม่พบสินค้า: '+String(i.id));
      const price=Number(pkg.price);
      if(!Number.isFinite(price)||price<0)fail('ราคาสินค้าไม่ถูกต้อง');
      subtotal+=Math.round(price*100)*qty;
      const app=appMap.get(String(pkg.appId));
      if(app&&catIds.has(String(app.categoryId))){
        const key=String(app.id),prev=byApp.get(key);
        if(!prev||price>prev.price)byApp.set(key,{id:key,price});
      }
      return {...pkg,qty};
    });
    const eligible=[...byApp.values()].sort((a,b)=>b.price-a.price),n=eligible.length,prefix=[0];
    eligible.forEach(x=>prefix.push(prefix.at(-1)+Math.round(x.price*100)));
    const dp=Array(n+1).fill(-Infinity);dp[0]=0;
    for(let i=0;i<=n;i++){
      if(!Number.isFinite(dp[i]))continue;
      if(i<n)dp[i+1]=Math.max(dp[i+1],dp[i]);
      for(const size of [3,6,9]){
        if(i+size>n)continue;
        const promo=Number(tiers[size]);
        if(!Number.isFinite(promo)||promo<0)continue;
        const discount=Math.max(0,prefix[i+size]-prefix[i]-Math.round(promo*100));
        dp[i+size]=Math.max(dp[i+size],dp[i]+discount);
      }
    }
    const total=Math.max(0,subtotal-Math.max(0,dp[n]));
    return {items,total:total/100,subtotal:subtotal/100,discount:Math.max(0,dp[n])/100};
  }
 async catalog(){const row=await this.row(this.env.CATALOG_TABLE_ID,'store');return row?JSON.parse(row.payload):null;}
 publicCatalog(p){const copy=structuredClone(p||{});for(const k of ['orders','cart','pendingCustomerRequirements','customerFeedbacks','isAdminLoggedIn','adminUser'])delete copy[k];if(copy.settings)for(const k of ['workerNotifyUrl','sheetBackupUrl','sheetAppsScriptUrl','syncToken','notificationHistory','syncHistory'])delete copy.settings[k];return copy;}
 async route(r){
  const u=new URL(r.url),p=u.pathname.replace(/\/$/,'')||'/',m=r.method,e=this.env;
  // Shared visitor counter. Uses existing Durable Object storage.
  if(p==='/visits'&&m==='GET'){
   return json({count:Number(await this.state.storage.get('visits:count')||0)});
  }
  if(p==='/visits'&&m==='POST'){
   const b=await this.body(r);
   if(typeof b.visitId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.visitId))fail('Invalid visit ID');
   const epoch=await this.state.storage.get('visits:epoch')||'initial';
   const seenKey='visits:seen:'+epoch+':'+b.visitId;
   let count=Number(await this.state.storage.get('visits:count')||0);
   if(!await this.state.storage.get(seenKey)){
    count++;
    await this.state.storage.put({[seenKey]:true,'visits:count':count});
   }
   return json({count});
  }
  if(p==='/visits/reset'&&m==='POST'){
   await this.admin(r);
   await this.state.storage.put({'visits:epoch':crypto.randomUUID(),'visits:count':0});
   return json({count:0});
  }
  if(p==='/health')return json({ok:true,backend:'appwrite'});
  if(p==='/auth/login'&&m==='POST'){
   const b=await this.body(r);const session=await this.aw('/account/sessions/email',{method:'POST',body:{email:b.email,password:b.password}});
   try{const user=await this.admin(new Request(r.url,{headers:{Authorization:'Bearer '+session.secret}}));return json({session:session.secret,user:{id:user.$id,email:user.email}});}catch(err){await this.aw('/account/sessions/current',{method:'DELETE',session:session.secret});throw err;}
  }
  if(p==='/auth/me'){const user=await this.admin(r);return json({user:{id:user.$id,email:user.email}});}
  if(p==='/auth/logout'&&m==='POST'){await this.admin(r);await this.aw('/account/sessions/current',{method:'DELETE',session:r.headers.get('Authorization').slice(7)});return json({ok:true});}
  if(p==='/catalog'&&m==='GET'){const c=await this.catalog();return json({payload:c?this.publicCatalog(c):null,updated_at:c?.updatedAt||null});}
  if(p==='/catalog'&&m==='PUT'){
   const sync=r.headers.get('X-Sync-Secret');if(!sync||sync!==e.SYNC_SHARED_SECRET)await this.admin(r);
   const b=await this.body(r),old=await this.row(e.CATALOG_TABLE_ID,'store');const current=old?JSON.parse(old.payload):null;
   if((b.expectedRevision??null)!==(current?.revision??null))fail('ข้อมูลร้านเปลี่ยนจากเครื่องอื่น กรุณาดึงข้อมูลล่าสุดก่อนบันทึก',409);
   const c={...this.publicCatalog(b.payload),revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};await this.put(e.CATALOG_TABLE_ID,'store',c,old);return json({payload:c,updated_at:c.updatedAt});
  }
  if(p==='/orders'&&m==='POST'){
   const b=await this.body(r),o=b.order;if(!o||!Array.isArray(o.items)||!o.items.length||o.items.length>100)fail('รายการสินค้าไม่ถูกต้อง');
   if(!/^[a-f0-9]{64}$/.test(b.token||''))fail('Missing order access token');
   if(!/^[A-Za-z0-9_-]{1,36}$/.test(o.id||''))fail('Order ID invalid');
   const old=await this.row(e.ORDERS_TABLE_ID,o.id);
   if(old){const saved=JSON.parse(old.payload);if(saved.token!==b.token)fail('Order ID exists',409);return json({order:this.customerOrder(saved)});}
   const c=await this.catalog();if(!c)fail('ยังไม่ได้นำเข้าสินค้าส่วนกลาง',503);
    const priced=this.calculateCart(c,o.items);
    if(!Number.isFinite(Number(o.total))||Math.round(Number(o.total)*100)!==Math.round(priced.total*100))fail('ราคาโปรโมชั่นเปลี่ยน กรุณารีเฟรชตะกร้าแล้วสั่งซื้อใหม่',409);
    const customer=await this.customer(r,{optional:true});
    const {items}=priced,total=priced.total;
   if(o.slipImg&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(o.slipImg))fail('รองรับสลิป PNG JPG WEBP เท่านั้น');
   const order={id:o.id,date:new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}),createdAt:new Date().toISOString(),items,total,paymentMethod:String(o.paymentMethod||''),source:String(o.source||'WEBSITE'),customerRequirements:o.customerRequirements||{},slipImg:o.slipImg||'',status:o.slipImg?'VERIFYING_SLIP':'AWAITING_PAYMENT',deliveryData:'',deliveryImages:[],revision:crypto.randomUUID(),token:b.token,...(customer?{userId:customer.$id}:{})};
   await this.put(e.ORDERS_TABLE_ID,order.id,order,false);if(customer){const key='customer:orders:'+customer.$id;const ids=await this.state.storage.get(key)||[];if(!ids.includes(order.id))await this.state.storage.put(key,[...ids,order.id]);}return json({order:this.customerOrder(order)},201);
  }
   if(p==='/customer/orders'&&m==='GET'){
    const user=await this.customer(r),ids=await this.state.storage.get('customer:orders:'+user.$id)||[];
    const orders=[];
    for(const id of ids.slice(-100).reverse()){
      const row=await this.row(e.ORDERS_TABLE_ID,id);
      if(!row)continue;
      const o=JSON.parse(row.payload);
      if(o.userId===user.$id)orders.push(this.customerOrder(o));
    }
    return json({orders});
   }
  if((p==='/orders'||p==='/sync/orders')&&m==='GET'){
   if(p==='/sync/orders'){if(!e.SYNC_SHARED_SECRET||r.headers.get('X-Sync-Secret')!==e.SYNC_SHARED_SECRET)fail('Unauthorized',403);}else await this.admin(r);const cursor=u.searchParams.get('cursor');const queries=[JSON.stringify({method:'limit',values:[25]}),JSON.stringify({method:'orderDesc',attribute:'$createdAt'})];if(cursor)queries.push(JSON.stringify({method:'cursorAfter',values:[cursor]}));
   const params=new URLSearchParams();queries.forEach(q=>params.append('queries[]',q));const result=await this.aw(this.base(e.ORDERS_TABLE_ID)+'?'+params);
   return json({orders:result.rows.map(x=>{const o=JSON.parse(x.payload);delete o.token;delete o.slipImg;delete o.deliveryImages;return o;}),cursor:result.rows.length===25?result.rows.at(-1).$id:null});
  }
  const match=p.match(/^\/orders\/([A-Za-z0-9_-]+)$/);
  if(match){const row=await this.row(e.ORDERS_TABLE_ID,match[1]);if(!row)fail('ไม่พบออเดอร์หรือไม่มีสิทธิ์',404);const order=JSON.parse(row.payload);
   if(m==='GET'){if(r.headers.get('Authorization')){await this.admin(r);const safe={...order};delete safe.token;return json({order:safe});}if(r.headers.get('X-Order-Token')!==order.token)fail('ไม่พบออเดอร์หรือไม่มีสิทธิ์',404);return json({order:this.customerOrder(order)});}
   if(m==='PATCH'){await this.admin(r);const b=await this.body(r);if(b.revision!==order.revision)fail('ออเดอร์เปลี่ยนจากเครื่องอื่น กรุณาเปิดใหม่ก่อนบันทึก',409);if(!['AWAITING_PAYMENT','VERIFYING_SLIP','PENDING','PROCESSING','READY_FOR_DELIVERY','COMPLETED','CANCELLED'].includes(b.status))fail('สถานะไม่ถูกต้อง');const next={...order,status:b.status,deliveryData:String(b.deliveryData||''),deliveryImages:b.deliveryImages||[],adminNote:String(b.adminNote||''),revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};await this.put(e.ORDERS_TABLE_ID,order.id,next,true);delete next.token;return json({order:next});}
  }
  fail('Not found',404);
 }
 customerOrder(o){const safe=structuredClone(o);delete safe.token;delete safe.adminNote;return safe;}
}
