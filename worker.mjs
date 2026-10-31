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
 async sheetSync(c){const e=this.env;if(!e.SHEETS_WEBAPP_URL||!e.SYNC_SHARED_SECRET)return {status:'not_configured'};const res=await fetch(e.SHEETS_WEBAPP_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'sync_catalog_to_sheets',syncToken:e.SYNC_SHARED_SECRET,updatedAt:c.updatedAt,categories:c.categories||[],apps:c.apps||[],packages:c.packages||[],idempotencyKey:c.revision})});const raw=await res.text();let result;try{result=JSON.parse(raw)}catch{throw Error('Google Apps Script response ไม่ใช่ JSON')}if(!res.ok||!result.success)throw Error(result.error||'Google Sheets sync failed');return {status:'saved',result}}
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

 async route(r){const u=new URL(r.url),p=u.pathname.replace(/\/$/,'')||'/',m=r.method;
 if(p==='/health')return respond({ok:true,backend:'cloudflare-d1'});
 if(p==='/auth/bootstrap'&&m==='POST'){if(!this.env.ADMIN_BOOTSTRAP_SECRET||!safeCompare(r.headers.get('X-Bootstrap-Secret'),this.env.ADMIN_BOOTSTRAP_SECRET))err('Unauthorized',403);const already=await this.db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();if(already)err('มีบัญชีแอดมินแล้ว',409);return respond({user:await this.authCreate(await this.body(r),'admin')},201)}
 if(p==='/auth/register'&&m==='POST'){const b=await this.body(r);return respond({user:await this.authCreate(b)},201)}
 if(p==='/auth/login'&&m==='POST'){const b=await this.body(r);const user=await this.db.prepare('SELECT * FROM users WHERE email=?').bind(String(b.email||'').trim().toLowerCase()).first();if(!user||!safeCompare(await passwordHash(String(b.password||''),user.salt),user.password_hash))err('อีเมลหรือรหัสผ่านไม่ถูกต้อง',401);const session=await this.createSession(user);return respond({session,user:{id:user.id,$id:user.id,email:user.email,name:user.name,role:user.role}})}
 if(p==='/auth/me'){const x=await this.user(r);return respond({user:{id:x.id,$id:x.id,email:x.email,name:x.name,role:x.role}})}
 if(p==='/auth/logout'&&m==='POST'){const raw=(r.headers.get('Authorization')||r.headers.get('X-Customer-JWT')||'').replace(/^Bearer\s+/i,'');if(raw)await this.db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(raw)).run();return respond({ok:true})}
 if(p==='/visits'&&m==='GET'){const n=await this.db.prepare('SELECT count FROM counters WHERE id=1').first();return respond({count:n?.count||0})}
 if(p==='/visits'&&m==='POST'){const b=await this.body(r);if(!/^[a-f\d-]{36}$/i.test(String(b.visitId||'')))err('Invalid visit ID');await this.db.prepare('INSERT OR IGNORE INTO visitors (id) VALUES (?)').bind(b.visitId).run();return respond({count:(await this.db.prepare('SELECT count(*) AS count FROM visitors').first()).count})}
 if(p==='/visits/reset'&&m==='POST'){await this.admin(r);await this.db.prepare('DELETE FROM visitors').run();return respond({count:0})}
 if(p==='/catalog'&&m==='GET'){const c=await this.catalog();const result=respond({payload:c?this.publicCatalog(c):null,updated_at:c?.updatedAt||null});result.headers.set('Cache-Control','public,max-age=30,stale-while-revalidate=120');return result}
 if(p==='/catalog'&&m==='PUT'){await this.admin(r);const b=await this.body(r),current=await this.catalog();if((b.expectedRevision??null)!==(current?.revision??null))err('ข้อมูลร้านถูกเปลี่ยนแล้ว กรุณาโหลดใหม่',409);const c={...this.publicCatalog(b.payload),revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};if(JSON.stringify(c).length>1800000)err('ข้อมูลร้านใหญ่เกินไป กรุณาใช้ลิงก์รูปแทนภาพ Base64',413);await this.db.prepare('INSERT INTO catalog(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').bind(JSON.stringify(c)).run();let sheet={status:'not_configured'};try{sheet=await this.sheetSync(c)}catch(e){sheet={status:'failed',error:String(e.message)};await this.db.prepare('INSERT INTO sheet_jobs(id,payload,error) VALUES(?,?,?)').bind(c.revision,JSON.stringify(c),sheet.error).run()}return respond({payload:c,updated_at:c.updatedAt,sheet})}
 if(p==='/sync/sheets/retry'&&m==='POST'){await this.admin(r);const rows=await this.db.prepare('SELECT * FROM sheet_jobs ORDER BY rowid LIMIT 5').all(),results=[];for(const row of rows.results){try{await this.sheetSync(JSON.parse(row.payload));await this.db.prepare('DELETE FROM sheet_jobs WHERE id=?').bind(row.id).run();results.push({id:row.id,ok:true})}catch(e){results.push({id:row.id,ok:false,error:String(e.message)})}}return respond({results})}
 if(p==='/orders'&&m==='POST'){const b=await this.body(r),o=b.order;if(!o||!Array.isArray(o.items)||!o.items.length||o.items.length>100)err('รายการสินค้าไม่ถูกต้อง');if(!/^[a-f0-9]{64}$/.test(b.token||''))err('Missing order access token');if(!/^[A-Za-z0-9_-]{1,36}$/.test(o.id||''))err('Order ID invalid');const existing=await this.db.prepare('SELECT payload FROM orders WHERE id=?').bind(o.id).first();if(existing){const x=JSON.parse(existing.payload);if(x.token!==b.token)err('Order ID exists',409);return respond({order:this.customerOrder(x)})}const c=await this.catalog();if(!c)err('ยังไม่มีข้อมูลสินค้าในระบบกลาง',503);const priced=this.calculateCart(c,o.items);if(!Number.isFinite(Number(o.total))||Math.round(Number(o.total)*100)!==Math.round(priced.total*100))err('ราคาสินค้าเปลี่ยน กรุณารีเฟรชตะกร้า',409);const customer=await this.user(r,true);if(o.slipImg&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(o.slipImg))err('รูปสลิปไม่ถูกต้อง');const order={id:o.id,date:new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}),createdAt:new Date().toISOString(),items:priced.items,total:priced.total,paymentMethod:String(o.paymentMethod||''),source:'WEBSITE',customerRequirements:o.customerRequirements||{},slipImg:o.slipImg||'',status:o.slipImg?'VERIFYING_SLIP':'AWAITING_PAYMENT',deliveryData:'',deliveryImages:[],revision:crypto.randomUUID(),token:b.token,...(customer?{userId:customer.id}:{})};await this.db.prepare('INSERT INTO orders(id,user_id,payload,created_at) VALUES(?,?,?,?)').bind(order.id,customer?.id||null,JSON.stringify(order),order.createdAt).run();return respond({order:this.customerOrder(order)},201)}
 if(p==='/customer/orders'&&m==='GET'){const user=await this.user(r);const rows=await this.db.prepare('SELECT payload FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user.id).all();return respond({orders:rows.results.map(x=>this.customerOrder(JSON.parse(x.payload)))})}
 if(p==='/orders'&&m==='GET'){await this.admin(r);const cursor=Math.max(0,Number(u.searchParams.get('cursor'))||0);const rows=await this.db.prepare('SELECT payload FROM orders ORDER BY created_at DESC LIMIT 25 OFFSET ?').bind(cursor).all();return respond({orders:rows.results.map(x=>{const o=JSON.parse(x.payload);delete o.token;delete o.slipImg;delete o.deliveryImages;return o}),cursor:rows.results.length===25?String(cursor+25):null})}
 const match=p.match(/^\/orders\/([A-Za-z0-9_-]+)$/);if(match){const row=await this.db.prepare('SELECT payload FROM orders WHERE id=?').bind(match[1]).first();if(!row)err('ไม่พบออเดอร์',404);const o=JSON.parse(row.payload);if(m==='GET'){if(r.headers.get('Authorization')){await this.admin(r);const x=clean(o);delete x.token;return respond({order:x})}if(r.headers.get('X-Order-Token')!==o.token)err('ไม่มีสิทธิ์ดูออเดอร์',404);return respond({order:this.customerOrder(o)})}if(m==='PATCH'){await this.admin(r);const b=await this.body(r);if(b.revision!==o.revision)err('ออเดอร์ถูกเปลี่ยนแล้ว',409);if(!['AWAITING_PAYMENT','VERIFYING_SLIP','PENDING','PROCESSING','READY_FOR_DELIVERY','COMPLETED','CANCELLED'].includes(b.status))err('สถานะไม่ถูกต้อง');const next={...o,status:b.status,deliveryData:String(b.deliveryData||''),deliveryImages:b.deliveryImages||[],adminNote:String(b.adminNote||''),revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};await this.db.prepare('UPDATE orders SET payload=? WHERE id=?').bind(JSON.stringify(next),o.id).run();delete next.token;return respond({order:next})}}
 err('Not found',404)
 }
}

export default {
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
        'GET,POST,PUT,PATCH,OPTIONS'
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
        ['/auth/login', '/auth/register', '/orders'].includes(path) &&
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
