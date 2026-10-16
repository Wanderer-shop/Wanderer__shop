import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {Store} from './worker.mjs';
if(!globalThis.crypto)Object.defineProperty(globalThis,"crypto",{value:webcrypto});
const rows=new Map();
const env={CATALOG_TABLE_ID:'catalog',ORDERS_TABLE_ID:'orders',APPWRITE_DATABASE_ID:'db',ADMIN_USER_IDS:'admin',SYNC_SHARED_SECRET:'server-secret'};
const store=new Store({blockConcurrencyWhile:fn=>fn()},env);
store.aw=async(path,{method='GET',body,session}={})=>{
 if(path==='/account'){if(session!=='admin-session')throw Object.assign(Error('Unauthorized'),{status:401});return {$id:'admin',email:'admin@example.com'};}
 const m=path.match(/tables\/(catalog|orders)\/rows(?:\/([^?]+))?/);assert.ok(m,path);const table=m[1],id=m[2];const key=table+':'+id;
 if(method==='POST'){const key=table+':'+body.rowId;if(rows.has(key))throw Object.assign(Error('Conflict'),{status:409});const row={$id:body.rowId,...body.data};rows.set(key,row);return row;}
 if(method==='PATCH'){assert.ok(rows.has(key));Object.assign(rows.get(key),body.data);return rows.get(key);}
 if(!id)return {rows:[...rows].filter(([k])=>k.startsWith(table+':')).map(([,v])=>v)};
 if(!rows.has(key))throw Object.assign(Error('Not found'),{status:404});return rows.get(key);
};
async function call(path,method='GET',body,headers={}){const r=await store.fetch(new Request('https://api.test'+path,{method,headers,body:body?JSON.stringify(body):undefined}));return {status:r.status,data:await r.json()};}
const admin={Authorization:'Bearer admin-session'}, token='a'.repeat(64);
assert.equal((await call('/catalog','PUT',{payload:{}},{})).status,401);
let result=await call('/catalog','PUT',{payload:{packages:[{id:'p1',name:'Product',price:50,inStock:true}],orders:[{secret:'must not leak'}]},expectedRevision:null},admin);
assert.equal(result.status,200);assert.equal(result.data.payload.orders,undefined);
assert.equal((await call('/catalog','PUT',{payload:{},expectedRevision:null},admin)).status,409);
const order={id:'ORD-test',items:[{id:'p1',qty:2,price:1}],total:100,slipImg:'data:image/png;base64,YQ==',customerRequirements:{0:{email:'private'}}};
assert.equal((await call('/orders','POST',{order:{...order,total:1},token})).status,409);
result=await call('/orders','POST',{order,token});assert.equal(result.status,201);assert.equal(result.data.order.items[0].price,50);assert.equal(result.data.order.token,undefined);
assert.equal((await call('/orders','POST',{order,token})).status,200);
assert.equal((await call('/orders','POST',{order,token:'b'.repeat(64)})).status,409);
assert.equal((await call('/orders/ORD-test')).status,404);
assert.equal((await call('/orders/ORD-test','GET',null,{'X-Order-Token':token})).data.order.slipImg,order.slipImg);
assert.equal((await call('/orders')).status,401);
result=await call('/orders','GET',null,admin);assert.equal(result.data.orders.length,1);assert.equal(result.data.orders[0].slipImg,undefined);
const fetched=(await call('/orders/ORD-test','GET',null,admin)).data.order;
result=await call('/orders/ORD-test','PATCH',{...fetched,status:'READY_FOR_DELIVERY',deliveryData:'delivered'},admin);assert.equal(result.status,200);
assert.equal((await call('/orders/ORD-test','PATCH',{...fetched,status:'CANCELLED'},admin)).status,409);
assert.equal((await call('/orders/ORD-test','GET',null,{'X-Order-Token':token})).data.order.deliveryData,'delivered');
assert.equal((await call('/sync/orders','GET',null,{'X-Sync-Secret':'bad'})).status,403);
assert.equal((await call('/sync/orders','GET',null,{'X-Sync-Secret':'server-secret'})).status,200);
console.log('PASS: authorization, catalog privacy, server prices, idempotency, cross-device reads, slips, admin updates, stale-write conflicts, Sheets authorization');
