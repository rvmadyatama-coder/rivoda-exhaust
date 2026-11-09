import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';

const app=express(); app.use(express.json({limit:'1mb'}));
const PORT=Number(process.env.PORT||3000), DATA_DIR=path.resolve(process.env.DATA_DIR||'./data');
await fs.mkdir(DATA_DIR,{recursive:true});
const allowed=(process.env.PUBLIC_SITE_ORIGIN||'https://rivodaexhaust.id').split(',').map(x=>x.trim());
app.use(cors({origin:(origin,cb)=>!origin||allowed.includes(origin)?cb(null,true):cb(new Error('Origin tidak diizinkan')),methods:['GET','POST','OPTIONS']}));
const PARTNER_ID=String(process.env.PARTNER_ID||''); const PARTNER_KEY=String(process.env.PARTNER_KEY||'');
const REDIRECT_URL=String(process.env.REDIRECT_URL||''); const BASE='https://partner.shopeemobile.com';
const authFile=path.join(DATA_DIR,'shopee-auth.json'), productsFile=path.join(DATA_DIR,'products.json');
const categoriesFile=path.join(DATA_DIR,'category-map.json');
let auth=null, products=[], lastSync=null, syncError=null, syncing=false, oauthState=null;
try{auth=JSON.parse(await fs.readFile(authFile,'utf8'));}catch{}
try{products=JSON.parse(await fs.readFile(productsFile,'utf8')).products||[];lastSync=JSON.parse(await fs.readFile(productsFile,'utf8')).lastSync||null;}catch{}
let categoryMap={sku:{'RVD-KT01-BT':'Knalpot Konsep Titanium','RVD-KT02-UK':'Knalpot Harian','RVD-HFS01-PL':'Knalpot Harian','RVD-HFS01-BK':'Knalpot Custom'},category_id:{}}; try{categoryMap={...categoryMap,...JSON.parse(await fs.readFile(categoriesFile,'utf8'))};}catch{}
const now=()=>Math.floor(Date.now()/1000);
const sign=(pathName,timestamp,token='',shopId='')=>crypto.createHmac('sha256',PARTNER_KEY).update(`${PARTNER_ID}${pathName}${timestamp}${token}${shopId}`).digest('hex');
function assertConfig(){if(!PARTNER_ID||!PARTNER_KEY||!REDIRECT_URL)throw new Error('PARTNER_ID, PARTNER_KEY, dan REDIRECT_URL harus diisi di environment backend.');}
async function writeJson(file,obj){
 const tmp=`${file}.${process.pid}.tmp`;
 await fs.writeFile(tmp,JSON.stringify(obj,null,2),'utf8');
 await fs.rename(tmp,file);
}
async function signedRequest(apiPath,{method='GET',body,params={},shop=true}={}){
  assertConfig(); if(!auth?.access_token||!auth?.shop_id)throw new Error('Toko Shopee belum diotorisasi. Buka /auth/shopee.');
  const ts=now(), token=auth.access_token, shopId=String(auth.shop_id), signature=sign(apiPath,ts,token,shopId);
  const url=new URL(BASE+apiPath); url.searchParams.set('partner_id',PARTNER_ID);url.searchParams.set('timestamp',String(ts));url.searchParams.set('access_token',token);url.searchParams.set('shop_id',shopId);url.searchParams.set('sign',signature);
  for(const [k,v] of Object.entries(params||{})){ if(Array.isArray(v)) v.forEach(x=>url.searchParams.append(k,x)); else if(v!==undefined&&v!==null) url.searchParams.set(k,String(v)); }
  const res=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({})); if(!res.ok||data.error)throw new Error(`Shopee API ${res.status}: ${data.message||data.error||'Permintaan gagal'}`); return data;
}
async function refreshToken(){
  assertConfig(); if(!auth?.refresh_token||!auth?.shop_id)throw new Error('Refresh token tidak tersedia; lakukan otorisasi ulang.');
  const apiPath='/api/v2/auth/access_token/get',ts=now(),sig=sign(apiPath,ts);
  const url=new URL(BASE+apiPath);url.searchParams.set('partner_id',PARTNER_ID);url.searchParams.set('timestamp',String(ts));url.searchParams.set('sign',sig);
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:auth.refresh_token,partner_id:Number(PARTNER_ID),shop_id:Number(auth.shop_id)})});
  const data=await res.json();if(!res.ok||data.error)throw new Error(data.message||data.error||'Gagal refresh token');
  auth={...auth,...data,shop_id:auth.shop_id,updated_at:new Date().toISOString()};await writeJson(authFile,auth);
}
async function requestWithRefresh(apiPath,opts){try{return await signedRequest(apiPath,opts);}catch(e){if(/token|unauthorized|invalid access/i.test(e.message)){await refreshToken();return await signedRequest(apiPath,opts);}throw e;}}
function categoryFor(item){const sku=String(item.item_sku||'').trim(); if(sku&&categoryMap.sku?.[sku])return categoryMap.sku[sku]; if(categoryMap.category_id?.[String(item.category_id)])return categoryMap.category_id[String(item.category_id)];
 const text=`${item.item_name||''} ${sku}`.toLowerCase(); if(/titanium|blue.?ti|konsep/i.test(text))return 'Knalpot Konsep Titanium'; if(/custom|request/i.test(text))return 'Knalpot Custom'; if(/harian|standar|daily/i.test(text))return 'Knalpot Harian'; return 'Produk Shopee';}
function stockOf(item){const s=item.stock_info_v2?.summary_info||{};if(Number.isFinite(Number(s.total_available_stock)))return Number(s.total_available_stock);const arr=item.stock_info||[];return arr.reduce((n,x)=>n+Number(x.normal_stock||0),0);}
function imageList(item){return (item.image?.image_url_list||[]).filter(Boolean);}
async function syncProducts(){if(syncing)return;syncing=true;syncError=null;
 try{
  let offset=0,ids=[],more=true;
  // Shopee Open API v2: get_item_list menggunakan GET dan paginasi offset/page_size.
  while(more){const data=await requestWithRefresh('/api/v2/product/get_item_list',{method:'GET',params:{offset,page_size:100,item_status:['NORMAL']}});const r=data.response||{};const items=r.item||[];ids.push(...items.map(x=>Number(x.item_id)));more=Boolean(r.has_next_page);offset=Number(r.next_offset??(offset+items.length));if(!items.length)break;}
  const all=[];
  for(let i=0;i<ids.length;i+=50){const chunk=ids.slice(i,i+50);const data=await requestWithRefresh('/api/v2/product/get_item_base_info',{method:'GET',params:{item_id_list:chunk.map(String).join(',')}});for(const item of (data.response?.item_list||[])){
    const imgs=imageList(item);let variations=[];let modelStocks=[];
    if(item.has_model){try{const md=await requestWithRefresh('/api/v2/product/get_model_list',{method:'GET',params:{item_id:item.item_id}});const mr=md.response||{};const tiers=mr.tier_variation||[];const models=mr.model||[];variations=models.filter(m=>!m.model_status||m.model_status==='MODEL_NORMAL').map(m=>{const opts=(m.tier_index||[]).map((idx,ti)=>tiers[ti]?.option_list?.[idx]?.option).filter(Boolean);return opts.join(' / ')||m.model_sku||`Varian ${m.model_id}`;});modelStocks=models.map(m=>({modelId:String(m.model_id),sku:m.model_sku||'',variation:(m.tier_index||[]).map((idx,ti)=>tiers[ti]?.option_list?.[idx]?.option).filter(Boolean).join(' / '),stock:Number(m.stock_info_v2?.summary_info?.total_available_stock??0),price:Number(m.price_info?.[0]?.current_price??m.price_info?.[0]?.original_price??0)}));}catch(e){console.warn('Gagal membaca variasi item',item.item_id,e.message);}}
    const priceInfo=item.price_info?.[0]||{};const modelPrices=(mrModels=>mrModels.map(m=>Number(m.price_info?.[0]?.current_price??m.price_info?.[0]?.original_price??0)).filter(n=>n>0))(modelStocks);const price=Number(priceInfo.current_price??priceInfo.original_price??(modelPrices.length?Math.min(...modelPrices):0));
    const desc=String(item.description||'').trim();const id=String(item.item_id);const shopId=String(auth.shop_id);
    all.push({id:Number(item.item_id),itemId:id,name:item.item_name||'Produk RIVODA EXHAUST',category:categoryFor(item),tags:[categoryFor(item)],price,stock:item.has_model?modelStocks.reduce((n,m)=>n+m.stock,0):stockOf(item),weight:Number(item.weight||0),sku:item.item_sku||id,rating:null,sold:null,variations,models:modelStocks,image:imgs[0]||'',images:imgs,desc:desc.slice(0,500)||'Produk resmi RIVODA EXHAUST. Hubungi admin untuk detail kecocokan kendaraan.',detail:desc||'Produk resmi RIVODA EXHAUST.',shopeeUrl:`https://shopee.co.id/product/${shopId}/${id}`,status:item.item_status,updatedAt:item.update_time||null});
  }}
  if(ids.length===0 && products.length>0){throw new Error('Shopee mengembalikan 0 produk. Katalog lama dipertahankan untuk mencegah penghapusan massal.');}
  products=all;lastSync=new Date().toISOString();await writeJson(productsFile,{products,lastSync,shopName:'Shopee RIVODA EXHAUST'});
 }catch(e){syncError=e.message;console.error('SYNC ERROR:',e.message);}finally{syncing=false;}
}
app.get('/health',(req,res)=>res.json({ok:true,service:'RIVODA Shopee Product Sync',authorized:Boolean(auth?.access_token),productCount:products.length,lastSync,syncing,syncError}));
app.get('/api/products',(req,res)=>res.set('Cache-Control','no-store').json({products,lastSync,shopName:'Shopee RIVODA EXHAUST',source:'Shopee Open Platform'}));
app.get('/auth/shopee',(req,res)=>{try{
 assertConfig();
 oauthState=crypto.randomBytes(24).toString('hex');
 const apiPath='/api/v2/shop/auth_partner',ts=now(),sig=sign(apiPath,ts);
 const url=new URL(BASE+apiPath);
 url.searchParams.set('partner_id',PARTNER_ID);url.searchParams.set('timestamp',String(ts));
 url.searchParams.set('sign',sig);url.searchParams.set('redirect',REDIRECT_URL);
 url.searchParams.set('state',oauthState);
 res.redirect(url.toString());
}catch(e){res.status(500).send(e.message);}});
app.get('/auth/shopee/callback',async(req,res)=>{try{assertConfig();const {code,shop_id,state}=req.query;if(!code||!shop_id)throw new Error('Callback tidak berisi code atau shop_id.');if(!oauthState||!state||String(state)!==oauthState)throw new Error('Validasi OAuth state gagal. Ulangi proses otorisasi dari /auth/shopee.');oauthState=null;const apiPath='/api/v2/auth/token/get',ts=now(),sig=sign(apiPath,ts);const url=new URL(BASE+apiPath);url.searchParams.set('partner_id',PARTNER_ID);url.searchParams.set('timestamp',String(ts));url.searchParams.set('sign',sig);
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:String(code),partner_id:Number(PARTNER_ID),shop_id:Number(shop_id)})});const d=await r.json();if(!r.ok||d.error)throw new Error(d.message||d.error||'Gagal mengambil token.');auth={...d,shop_id:String(shop_id),updated_at:new Date().toISOString()};await writeJson(authFile,auth);await syncProducts();res.send('<h2>Otorisasi Shopee berhasil</h2><p>Toko telah dihubungkan. Sinkronisasi produk dimulai. Anda dapat menutup halaman ini.</p>');
 }catch(e){res.status(400).send(`Otorisasi gagal: ${e.message}`);}});
app.post('/admin/sync',async(req,res)=>{if(!process.env.SYNC_SECRET||req.headers['x-sync-secret']!==process.env.SYNC_SECRET)return res.status(401).json({error:'Unauthorized'});await syncProducts();res.json({ok:!syncError,lastSync,productCount:products.length,error:syncError});});
app.get('/admin/status',(req,res)=>{if(!process.env.SYNC_SECRET||req.headers['x-sync-secret']!==process.env.SYNC_SECRET)return res.status(401).json({error:'Unauthorized'});res.json({authorized:Boolean(auth?.access_token),shopId:auth?.shop_id||null,productCount:products.length,lastSync,syncing,syncError});});
const interval=Math.max(5,Number(process.env.SYNC_INTERVAL_MINUTES||10))*60*1000;
app.listen(PORT,()=>{console.log(`RIVODA Shopee Sync berjalan di port ${PORT}`);if(auth?.access_token)setTimeout(syncProducts,3000);setInterval(()=>{if(auth?.access_token)syncProducts();},interval);});
