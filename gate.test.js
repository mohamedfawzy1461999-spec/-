const {spawn}=require('child_process'),os=require('os'),path=require('path');const D=path.join(os.tmpdir(),'bim_g_data.json'),AU=path.join(os.tmpdir(),'bim_g_auth.json');const P=4599,B='http://127.0.0.1:'+P;
const env={...process.env,PORT:P,DATA_FILE:D,AUTH_FILE:AU,ADMIN_USER:'admin',ADMIN_PASS:'adminpass1',JWT_SECRET:'x'.repeat(32)};
require('fs').rmSync(D,{force:true});require('fs').rmSync(AU,{force:true});
const sv=spawn('node',[path.join(__dirname,'..','server.js')],{env,stdio:'ignore'});
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(async r=>({c:r.status,j:await r.json().catch(()=>({}))}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const t=(n,ok)=>{console.log((ok?'✓ ':'✗ ')+n);if(!ok)fails++;};
(async()=>{
 for(let i=0;i<30;i++){try{const r=await fetch(B+'/healthz');if((await r.text())==='ok')break;}catch{}await sleep(200);}
 const a=await post('/api/login',{username:'admin',password:'adminpass1'});const at=a.j.token;
 await post('/api/state',{q:{token:at},full:{employees:[],branches:[{name:'B1',coords:'30.0,31.0',radiusMeters:150}]}});
 await post('/api/admin/users',{token:at,sap:'E1001',name:'Test',branch:'B1',role:'موظف',username:'emp1',password:'temp12345'});
 let l=await post('/api/login',{username:'emp1',password:'temp12345'});
 await post('/api/me/credentials',{token:l.j.token,oldPassword:'temp12345',newPassword:'newpass123'});
 l=await post('/api/login',{username:'emp1',password:'newpass123'});const et=l.j.token;
 const st=async()=>{const r=await post('/api/state',{q:{token:et},patch:{}});return r.j.view.employees.find(x=>x.sap==='E1001');};
 let e=await st();const patch=()=>post('/api/state',{q:{token:et},patch:{employees:[{id:e.id,status:'PRESENT',checkInTime:'09:00',geoVerified:true}]}}).then(r=>r.j.view.employees.find(x=>x.sap==='E1001'));
 t('بدون حدث سيرفر: الحضور يترفض',(await patch()).status!=='PRESENT');
 const out=await post('/api/attendance/event',{token:et,lat:30.01,lng:31.0,acc:10,deviceTime:Date.now(),deviceId:'d1'});
 t('حدث خارج النطاق: inside=false',out.j.inside===false);
 await sleep(2100);
 t('بعد حدث خارجي: الحضور يترفض',(await patch()).status!=='PRESENT');
 await sleep(2100);
 const inn=await post('/api/attendance/event',{token:et,lat:30.0005,lng:31.0,acc:10,deviceTime:Date.now(),deviceId:'d1'});
 t('حدث داخل النطاق: inside=true',inn.j.inside===true);
 t('بعد حدث داخلي: الحضور يتقبل',(await patch()).status==='PRESENT');
 sv.kill();process.exit(fails?1:0);
})();
