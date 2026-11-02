// WANDERER_SHOP Cloudflare D1 API — no Appwrite or Supabase
const respond=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});
const err=(msg,status=400)=>{throw Object.assign(new Error(msg),{status})};
const fail = err;
const clean=(v)=>JSON.parse(JSON.stringify(v));
const encode=s=>new TextEncoder().encode(s);
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const hash=async s=>hex(await crypto.subtle.digest('SHA-256',encode(s)));
const passwordHash=async(password,salt)=>hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encode(salt),iterations:100000},await crypto.subtle.importKey('raw',encode(password),'PBKDF2',false,['deriveBits']),256));
const token=()=>crypto.randomUUID()+'.'+crypto.randomUUID();
const safeCompare=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
class Shop {
 constructor(env){this.env=env;this.db=env.DB}
 async body(r){const t=await r.text();if(t.length>2500000)err('ข้อมูลใหญ่เกินไป',413);try{return JSON.parse(t)}catch{err('รูปแบบ JSON ไม่ถูกต้อง')}}
 async user(r,optional=false){const raw=(r.headers.get('Authorization')||r.headers.get('X-Customer-JWT')||'').replace(/^Bearer\s+/i,'');if(!raw){if(optional)return null;err('กรุณาเข้าสู่ระบบ',401)}const h=await hash(raw);const x=await this.db.prepare('SELECT users.id,users.email,users.name,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').bind(h,Date.now()).first();if(!x){if(optional)return null;err('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',401)}return x}
 async admin(r){const u=await this.user(r);if(u.role!=='admin')err('ไม่มีสิทธิ์แอดมิน',403);return u}
 publicCatalog(c){const x=clean(c||{});for(const k of ['orders','cart','pendingCustomerRequirements','customerFeedbacks','isAdminLoggedIn','adminUser','users','adminPassword'])delete x[k];if(x.settings)for(const k of ['workerNotifyUrl','sheetBackupUrl','sheetAppsScriptUrl','syncToken','notificationHistory','syncHistory','adminToken'])delete x.settings[k];return x}
 async catalog(){const c=await this.db.prepare('SELECT payload FROM catalog WHERE id=1').first();return c?JSON.parse(c.payload):null}
 async createSession(u){const t=token();await this.db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await hash(t),u.id,Date.now()+7*86400000).run();return t}
 async authCreate(b,role='customer'){const email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim(),pw=String(b.password||'');if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||pw.length<10||pw.length>128||name.length>120)err('อีเมลหรือรหัสผ่านไม่ถูกต้อง (อย่างน้อย 10 ตัวอักษร)');if(role==='customer'&&name.length<3)err('กรุณากรอกชื่ออย่างน้อย 3 ตัวอักษร');const id=crypto.randomUUID(),salt=crypto.randomUUID();try{await this.db.prepare('INSERT INTO users (id,email,name,password_hash,salt,role) VALUES (?,?,?,?,?,?)').bind(id,email,name||email,await passwordHash(pw,salt),salt,role).run()}catch(e){if(String(e).includes('UNIQUE'))err('อีเมลนี้ถูกใช้แล้ว',409);throw e}return {id,email,name:name||email,role}}
 customerOrder(o){const x=clean(o);delete x.token;delete x.adminNote;return x}
 async sheetSync(c){const e=this.env;if(!e.SHEETS_WEBAPP_URL||!e.SYNC_SHARED_SECRET)return {status:'not_configured'};const res=await fetch(e.SHEETS_WEBAPP_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'sync_catalog_to_sheets',syncToken:e.SYNC_SHARED_SECRET,updatedAt:c.updatedAt,categories:c.categories||[],apps:c.apps||[],packages:c.packages||[],formTemplates:c.formTemplates||{},idempotencyKey:c.revision})});const raw=await res.text();let result;try{result=JSON.parse(raw)}catch{throw Error('Google Apps Script response ไม่ใช่ JSON')}if(!res.ok||!result.success)throw Error(result.error||'Google Sheets sync failed');return {status:'saved',result}}
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

  async readSheetProductRows(){
    const e=this.env;
    if(!e.SHEETS_WEBAPP_URL||!e.SYNC_SHARED_SECRET)err('ยังไม่ได้กำหนด Google Sheets ใน Worker',503);
    const response=await fetch(e.SHEETS_WEBAPP_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'preview_catalog_from_sheets',syncToken:e.SYNC_SHARED_SECRET})});
    let data;try{data=await response.json()}catch{err('Apps Script ไม่ได้ตอบ JSON; กรุณาติดตั้งส่วนอ่านชีตก่อน',502)}
    if(!response.ok||!data.success||!Array.isArray(data.rows))err(data.error||'Apps Script ยังไม่รองรับ preview_catalog_from_sheets',502);
    if(data.rows.length>5000)err('ข้อมูลชีตมากเกินกว่าที่รองรับ',413);
    return data.rows;
  }
  compareSheets(c,rows){
    const apps=new Map((c.apps||[]).map(a=>[String(a.id),a]));
    const pkgMap=new Map((c.packages||[]).map(p=>[String(p.id),p]));
    const categories=new Map((c.categories||[]).map(x=>[String(x.id),x.name]));
    const changes=[],ignored=[],warnings=[];const ids=new Set();const sheetSamples=[];
    for(const row of rows){
      const id=String(row.id||'').trim();
      if(!id){ignored.push('แถวไม่มี ID');continue}
      if(ids.has(id))err('พบ ID ซ้ำใน Google Sheets: '+id,409);
      ids.add(id);
      if(sheetSamples.length<8)sheetSamples.push({id,tab:row.category,appName:row.appName,price:row.price,status:row.status});
      const old=pkgMap.get(id);
      if(!old){ignored.push('ไม่พบ ID ใน D1: '+id);continue}
      const app=apps.get(String(old.appId));
      if(!app||String(app.name).trim()!==String(row.appName||'').trim()||categories.get(String(app.categoryId))!==String(row.category||'').trim()){
        ignored.push('ไม่ตรง '+id+' | ชีต: '+String(row.category)+' / '+String(row.appName)+' | D1: '+String(categories.get(String(app?.categoryId))||'ไม่พบหมวด')+' / '+String(app?.name||'ไม่พบแอป'));continue;
      }
      const priceStr=String(row.price??'').replace(/[,฿\s]/g,'');
      const price=Number(priceStr);
      if(priceStr===''||!Number.isFinite(price)||price<0||price>10000000){ignored.push('ราคาไม่ถูกต้อง: '+id);continue}
      const raw=String(row.status||'').trim().toLowerCase().replace(/[\s-]/g,'_');
      const yes=['พร้อมส่ง','พร้อม','in_stock','ready','true','1','เปิดขาย'];
      const no=['ไม่พร้อมส่ง','หมด','หมดสต็อก','out_of_stock','not_ready','waiting','false','0','ปิดขาย'];
      if(!yes.includes(raw)&&!no.includes(raw)){ignored.push('สถานะไม่รู้จัก: '+id);continue}
      const inStock=yes.includes(raw);
      const sheetGroup=String(row.packageCategory||'').trim();
      // Column C is the storefront group title. Keep both legacy groupName and packageCategory in sync.
      const fields={price,inStock,status:inStock?'IN_STOCK':'OUT_OF_STOCK',name:String(row.packageName||'').trim(),description:String(row.description||'').trim(),packageCategory:sheetGroup,groupName:sheetGroup};
      // Column J optionally selects one of the configured customer-information templates.
      // Blank cells intentionally mean 'keep existing', not clear existing requirements.
      // Sheet J accepts human-readable template names; old IDs remain readable for compatibility.
      // Unknown/ambiguous names never overwrite the existing D1 customer form.
      const rawTemplate=String(row.customerRequirementTemplateId??'').trim();
      if(rawTemplate){
        const templates=[...(c.formTemplates?.customerRequirementTemplates||[])];
        for(const builtin of [{id:'crt-none',name:'ไม่ต้องรับข้อมูลเพิ่มเติม',fields:[]},{id:'crt-email-pass',name:'อีเมล / รหัสผ่าน',fields:[]},{id:'crt-uid',name:'UID',fields:[]}]){
          if(!templates.some(t=>String(t.id)===builtin.id))templates.push(builtin);
        }
        const normalized=x=>String(x??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('th-TH');
        const aliases={'อีเมล + รหัสผ่าน':'crt-email-pass','อีเมลและรหัสผ่าน':'crt-email-pass','email / password':'crt-email-pass','email + password':'crt-email-pass','ไม่ต้องรับข้อมูล':'crt-none','ไม่ต้องระบุข้อมูลเพิ่มเติม':'crt-none','ไม่ต้องระบุข้อมูล':'crt-none','ไม่ต้องระบุ':'crt-none','ไม่มี':'crt-none','none':'crt-none','uid เกม':'crt-uid'};
        const legacy=(rawTemplate.match(/\[([^\[\]]+)\]$/)||[])[1]||rawTemplate;
        const exactId=templates.find(t=>String(t.id)===legacy);
        const requestedName=normalized(rawTemplate);
        const matched=exactId?[exactId]:templates.filter(t=>normalized(t.name)===requestedName);
        if(!matched.length && aliases[requestedName])matched.push(...templates.filter(t=>t.id===aliases[requestedName]));
        if(matched.length!==1){
          warnings.push((matched.length?'ชื่อแบบฟอร์มซ้ำ: ':'ไม่พบแบบฟอร์มข้อมูลลูกค้า: ')+rawTemplate+' สำหรับ '+id+' — คงแบบฟอร์มเดิมใน D1');
        } else {
          const t=matched[0],requested=String(t.id);
          fields.customerRequirementTemplateId=requested;
          fields.requirementType=requested==='crt-email-pass'?'EMAIL_PASS':requested==='crt-uid'?'UID':(t.fields||[]).length?'CUSTOM':'NONE';
          fields.customerRequirementType=fields.requirementType;
          fields.customerFields=JSON.parse(JSON.stringify(t.fields||[]));
          fields.loginMethods=(t.loginOptions||[]).map(x=>x.key);
        }
      }
      if(!fields.name){ignored.push('ชื่อแพ็กเกจว่าง: '+id);continue}
      const fieldChanges={};
      for(const [k,v] of Object.entries(fields)){
        if(k==='status'){if(Boolean(old.inStock)!==inStock)fieldChanges.status={from:old.status||'',to:v};continue}
        if(k==='inStock'){if(Boolean(old.inStock)!==v)fieldChanges.inStock={from:old.inStock,to:v};continue}
        if(k==='price'){if(Number(old.price)!==v)fieldChanges.price={from:old.price,to:v};continue}
        if((v&&typeof v==='object'?JSON.stringify(v):String(v))!==(old[k]&&typeof old[k]==='object'?JSON.stringify(old[k]):String(old[k]??'')))fieldChanges[k]={from:old[k]??'',to:v};
      }
      if(Object.keys(fieldChanges).length)changes.push({id,appName:app.name,category:String(categories.get(String(app.categoryId))||""),fields:fieldChanges,values:fields});
    }
    return {changes,ignored,warnings,checked:ids.size,sheetSamples};
  }
  defaultPointsConfig(){return {enabled:true, categoryPoints:{'แอพพรีเมี่ยม':10,'เติมเกม':15},slipPoints:1,rewards:[],slipAutoDelete:true,slipRetentionDays:3}}
  async pointsConfig(){const x=await this.db.prepare("SELECT value FROM shop_feature_config WHERE key='points_v1'").first();if(!x)return this.defaultPointsConfig();try{return {...this.defaultPointsConfig(),...JSON.parse(x.value)}}catch{return this.defaultPointsConfig()}}
  async pointsBalance(userId){const row=await this.db.prepare('SELECT COALESCE(SUM(delta),0) AS balance FROM point_events WHERE user_id=?').bind(userId).first();return Number(row?.balance||0)}
  v2Defaults(){return {enabled:false,slipAutoDelete:true,slipRetentionDays:3, thresholds:{premium:10,game:15}, cardTypes:[{id:'premium',name:'⭐ แอพ / นิยาย'},{id:'game',name:'🎮 เติมเกม'}], cards:{premium:{mode:'same',images:[],filledImage:'',emptyImage:''},game:{mode:'same',images:[],filledImage:'',emptyImage:''}}, categoryEarnPoints:{},categoryDescriptions:{},categoryCardMap:{'แอพพรีเมี่ยม':'premium','เติมเหรียญนิยาย':'premium','เติมเกม':'game','แอพตัดต่อ-AI':'','สติ๊กเกอร์ไลน์':'','แอพ Android':''},rewardGroups:[{id:'grp_premium',type:'premium',name:'รางวัลแอพ/นิยาย',options:['สติกเกอร์ LINE 50 Coins','WeTV 30 วัน','Viu 30 วัน','iQIYI 7 วัน','Netflix 3 วัน','Disney+ 1 วัน','YouTube ตามเงื่อนไขร้าน','ส่วนลด 10–20 บาท'],active:true},{id:'grp_game',type:'game',name:'รางวัลเติมเกม',options:['สติกเกอร์ LINE 50 Coins','WeTV 30 วัน','Viu 30 วัน','iQIYI 7 วัน','ส่วนลด 10–20 บาท','แพ็กเล็กของเกมที่เติมประจำ'],active:true}]}}
  async v2Config(){const x=await this.db.prepare("SELECT value FROM shop_feature_config WHERE key='points_v2'").first();const defaults=this.v2Defaults();if(!x)return defaults;try{const saved=JSON.parse(x.value);return {...defaults,...saved,cardTypes:Array.isArray(saved.cardTypes)&&saved.cardTypes.length?saved.cardTypes:defaults.cardTypes}}catch{return defaults}}
  async v2View(owner){const cfg=await this.v2Config();const progress=await this.db.prepare('SELECT type, COALESCE(SUM(remaining_points),0) AS stamps FROM points_v2_stamps WHERE owner_id=? AND ticket_id IS NULL GROUP BY type').bind(owner).all();const tickets=await this.db.prepare("SELECT id,type,earned_at,expires_at,status,reward_name FROM points_v2_tickets WHERE owner_id=? ORDER BY earned_at DESC LIMIT 100").bind(owner).all();const activity=await this.db.prepare('SELECT type,order_id,points,created_at FROM points_v2_stamps WHERE owner_id=? ORDER BY created_at DESC LIMIT 50').bind(owner).all();return {config:{thresholds:cfg.thresholds,cardTypes:cfg.cardTypes,cards:cfg.cards,rewardGroups:cfg.rewardGroups,enabled:cfg.enabled},progress:Object.fromEntries((progress.results||[]).map(x=>[x.type,x.stamps])),tickets:tickets.results||[],activity:activity.results||[]}}
  eligiblePaidOrder(o){return ['READY_FOR_DELIVERY','COMPLETED'].includes(o.status) && (o.source==='LINE' ? (o.linePaidConfirmed===true&&o.lineDeliveredConfirmed===true&&!!o.lineApprovedBy) : true)}
  orderPointTypes(o,catalog,cfg){if(o.source==='LINE'&&o.linePaidConfirmed===true&&o.lineDeliveredConfirmed===true)return (cfg.cardTypes||[]).some(t=>t.id===o.lineCardType)?[o.lineCardType]:[];const apps=new Map((catalog?.apps||[]).map(a=>[String(a.id),a]));const cats=new Map((catalog?.categories||[]).map(c=>[String(c.id),String(c.name)]));const types=new Set();for(const item of o.items||[]){const cat=cats.get(String(apps.get(String(item.appId))?.categoryId))||'';const mapped=cfg.categoryCardMap?.[cat]??(cat==='เติมเกม'?'game':(['แอพพรีเมี่ยม','เติมเหรียญนิยาย'].includes(cat)?'premium':''));if((cfg.cardTypes||[]).some(t=>t.id===mapped))types.add(mapped)}return [...types]}
  orderPointAmount(o,catalog,cfg,type){if(o.source==='LINE'&&o.lineCardType===type)return Number(o.linePointAmount||1);const apps=new Map((catalog?.apps||[]).map(a=>[String(a.id),a]));const cats=new Map((catalog?.categories||[]).map(c=>[String(c.id),String(c.name)]));let amount=0;for(const item of o.items||[]){const name=cats.get(String(apps.get(String(item.appId))?.categoryId))||'';if(cfg.categoryCardMap?.[name]===type){const n=Number(cfg.categoryEarnPoints?.[name]??1);if(Number.isInteger(n)&&n>=1&&n<=15)amount=Math.max(amount,n)}}return amount}
  async v2Award(o,owner){if(!owner||!this.eligiblePaidOrder(o))return;const cfg=await this.v2Config();if(!cfg.enabled)return;const catalog=await this.catalog();const types=this.orderPointTypes(o,catalog,cfg);if(types.length!==1)return;const type=types[0],amount=this.orderPointAmount(o,catalog,cfg,type);if(!amount)return;const id='approved:'+o.id;const saved=await this.db.prepare('INSERT OR IGNORE INTO points_v2_stamps(id,owner_id,order_id,type,points,remaining_points) VALUES(?,?,?,?,?,?)').bind(id,owner,o.id,type,amount,amount).run();if(saved.meta?.changes)await this.v2Issue(owner,type,cfg)}
  async v2Issue(owner,type,cfg){const required=Number(cfg.thresholds?.[type]??(type==='game'?15:10));if(!Number.isInteger(required)||required<1||required>100)err('threshold invalid');for(let cycle=0;cycle<10;cycle++){const available=await this.db.prepare('SELECT id,remaining_points FROM points_v2_stamps WHERE owner_id=? AND type=? AND ticket_id IS NULL AND remaining_points>0 ORDER BY created_at,id LIMIT 200').bind(owner,type).all();let total=(available.results||[]).reduce((a,x)=>a+Number(x.remaining_points||0),0);if(total<required)return;const ticketId=crypto.randomUUID(),earned=new Date(),expires=new Date(earned);expires.setUTCMonth(expires.getUTCMonth()+2);let need=required;const updates=[];for(const x of available.results){if(!need)break;const before=Number(x.remaining_points);const used=Math.min(need,before);updates.push(this.db.prepare('UPDATE points_v2_stamps SET remaining_points=? WHERE id=? AND remaining_points=? AND ticket_id IS NULL').bind(before-used,x.id,before));need-=used}const done=await this.db.batch([...updates,this.db.prepare('INSERT INTO points_v2_tickets(id,owner_id,type,earned_at,expires_at,status) VALUES(?,?,?,?,?,?)').bind(ticketId,owner,type,earned.toISOString(),expires.toISOString(),'AVAILABLE')]);if(done.slice(0,-1).some(x=>x.meta?.changes!==1))throw Error('แต้มเปลี่ยนระหว่างออกสิทธิ์ กรุณาตรวจประวัติบัตร')}}

 async route(r){const u=new URL(r.url),p=u.pathname.replace(/\/$/,'')||'/',m=r.method;
 // Public reviews saved centrally; D1 migration is required before deployment.
 if(p==='/reviews'&&m==='GET'){
   const rows=await this.db.prepare('SELECT id,author,rating,text,created_at FROM shop_reviews WHERE hidden=0 ORDER BY created_at DESC LIMIT 100').all();
   return respond({reviews:(rows.results||[]).map(x=>({id:x.id,author:x.author,rating:x.rating,text:x.text,date:x.created_at,hidden:false}))});
 }
 if(p==='/reviews'&&m==='POST'){
   const b=await this.body(r),author=String(b.author||'').trim(),bodyText=String(b.text||'').trim(),rating=Number(b.rating);
   if(author.length<2||author.length>60||bodyText.length<4||bodyText.length>700||!Number.isInteger(rating)||rating<1||rating>5)err('ชื่อ รีวิว หรือคะแนนไม่ถูกต้อง');
   const id='db-'+crypto.randomUUID();
   await this.db.prepare('INSERT INTO shop_reviews(id,author,rating,text) VALUES(?,?,?,?)').bind(id,author,rating,bodyText).run();
   return respond({success:true,id},201);
 }
 if(p==='/admin/reviews'&&m==='GET'){
   await this.admin(r);const rows=await this.db.prepare('SELECT id,author,rating,text,hidden,created_at FROM shop_reviews ORDER BY created_at DESC LIMIT 200').all();
   return respond({reviews:(rows.results||[]).map(x=>({id:x.id,author:x.author,rating:x.rating,text:x.text,hidden:!!x.hidden,date:x.created_at}))});
 }
 if(p.startsWith('/admin/reviews/')&&(m==='PATCH'||m==='DELETE')){
   await this.admin(r);const id=decodeURIComponent(p.slice('/admin/reviews/'.length));
   if(!/^db-[a-f0-9-]{36}$/.test(id))err('Review ID invalid');
   const result=m==='PATCH'?await this.db.prepare('UPDATE shop_reviews SET hidden=CASE WHEN hidden=0 THEN 1 ELSE 0 END WHERE id=?').bind(id).run():await this.db.prepare('DELETE FROM shop_reviews WHERE id=?').bind(id).run();
   if(!result.meta?.changes)err('ไม่พบรีวิว',404);return respond({success:true});
 }
 if(p==='/health')return respond({ok:true,backend:'cloudflare-d1'});
 if(p==='/auth/bootstrap'&&m==='POST'){if(!this.env.ADMIN_BOOTSTRAP_SECRET||!safeCompare(r.headers.get('X-Bootstrap-Secret'),this.env.ADMIN_BOOTSTRAP_SECRET))err('Unauthorized',403);const already=await this.db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();if(already)err('มีบัญชีแอดมินแล้ว',409);return respond({user:await this.authCreate(await this.body(r),'admin')},201)}
 if(p==='/auth/register'&&m==='POST'){
    const b=await this.body(r);
    const username=String(b.username||'').trim().normalize('NFKC').toLowerCase();
    if(!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username))err('ชื่อผู้ใช้ต้องมี 3–32 ตัวอักษร ใช้อักษร ตัวเลข จุด ขีดกลาง หรือขีดล่างได้');
    // Store a private internal login key in the existing NOT NULL email column.
    // No email address is requested from, or sent to, a customer.
    const internalEmail=username+'@members.wanderer.invalid';
    const old=await this.db.prepare('SELECT id FROM users WHERE email=?').bind(internalEmail).first();
    if(old)err('ชื่อผู้ใช้นี้มีคนใช้แล้ว',409);
    const user=await this.authCreate({email:internalEmail,name:username,password:b.password},'customer');
    return respond({user:{id:user.id,name:user.name,username:user.name,role:user.role}},201);
  }
 if(p==='/auth/login'&&m==='POST'){
    const b=await this.body(r);
    const typed=String(b.username||b.email||'').trim().normalize('NFKC').toLowerCase();
    const loginKey=typed.includes('@')?typed:typed+'@members.wanderer.invalid';
    const user=await this.db.prepare('SELECT * FROM users WHERE email=?').bind(loginKey).first();
    if(!user||!safeCompare(await passwordHash(String(b.password||''),user.salt),user.password_hash))err('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',401);
    const session=await this.createSession(user);
    return respond({session,user:{id:user.id,$id:user.id,email:user.email,name:user.name,username:user.name,role:user.role}});
  }
 if(p==='/auth/me'){const x=await this.user(r);return respond({user:{id:x.id,$id:x.id,email:x.email,name:x.name,role:x.role}})}
 if(p==='/auth/logout'&&m==='POST'){const raw=(r.headers.get('Authorization')||r.headers.get('X-Customer-JWT')||'').replace(/^Bearer\s+/i,'');if(raw)await this.db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(raw)).run();return respond({ok:true})}
 if(p==='/visits'&&m==='GET'){const n=await this.db.prepare('SELECT COUNT(*) AS count FROM visitors').first();return respond({count:n?.count||0})}
 if(p==='/visits'&&m==='POST'){const b=await this.body(r);if(!/^[a-f\d-]{36}$/i.test(String(b.visitId||'')))err('Invalid visit ID');await this.db.prepare('INSERT OR IGNORE INTO visitors (id) VALUES (?)').bind(b.visitId).run();return respond({count:(await this.db.prepare('SELECT count(*) AS count FROM visitors').first()).count})}
 if(p==='/visits/reset'&&m==='POST'){await this.admin(r);await this.db.prepare('DELETE FROM visitors').run();return respond({count:0})}
  if(p==='/admin/points/v2'&&m==='GET'){await this.admin(r);return respond({config:await this.v2Config()})}
  if(p==='/admin/points/v2'&&m==='PUT'){
    await this.admin(r);const b=await this.body(r),old=await this.v2Config(),c=b.config||{};
    const cardTypes=Array.isArray(c.cardTypes)?c.cardTypes.map(t=>({id:String(t.id||''),name:String(t.name||'').trim()})):old.cardTypes;
    if(cardTypes.length<2||cardTypes.length>20||cardTypes.some(t=>!/^[a-z][a-z0-9_]{1,39}$/.test(t.id)||!t.name||t.name.length>70)||new Set(cardTypes.map(t=>t.id)).size!==cardTypes.length||!cardTypes.some(t=>t.id==='premium')||!cardTypes.some(t=>t.id==='game'))err('ประเภทบัตรต้องมี 2 บัตรเดิม รหัสไม่ซ้ำ และสูงสุด 20 ประเภท');
    const typeIds=new Set(cardTypes.map(t=>t.id));const thresholds={};for(const t of cardTypes){const raw=c.thresholds?.[t.id]??old.thresholds?.[t.id]??10;const n=Number(raw);if(!Number.isInteger(n)||n<1||n>100)err('แต้มครบแลกรางวัลต้องอยู่ระหว่าง 1–100: '+t.name);thresholds[t.id]=n}
    const groups=Array.isArray(c.rewardGroups)?c.rewardGroups:[];
    if(groups.length>30)err('จำนวนชุดรางวัลเกินกำหนด');
    const rewardGroups=groups.map(x=>({id:String(x.id||''),type:String(x.type||''),name:String(x.name||'').trim(),options:Array.isArray(x.options)?x.options.map(v=>String(v).trim()).filter(Boolean):[],active:x.active!==false}));
    if(rewardGroups.some(x=>!/^[a-zA-Z0-9_-]{1,80}$/.test(x.id)||!(typeIds.has(x.type)||x.type==='both')||!x.name||x.name.length>100||x.options.length<1||x.options.length>30||x.options.some(y=>y.length>100))||new Set(rewardGroups.map(x=>x.id)).size!==rewardGroups.length)err('รูปแบบชุดรางวัลไม่ถูกต้อง');
    const days=Number(c.slipRetentionDays);if(!Number.isInteger(days)||days<1||days>365)err('วันเก็บสลิปไม่ถูกต้อง');
    const cards={};for(const {id:t} of cardTypes){const v=c.cards?.[t]||{};const mode=String(v.mode||'same');if(!['same','cycle','custom'].includes(mode))err('โหมดรูปไม่ถูกต้อง');const images=Array.isArray(v.images)?v.images.map(x=>String(x).trim()):[];if(images.length>15||images.some(x=>x&&!/^https:\/\//.test(x)||x.length>500))err('ใช้ URL รูป HTTPS เท่านั้น');cards[t]={mode,images,filledImage:'',emptyImage:''}}
    const categoryCardMap={...old.categoryCardMap};const catalog=await this.catalog();const allowed=new Set((catalog?.categories||[]).map(x=>String(x.name)));for(const [name,t] of Object.entries(c.categoryCardMap||{})){if(!allowed.has(name)||!(typeIds.has(String(t))||String(t)===''))err('กำหนดบัตรของหมวดไม่ถูกต้อง: '+name);categoryCardMap[name]=String(t)}
     const categoryEarnPoints={...old.categoryEarnPoints},categoryDescriptions={...old.categoryDescriptions};for(const name of allowed){const n=Number(c.categoryEarnPoints?.[name]??old.categoryEarnPoints?.[name]??1);if(!Number.isInteger(n)||n<1||n>15)err('จำนวนแต้มต้องเป็น 1–15: '+name);categoryEarnPoints[name]=n;const d=String(c.categoryDescriptions?.[name]??old.categoryDescriptions?.[name]??'').trim();if(d.length>500)err('รายละเอียดหมวดยาวเกิน 500 ตัวอักษร: '+name);categoryDescriptions[name]=d}const next={...old,enabled:c.enabled===true,cardTypes,thresholds,rewardGroups,cards,categoryCardMap,categoryEarnPoints,categoryDescriptions,slipAutoDelete:c.slipAutoDelete!==false,slipRetentionDays:days};
    await this.db.prepare("INSERT INTO shop_feature_config(key,value) VALUES('points_v2',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(next)).run();return respond({success:true,config:next});
  }
  if(p==='/points/v2/me'&&m==='GET'){const user=await this.user(r);return respond(await this.v2View('member:'+user.id))}
  if(p==='/points/v2/guest/create'&&m==='POST'){
    if(!(await this.v2Config()).enabled)err('ระบบบัตรแต้มยังไม่เปิด',403);
    const raw=token()+token(),id=crypto.randomUUID();await this.db.prepare('INSERT INTO points_v2_guests(id,secret_hash) VALUES(?,?)').bind(id,await hash(raw)).run();return respond({cardId:id,secret:raw,warning:'เก็บรหัสกู้คืนไว้ รหัสนี้แสดงครั้งเดียว'},201)
  }
  if(p==='/points/v2/guest'&&m==='POST'){const b=await this.body(r),id=String(b.cardId||'');const row=await this.db.prepare('SELECT secret_hash FROM points_v2_guests WHERE id=?').bind(id).first();if(!row||!safeCompare(row.secret_hash,await hash(String(b.secret||''))))err('รหัสบัตรไม่ถูกต้อง',403);return respond(await this.v2View('guest:'+id))}
  // Only a logged-in admin may register a separate LINE purchase after verifying payment and delivery.
  // Existing orders are never overwritten; reusing an order number returns 409.
  if(p==='/admin/points/v2/line-orders'&&m==='POST'){
    const admin=await this.admin(r),b=await this.body(r);
    const orderId=String(b.orderId||'').trim(),cardType=String(b.cardType||'');
    const points=Number(b.points);
    if(!/^LINE-[A-Za-z0-9_-]{3,30}$/.test(orderId))err('ใช้เลขออเดอร์ขึ้นต้น LINE- ตามด้วยอักษร/ตัวเลขอย่างน้อย 3 ตัว',400);
    const cfg=await this.v2Config();
    if(!cfg.enabled)err('กรุณาเปิดระบบสะสมแต้มก่อน',409);
    if(!(cfg.cardTypes||[]).some(t=>t.id===cardType))err('ประเภทบัตรไม่ถูกต้อง',400);
    if(!Number.isInteger(points)||points<1||points>15)err('จำนวนแต้มต้องเป็น 1–15',400);
    if(b.confirmPaid!==true||b.confirmDelivered!==true)err('ต้องยืนยันว่าตรวจรับเงินและส่งรหัสเรียบร้อยแล้ว',400);
    const existed=await this.db.prepare('SELECT id FROM orders WHERE id=?').bind(orderId).first();
    if(existed)err('เลขออเดอร์นี้มีอยู่ในระบบแล้ว ห้ามบันทึกซ้ำ',409);
    const now=new Date().toISOString();
    const o={id:orderId,source:'LINE',date:new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}),createdAt:now,
      items:[],total:null,status:'READY_FOR_DELIVERY',lineCardType:cardType,linePointAmount:points,
      linePaidConfirmed:true,lineDeliveredConfirmed:true,lineApprovedBy:admin.id,lineApprovedAt:now,
      revision:crypto.randomUUID()};
    try{await this.db.prepare('INSERT INTO orders(id,user_id,payload,created_at) VALUES(?,?,?,?)')
      .bind(orderId,null,JSON.stringify(o),now).run()}catch(e){if(String(e).includes('UNIQUE'))err('ออเดอร์ซ้ำ',409);throw e}
    return respond({success:true,orderId,cardType,points},201);
  }
  if(p==='/admin/points/v2/links'&&m==='POST'){
    await this.admin(r);const b=await this.body(r),orderId=String(b.orderId||''),cardId='*';if(!/^[A-Za-z0-9_-]{1,36}$/.test(orderId))err('Order ID ไม่ถูกต้อง');
    const o=await this.db.prepare('SELECT payload FROM orders WHERE id=?').bind(orderId).first();if(!o)err('ไม่พบออเดอร์',404);const order=JSON.parse(o.payload);
    if(!this.eligiblePaidOrder(order))err('ออเดอร์ยังไม่อยู่สถานะส่งสินค้าเสร็จแล้ว หรือ LINE ยังไม่ได้ยืนยันรับเงินและส่งงาน',409);
    const requestedSource=String(b.source||'WEB');if(!['WEB','LINE'].includes(requestedSource))err('ช่องทางสั่งซื้อไม่ถูกต้อง',400);if((order.source==='LINE'?'LINE':'WEB')!==requestedSource)err('ช่องทางสั่งซื้อไม่ตรงกับออเดอร์ กรุณาเลือกให้ถูกต้อง',409);
    const cfg=await this.v2Config(),eligible=this.orderPointTypes(order,await this.catalog(),cfg);
    const requested=String(b.cardType||'');if(!(cfg.cardTypes||[]).some(t=>t.id===requested))err('กรุณาเลือกบัตรสะสมแต้ม',400);if(!eligible.includes(requested))err('บัตรที่เลือกไม่ตรงกับหมวดสินค้าของออเดอร์',409);
    if(order.userId)err('ออเดอร์ผูกกับสมาชิกอยู่แล้ว ไม่สามารถออกลิงก์แขก',409);
    const allowedPoints=this.orderPointAmount(order,await this.catalog(),cfg,requested);
    const requestedPoints=Number(b.points??allowedPoints);
    if(!Number.isInteger(requestedPoints)||requestedPoints<1||requestedPoints>15)err('จำนวนแต้มต้องเป็น 1–15',400);
    // For purchases made on the website, never exceed the points allowed by the category rules.
    // For manually verified LINE purchases, the amount is fixed at registration to prevent silent changes.
    if(!allowedPoints||requestedPoints>allowedPoints||(order.source==='LINE'&&requestedPoints!==allowedPoints))
      err('จำนวนแต้มเกินสิทธิ์ของออเดอร์ หรือไม่ตรงกับออเดอร์ LINE ที่บันทึกไว้',409);
    // Prevent issuing another active claim for the same order. Guest card binding occurs at redemption.
     const existingStamp=await this.db.prepare('SELECT id FROM points_v2_stamps WHERE order_id=?').bind(orderId).first();if(existingStamp)err('ออเดอร์นี้รับแต้มไปแล้ว',409);
     const prior=await this.db.prepare('SELECT id FROM points_v2_links WHERE order_id=? AND used_at IS NULL AND expires_at>? LIMIT 1').bind(orderId,new Date().toISOString()).first();
     if(prior)err('ออเดอร์นี้มีลิงก์ที่ยังไม่หมดอายุ โปรดรอหรือใช้ลิงก์เดิม',409);
     const raw=token()+token();const expiry=new Date(Date.now()+15*60000).toISOString();
    await this.db.prepare('INSERT INTO points_v2_links(id,token_hash,order_id,guest_id,type,expires_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),await hash(raw),orderId,cardId,requested+'~'+requestedPoints,expiry).run();return respond({claimCode:raw,expiresAt:expiry});
  }
  if(p==='/points/v2/claim'&&m==='POST'){
    const b=await this.body(r),id=String(b.cardId||''),code=String(b.claimCode||'');const guest=await this.db.prepare('SELECT secret_hash FROM points_v2_guests WHERE id=?').bind(id).first();if(!guest||!safeCompare(guest.secret_hash,await hash(String(b.secret||''))))err('ไม่พบบัตรหรือรหัสกู้คืนไม่ถูกต้อง',403);
    const tokenHash=await hash(code);const link=await this.db.prepare('SELECT id,order_id,type FROM points_v2_links WHERE token_hash=? AND (guest_id=? OR guest_id='*') AND used_at IS NULL AND expires_at>?').bind(tokenHash,id,new Date().toISOString()).first();if(!link)err('ลิงก์หมดอายุ ใช้แล้ว หรือไม่ตรงบัตร',409);
    if(!(await this.v2Config()).enabled)err('ระบบสะสมแต้มยังไม่เปิด',403);
    const ordRow=await this.db.prepare('SELECT payload FROM orders WHERE id=?').bind(link.order_id).first();const order=ordRow?JSON.parse(ordRow.payload):null;
    if(!order||!this.eligiblePaidOrder(order)||order.userId)err('ออเดอร์ไม่มีสิทธิ์รับแต้มในขณะนี้',409);
    const [claimType,encodedPoints]=String(link.type).split('~');const types=this.orderPointTypes(order,await this.catalog(),await this.v2Config());if(!types.includes(claimType))err('หมวดสินค้าไม่ตรงกับบัตรที่เลือก',409);
    const owner='guest:'+id,stampId='approved:'+link.order_id,config=await this.v2Config();const maxPoints=this.orderPointAmount(order,await this.catalog(),config,claimType);const amount=encodedPoints===undefined?maxPoints:Number(encodedPoints);if(!Number.isInteger(amount)||amount<1||amount>15||amount>maxPoints||(order.source==='LINE'&&amount!==maxPoints))err('แต้มลิงก์ไม่ตรงกับสิทธิ์ออเดอร์',409);
    const prior=await this.db.prepare('SELECT id FROM points_v2_stamps WHERE order_id=?').bind(link.order_id).first();if(prior)err('ออเดอร์นี้รับแต้มไปแล้ว',409);
    const res=await this.db.batch([this.db.prepare('UPDATE points_v2_links SET used_at=CURRENT_TIMESTAMP WHERE id=? AND used_at IS NULL AND expires_at>?').bind(link.id,new Date().toISOString()),this.db.prepare('INSERT OR IGNORE INTO points_v2_stamps(id,owner_id,order_id,type,points,remaining_points) VALUES(?,?,?,?,?,?)').bind(stampId,owner,link.order_id,claimType,amount,amount)]);
    if(res[0].meta?.changes!==1)err('ลิงก์ถูกใช้แล้ว',409);if(res[1].meta?.changes!==1)err('ออเดอร์นี้รับแต้มไปแล้ว จึงไม่เพิ่มแต้มซ้ำ',409);
    await this.v2Issue(owner,claimType,config);return respond({success:true,pointsAdded:amount,view:await this.v2View(owner)});
  }
  if(p==='/points/v2/redeem'&&m==='POST'){
    const b=await this.body(r);let owner;if(b.cardId){const guest=await this.db.prepare('SELECT secret_hash FROM points_v2_guests WHERE id=?').bind(String(b.cardId)).first();if(!guest||!safeCompare(guest.secret_hash,await hash(String(b.secret||''))))err('บัตรไม่ถูกต้อง',403);owner='guest:'+b.cardId}else{const user=await this.user(r);owner='member:'+user.id}
    const ticket=await this.db.prepare('SELECT id,type,status,expires_at FROM points_v2_tickets WHERE id=? AND owner_id=?').bind(String(b.ticketId),owner).first();if(!ticket||ticket.status!=='AVAILABLE'||ticket.expires_at<=new Date().toISOString())err('สิทธิ์ไม่พร้อมใช้งานหรือหมดอายุ',409);
    const cfg=await this.v2Config(),reward=cfg.rewardGroups.find(x=>x.id===b.groupId&&(x.type===ticket.type||x.type==='both')&&x.active);if(!reward||!reward.options.includes(b.choice))err('รางวัลไม่อยู่ในตัวเลือกที่อนุญาต',400);
    const update=await this.db.prepare("UPDATE points_v2_tickets SET status='PENDING',reward_name=? WHERE id=? AND owner_id=? AND status='AVAILABLE' AND expires_at>?").bind(String(b.choice),ticket.id,owner,new Date().toISOString()).run();if(!update.meta?.changes)err('สิทธิ์ถูกใช้แล้ว',409);return respond({success:true})
  }
  if(p==='/admin/points/v2/tickets'&&m==='GET'){await this.admin(r);const data=await this.db.prepare("SELECT id,owner_id,type,reward_name,status,expires_at FROM points_v2_tickets WHERE status='PENDING' ORDER BY earned_at DESC LIMIT 100").all();return respond({tickets:data.results||[]})}
  if(p==='/admin/points/v2/tickets'&&m==='PATCH'){await this.admin(r);const b=await this.body(r);const result=await this.db.prepare("UPDATE points_v2_tickets SET status='FULFILLED' WHERE id=? AND status='PENDING'").bind(String(b.id)).run();return respond({success:!!result.meta?.changes})}
  if(p==='/admin/points/config'&&m==='GET'){await this.admin(r);return respond({config:await this.pointsConfig()})}
  if(p==='/admin/points/config'&&m==='PUT'){
    await this.admin(r);const b=await this.body(r),c=b.config||{};
    const days=Number(c.slipRetentionDays),slip=Number(c.slipPoints);
    if(!Number.isInteger(days)||days<1||days>365)err('จำนวนวันต้องอยู่ระหว่าง 1 ถึง 365');
    if(!Number.isInteger(slip)||slip<0||slip>10000)err('แต้มสลิปไม่ถูกต้อง');
    const catalog=await this.catalog(),validNames=new Set((catalog?.categories||[]).map(x=>x.name));
    const categoryPoints={};for(const [name,v] of Object.entries(c.categoryPoints||{})){const n=Number(v);if(!validNames.has(name)||!Number.isInteger(n)||n<0||n>10000)err('แต้มหมวดหมู่ไม่ถูกต้อง: '+name);categoryPoints[name]=n}
    if(!Array.isArray(c.rewards)||c.rewards.length>100)err('จำนวนรางวัลไม่ถูกต้อง');
    const rewards=c.rewards.map(x=>({id:String(x.id||''),name:String(x.name||'').trim(),cost:Number(x.cost),active:x.active!==false}));
    if(rewards.some(x=>!x.id||!/^[a-zA-Z0-9_-]{1,80}$/.test(x.id)||!x.name||x.name.length>100||!Number.isInteger(x.cost)||x.cost<1||x.cost>1000000))err('ข้อมูลของรางวัลไม่ถูกต้อง');
    if(new Set(rewards.map(x=>x.id)).size!==rewards.length)err('รหัสรางวัลซ้ำ');
    const next={enabled:c.enabled!==false,categoryPoints,slipPoints:slip,rewards,slipAutoDelete:c.slipAutoDelete!==false,slipRetentionDays:days};
    await this.db.prepare("INSERT INTO shop_feature_config(key,value) VALUES('points_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(next)).run();return respond({success:true,config:next});
  }
  if(p==='/points/me'&&m==='GET'){
    const user=await this.user(r),config=await this.pointsConfig();
    const rows=await this.db.prepare('SELECT event_key,order_id,delta,kind,description,created_at FROM point_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user.id).all();
    const red=await this.db.prepare('SELECT id,reward_name,cost,status,created_at FROM point_redemptions WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(user.id).all();
    return respond({balance:await this.pointsBalance(user.id),events:rows.results||[],redemptions:red.results||[],rewards:config.rewards.filter(x=>x.active),enabled:config.enabled});
  }
  if(p==='/points/redeem'&&m==='POST')err('ใช้ระบบบัตรสะสมแต้มใหม่แทน',410);
  if(p==='/admin/points/redemptions'&&m==='GET'){
    await this.admin(r);const rows=await this.db.prepare("SELECT r.id,r.user_id,r.reward_name,r.cost,r.status,r.created_at,u.name AS username FROM point_redemptions r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 200").all();return respond({redemptions:rows.results||[]});
  }
  if(/^\/admin\/points\/redemptions\/[a-f0-9-]+$/.test(p)&&m==='PATCH'){
    await this.admin(r);const id=p.split('/').pop(),b=await this.body(r);
    if(!['PENDING','FULFILLED'].includes(b.status))err('สถานะไม่ถูกต้อง');
    await this.db.prepare('UPDATE point_redemptions SET status=? WHERE id=? AND status!=?').bind(b.status,id,'CANCELLED').run();return respond({success:true});
  }
  if(p==='/catalog/import-preview'&&m==='POST'){
    await this.admin(r);const c=await this.catalog();if(!c)err('ไม่พบข้อมูลสินค้า',404);
    const rows=await this.readSheetProductRows();const check=this.compareSheets(c,rows);
    const digest=await hash(JSON.stringify(check.changes));
    return respond({revision:c.revision,previewDigest:digest,checked:check.checked,changes:check.changes.map(({id,appName,category,fields})=>({id,appName,category,fields})),ignored:check.ignored.slice(0,30),ignoredCount:check.ignored.length,warnings:check.warnings.slice(0,50),warningCount:check.warnings.length,sheetSamples:check.sheetSamples,source:"Apps Script /exec read only",readAt:new Date().toISOString()});
  }
  if(p==='/catalog/import-confirm'&&m==='POST'){
    await this.admin(r);const b=await this.body(r),c=await this.catalog();
    if(!c||b.expectedRevision!==c.revision)err('D1 มีการเปลี่ยนแปลงหลัง Preview กรุณาตรวจสอบใหม่',409);
    const rows=await this.readSheetProductRows();const check=this.compareSheets(c,rows);
    // Invalid or unrecognized rows are excluded by compareSheets. Apply only explicitly approved valid IDs.
    // Keep the full comparison digest so intervening sheet changes still invalidate the approval.
    if(b.previewDigest!==await hash(JSON.stringify(check.changes)))err('Google Sheets มีการเปลี่ยนหลัง Preview กรุณาตรวจสอบใหม่',409);
    if(!check.changes.length)return respond({success:true,updated:0,revision:c.revision});
    const approved=Array.isArray(b.approvedIds)?b.approvedIds.map(String):[];
    if(!approved.length||approved.length>100||new Set(approved).size!==approved.length)err('กรุณาเลือกแพ็กเกจที่จะนำเข้า 1–100 รายการ ไม่ซ้ำกัน');
    const available=new Map(check.changes.map(x=>[String(x.id),x]));
    if(approved.some(id=>!available.has(id)))err('มี ID ไม่ตรงกับรายการ Preview กรุณาตรวจใหม่',409);
    const byId=new Map(approved.map(id=>[id,available.get(id)]));
    const next={...c,packages:c.packages.map(pkg=>byId.has(String(pkg.id))?{...pkg,...byId.get(String(pkg.id)).values}:pkg),revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};
    const saved=await this.db.prepare('UPDATE catalog SET payload=? WHERE id=1 AND payload=?').bind(JSON.stringify(next),JSON.stringify(c)).run();
    if(!saved.meta?.changes)err('ข้อมูล D1 เปลี่ยนระหว่างนำเข้า กรุณาลองใหม่',409);
    // DO NOT call sheetSync here: Google Sheets is the source of this import.
    return respond({success:true,updated:approved.length,revision:next.revision});
  }
 if(p==='/catalog'&&m==='GET'){const c=await this.catalog();const result=respond({payload:c?this.publicCatalog(c):null,updated_at:c?.updatedAt||null});result.headers.set('Cache-Control','public,max-age=30,stale-while-revalidate=120');return result}
 if(p==='/catalog'&&m==='PUT'){await this.admin(r);const b=await this.body(r),current=await this.catalog();if((b.expectedRevision??null)!==(current?.revision??null))err('ข้อมูลร้านถูกเปลี่ยนแล้ว กรุณาโหลดใหม่',409);const c={...this.publicCatalog(b.payload),revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};if(JSON.stringify(c).length>1800000)err('ข้อมูลร้านใหญ่เกินไป กรุณาใช้ลิงก์รูปแทนภาพ Base64',413);await this.db.prepare('INSERT INTO catalog(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(JSON.stringify(c)).run();let sheet={status:'not_configured'};try{sheet=await this.sheetSync(c)}catch(e){sheet={status:'failed',error:String(e.message)};await this.db.prepare('INSERT INTO sheet_jobs(id,payload,error) VALUES(?,?,?)').bind(c.revision,JSON.stringify(c),sheet.error).run()}return respond({payload:c,updated_at:c.updatedAt,sheet})}
 if(p==='/sync/sheets/retry'&&m==='POST'){await this.admin(r);const rows=await this.db.prepare('SELECT * FROM sheet_jobs ORDER BY rowid LIMIT 5').all(),results=[];for(const row of rows.results){try{await this.sheetSync(JSON.parse(row.payload));await this.db.prepare('DELETE FROM sheet_jobs WHERE id=?').bind(row.id).run();results.push({id:row.id,ok:true})}catch(e){results.push({id:row.id,ok:false,error:String(e.message)})}}return respond({results})}
 if(p==='/orders'&&m==='POST'){const b=await this.body(r),o=b.order;if(!o||!Array.isArray(o.items)||!o.items.length||o.items.length>100)err('รายการสินค้าไม่ถูกต้อง');if(!/^[a-f0-9]{64}$/.test(b.token||''))err('Missing order access token');if(!/^[A-Za-z0-9_-]{1,36}$/.test(o.id||''))err('Order ID invalid');const existing=await this.db.prepare('SELECT payload FROM orders WHERE id=?').bind(o.id).first();if(existing){const x=JSON.parse(existing.payload);if(x.token!==b.token)err('Order ID exists',409);return respond({order:this.customerOrder(x)})}const c=await this.catalog();if(!c)err('ยังไม่มีข้อมูลสินค้าในระบบกลาง',503);const priced=this.calculateCart(c,o.items);if(!Number.isFinite(Number(o.total))||Math.round(Number(o.total)*100)!==Math.round(priced.total*100))err('ราคาสินค้าเปลี่ยน กรุณารีเฟรชตะกร้า',409);const customer=await this.user(r,true);if(o.slipImg&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(o.slipImg))err('รูปสลิปไม่ถูกต้อง');if(o.slipImg&&o.slipImg.length>350000)err('สลิปใหญ่เกินไป กรุณาเลือกรูปที่ย่อแล้วไม่เกิน 250 KB',413);const order={id:o.id,date:new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}),createdAt:new Date().toISOString(),items:priced.items,total:priced.total,paymentMethod:String(o.paymentMethod||''),source:'WEBSITE',customerRequirements:o.customerRequirements||{},slipImg:o.slipImg||'',slipSubmittedAt:o.slipImg?new Date().toISOString():null,status:o.slipImg?'VERIFYING_SLIP':'AWAITING_PAYMENT',deliveryData:'',deliveryImages:[],revision:crypto.randomUUID(),token:b.token,...(customer?{userId:customer.id}:{})};await this.db.prepare('INSERT INTO orders(id,user_id,payload,created_at) VALUES(?,?,?,?)').bind(order.id,customer?.id||null,JSON.stringify(order),order.createdAt).run();return respond({order:this.customerOrder(order)},201)}
 if(p==='/customer/orders'&&m==='GET'){const user=await this.user(r);const rows=await this.db.prepare('SELECT payload FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user.id).all();return respond({orders:rows.results.map(x=>this.customerOrder(JSON.parse(x.payload)))})}
 if(p==='/orders'&&m==='GET'){await this.admin(r);const cursor=Math.max(0,Number(u.searchParams.get('cursor'))||0);const rows=await this.db.prepare('SELECT payload FROM orders ORDER BY created_at DESC LIMIT 25 OFFSET ?').bind(cursor).all();return respond({orders:rows.results.map(x=>{const o=JSON.parse(x.payload);delete o.token;o.hasSlip=Boolean(o.slipImg);delete o.slipImg;delete o.deliveryImages;return o}),cursor:rows.results.length===25?String(cursor+25):null})}
 if(m==='DELETE' && /^\/orders\/[A-Za-z0-9_-]+\/slip$/.test(p)){
   await this.admin(r);
   const id=p.split('/')[2];
   const row=await this.db.prepare('SELECT payload FROM orders WHERE id=?').bind(id).first();
   if(!row)err('ไม่พบออเดอร์',404);
   const o=JSON.parse(row.payload);
   if(!o.slipImg)return respond({ok:true,alreadyDeleted:true});
   o.slipImg='';o.slipExpiredAt=new Date().toISOString();o.revision=crypto.randomUUID();
   const saved=await this.db.prepare('UPDATE orders SET payload=? WHERE id=? AND payload=?').bind(JSON.stringify(o),id,row.payload).run();
   if(!saved.meta?.changes)err('ออเดอร์ถูกแก้ไขพร้อมกัน กรุณาลองใหม่',409);
   return respond({ok:true});
 }
 const match=p.match(/^\/orders\/([A-Za-z0-9_-]+)$/);if(match){const row=await this.db.prepare('SELECT payload FROM orders WHERE id=?').bind(match[1]).first();if(!row)err('ไม่พบออเดอร์',404);const o=JSON.parse(row.payload);if(m==='GET'){if(r.headers.get('Authorization')){await this.admin(r);const x=clean(o);delete x.token;return respond({order:x})}if(r.headers.get('X-Order-Token')!==o.token)err('ไม่มีสิทธิ์ดูออเดอร์',404);return respond({order:this.customerOrder(o)})}if(m==='PATCH'){await this.admin(r);const b=await this.body(r);if(b.revision!==o.revision)err('ออเดอร์ถูกเปลี่ยนแล้ว',409);if(!['AWAITING_PAYMENT','VERIFYING_SLIP','PENDING','PROCESSING','READY_FOR_DELIVERY','COMPLETED','CANCELLED'].includes(b.status))err('สถานะไม่ถูกต้อง');const next={...o,status:b.status,slipApprovedAt:(['READY_FOR_DELIVERY','COMPLETED'].includes(b.status)&&this.eligiblePaidOrder({...o,status:b.status}))?(o.slipApprovedAt||new Date().toISOString()):o.slipApprovedAt,deliveryData:String(b.deliveryData||''),deliveryImages:b.deliveryImages||[],adminNote:String(b.adminNote||''),revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};await this.db.prepare('UPDATE orders SET payload=? WHERE id=?').bind(JSON.stringify(next),o.id).run();try{await this.v2Award(next,next.userId?('member:'+next.userId):null)}catch(e){console.error('v2 points award retry needed',o.id,e)}delete next.token;return respond({order:next})}}
 err('Not found',404)
 }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const featureConfig = await new Shop(env).pointsConfig();
      await env.DB.prepare("UPDATE points_v2_tickets SET status='EXPIRED' WHERE status='AVAILABLE' AND expires_at<=?").bind(new Date().toISOString()).run();
      if (!featureConfig.slipAutoDelete) return;
      const olderThan = new Date(Date.now() - featureConfig.slipRetentionDays * 86400000).toISOString();
      let removed=0;
      // Five small batches, bounded work per daily run. Never delete the order itself.
      for(let batch=0; batch<5; batch++) {
        const rows=await env.DB.prepare(`SELECT id,payload FROM orders WHERE created_at < ? AND payload LIKE '%"slipImg":"data:image/%' LIMIT 100`).bind(olderThan).all();
        if (!(rows.results||[]).length) break;
        for(const row of rows.results||[]) {
          const order=JSON.parse(row.payload);
          if(!order.slipImg)continue;
          order.slipImg='';
          order.slipExpiredAt=new Date().toISOString();
          // Optimistic guard prevents overwriting an order edited during cleanup.
          const result=await env.DB.prepare('UPDATE orders SET payload=? WHERE id=? AND payload=?').bind(JSON.stringify(order),row.id,row.payload).run();
          if(result.meta?.changes)removed++;
        }
      }
      console.log('Expired order slip cleanup',removed);
    })());
  },
  async fetch(r, env) {
    const origin = r.headers.get('Origin');
    const allowed = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(s => s.trim());

    const cors = {
      'Access-Control-Allow-Origin':
        origin && allowed.includes(origin)
          ? origin
          : allowed[0] || '',
      'Vary': 'Origin',
      'Access-Control-Allow-Headers':
        'Content-Type,Authorization,X-Order-Token,X-Customer-JWT,X-Bootstrap-Secret',
      'Access-Control-Allow-Methods':
        'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    };

    if (r.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    if (origin && !allowed.includes(origin)) {
      return respond({ error: 'Origin denied' }, 403, cors);
    }

    try {
      const path = new URL(r.url).pathname;

      if (
        ['/auth/login', '/auth/register', '/orders', '/points/v2/guest/create', '/points/v2/guest', '/points/v2/claim', '/reviews'].includes(path) &&
        r.method === 'POST' &&
        env.RATE_LIMITER
      ) {
        const check = await env.RATE_LIMITER.limit({
          key: (r.headers.get('CF-Connecting-IP') || 'unknown') + ':' + path
        });

        if (!check.success) {
          return respond({ error: 'Too many requests' }, 429, cors);
        }
      }

      const result = await new Shop(env).route(r);

      Object.entries(cors).forEach(([key, value]) => {
        result.headers.set(key, value);
      });

      return result;

    } catch (e) {
      console.error('Worker request failed:', e);

      return respond(
        {
          error: e.status
            ? e.message
            : 'Server error; check Worker logs'
        },
        e.status || 500,
        cors
      );
    }
  }
};
