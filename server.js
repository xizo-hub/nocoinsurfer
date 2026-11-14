// NoCoin Surfer — serveur comptes + matchmaking + 1v1 BO3
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const {WebSocketServer}=require("ws");
const PORT=process.env.PORT||3000;
const DB_FILE=process.env.DB_FILE||path.join(__dirname,"data.json");
const WINS_NEEDED=2;
const ALLOWED=(process.env.ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean); // ex: https://monsite.netlify.app
const ADMIN_KEY=process.env.ADMIN_KEY||"";
const ALLOW_SAME_IP=process.env.BLOCK_SAME_IP!=="1"; // mettre BLOCK_SAME_IP=1 pour interdire les duels entre même IP
const BAN_AT=6, MAX_PAIR=30, MAX_ACC_IP=3, MAX_CONN_IP=6;
const FONTS=["inter","orbitron","pacifico","pressstart","bebas","marker","cinzel","righteous"];
const COINS=["base","gold","galaxy","custom"], CAPES=["none","base","gold","galaxy","custom"];
const IMG_MAX=60000; // octets

/* ---------- Stockage ---------- */
let db={users:{},sessions:{},imgs:{}};
const UP_URL=(process.env.UPSTASH_REDIS_REST_URL||"").replace(/\/$/,""),UP_TOK=process.env.UPSTASH_REDIS_REST_TOKEN||"";
const REMOTE=!!(UP_URL&&UP_TOK);
async function rcmd(cmd){
  const r=await fetch(UP_URL,{method:"POST",headers:{Authorization:"Bearer "+UP_TOK,"Content-Type":"application/json"},body:JSON.stringify(cmd)});
  const j=await r.json();if(!r.ok||j.error)throw new Error(j.error||("HTTP "+r.status));return j.result}
const imgCache=new Map();
async function getImg(k){
  if(imgCache.has(k))return imgCache.get(k);
  let v=null;
  if(REMOTE){try{const r=await rcmd(["GET","nc:img:"+k]);v=r?JSON.parse(r):null}catch(e){return null}}
  else v=db.imgs[k]||null;
  if(v)imgCache.set(k,v);return v}
async function putImg(k,v){
  imgCache.set(k,v);
  if(REMOTE){for(let i=0;i<3;i++){try{await rcmd(["SET","nc:img:"+k,JSON.stringify(v)]);return}catch(e){await new Promise(r=>setTimeout(r,500))}}console.error("putImg échec",k)}
  else{db.imgs[k]=v;save()}}
function normalize(){db.users=db.users||{};db.sessions=db.sessions||{};db.imgs=db.imgs||{};
  for(const k in db.users){const u=db.users[k];u.rr=u.rr||0;u.best=u.best||0;u.wins=u.wins||0;u.losses=u.losses||0}}
let loaded=false;
async function init(){
  try{db=JSON.parse(fs.readFileSync(DB_FILE,"utf8"))}catch(e){}
  normalize();
  if(REMOTE){
    let r=null,ok=false;
    for(let i=0;i<5&&!ok;i++){try{r=await rcmd(["GET","nc:main"]);ok=true}catch(e){console.error("Upstash KO:",e.message);await new Promise(x=>setTimeout(x,2000))}}
    if(!ok){console.error("Upstash injoignable : arrêt pour ne pas écraser les données.");process.exit(1)}
    if(r){const m=JSON.parse(r);db={users:m.users||{},sessions:m.sessions||{},imgs:db.imgs||{}};console.log("Données chargées depuis Upstash :",Object.keys(db.users).length,"comptes")}
    else console.log("Upstash vide : migration des données locales.");
    normalize();
    for(const k of Object.keys(db.imgs)){await putImg(k,db.imgs[k])} // migration des images du fichier local
    db.imgs={};
  }
  loaded=true;saveNow();
}
let saveT=null,saving=false,again=false;
async function saveNow(){
  if(!loaded)return;
  if(REMOTE){
    if(saving){again=true;return}
    saving=true;
    try{await rcmd(["SET","nc:main",JSON.stringify({users:db.users,sessions:db.sessions})])}catch(e){console.error("save Upstash:",e.message);again=true}
    saving=false;if(again){again=false;setTimeout(saveNow,2000)}
  }else{const tmp=DB_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DB_FILE)}
}
function save(){if(saveT)return;saveT=setTimeout(()=>{saveT=null;saveNow()},300)}
const sha=s=>crypto.createHash("sha256").update(s).digest("hex");
const key=p=>p.toLowerCase();
function hashPw(pw,salt=crypto.randomBytes(16).toString("hex")){return{salt,hash:crypto.scryptSync(pw,salt,32).toString("hex")}}
function checkPw(pw,u){const h=crypto.scryptSync(pw,u.salt,32);return crypto.timingSafeEqual(h,Buffer.from(u.hash,"hex"))}
function newSession(pseudo){const tok=crypto.randomBytes(32).toString("hex");db.sessions[sha(tok)]={pseudo:key(pseudo),at:Date.now()};save();return tok}
const pub=u=>({pseudo:u.pseudo,wins:u.wins,losses:u.losses,best:u.best,rr:u.rr,font:u.font||"inter",coin:u.coin||"base",cape:u.cape||"none",av:u.avv||0,cn:u.cnv||0,cp:u.cpv||0})
function imgParse(d){
  const m=/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(String(d||""));if(!m)return null;
  const b=Buffer.from(m[1],"base64");if(b.length<100||b.length>IMG_MAX)return null;
  let mime=null;
  if(b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47)mime="image/png";
  else if(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)mime="image/jpeg";
  else if(b.toString("latin1",0,4)==="RIFF"&&b.toString("latin1",8,12)==="WEBP")mime="image/webp";
  return mime?{m:mime,b:m[1]}:null;
}
/* ---------- Anti-triche serveur ---------- */
function flag(ws,why,w=1){
  const u=ws&&db.users[ws.user];if(!u)return;
  u.flags=(u.flags||0)+w;(u.log=u.log||[]).push({at:Date.now(),why:String(why).slice(0,80),w});if(u.log.length>30)u.log.shift();
  if(u.flags>=BAN_AT&&!u.banned){u.banned=true;u.bannedAt=Date.now();
    const old=online.get(ws.user);if(old){send(old,{t:"banned"});forfeit(old);leaveQueue(old);old.user=null;old.close()}}
  save();
}
const pairHist=new Map(); // "a|b" -> timestamps
const pk=(a,b)=>a<b?a+"|"+b:b+"|"+a;
function pairCount(a,b){const arr=(pairHist.get(pk(a,b))||[]).filter(t=>Date.now()-t<36e5);pairHist.set(pk(a,b),arr);return arr.length}
const ipConn=new Map();
function rrChange(win,my,op){const d=(op-my)*0.08;return win?Math.round(Math.min(40,Math.max(12,24+d))):-Math.round(Math.min(32,Math.max(10,20-d)))}
function bump(uk,t){const u=db.users[uk];if(!u)return false;t=Math.round(t*100)/100;if(t>u.best){u.best=t;save();return true}return false}

/* ---------- HTTP ---------- */
const HTML=path.join(__dirname,"index.html");
const CSP="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self' wss: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,"http://x");
  if(url.pathname==="/health"){res.end("ok");return}
  let m=/^\/img\/(av|coin|cape)\/([A-Za-z0-9_-]{3,16})$/.exec(url.pathname);
  if(m){getImg(key(m[2])+":"+m[1]).then(im=>{
    if(!im){res.writeHead(404);res.end();return}
    res.writeHead(200,{"Content-Type":im.m,"Cache-Control":"public,max-age=31536000,immutable","Access-Control-Allow-Origin":"*","Cross-Origin-Resource-Policy":"cross-origin","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'"});
    res.end(Buffer.from(im.b,"base64"))});return}
  if(url.pathname.startsWith("/admin/")){
    const k=url.searchParams.get("key")||"";
    const ok=ADMIN_KEY&&k.length===ADMIN_KEY.length&&crypto.timingSafeEqual(Buffer.from(k),Buffer.from(ADMIN_KEY));
    if(!ok){res.writeHead(403);res.end("no");return}
    const p=key(url.searchParams.get("pseudo")||"");
    if(url.pathname==="/admin/backup"){res.writeHead(200,{"Content-Type":"application/json","Content-Disposition":"attachment; filename=nocoin-backup.json"});res.end(JSON.stringify({users:db.users,sessions:db.sessions}));return}
    if(url.pathname==="/admin/flags"){const o=Object.values(db.users).filter(u=>u.flags||u.banned).map(u=>({pseudo:u.pseudo,flags:u.flags,banned:!!u.banned,log:u.log}));res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(o,null,1));return}
    const u=db.users[p];if(!u){res.writeHead(404);res.end("inconnu");return}
    if(url.pathname==="/admin/ban"){u.banned=true;u.bannedAt=Date.now();const w=online.get(p);if(w){send(w,{t:"banned"});w.close()}}
    else if(url.pathname==="/admin/unban"){u.banned=false;u.flags=0;u.log=[]}
    save();res.end("ok");return}
  fs.readFile(HTML,(e,d)=>{if(e){res.writeHead(500);res.end("index.html manquant");return}
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache","Content-Security-Policy":CSP,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});res.end(d)});
});
const wss=new WebSocketServer({server,maxPayload:100000});

/* ---------- État en ligne ---------- */
const online=new Map(); // key -> ws
let queue=[];           // ws[]
const send=(ws,o)=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
const broadcastOnline=()=>{const n=online.size;for(const ws of online.values())send(ws,{t:"online",n})};

function leaveQueue(ws){queue=queue.filter(w=>w!==ws)}
function tryMatch(){
  queue=queue.filter(w=>w.readyState===1);
  for(let i=0;i<queue.length;i++)for(let j=i+1;j<queue.length;j++){
    const a=queue[i],b=queue[j];
    if(!ALLOW_SAME_IP&&a.ip===b.ip)continue;
    if(pairCount(a.user,b.user)>=MAX_PAIR)continue;
    queue=queue.filter(w=>w!==a&&w!==b);startMatch(a,b);return tryMatch();
  }
}

/* ---------- Match BO3 ---------- */
function startMatch(a,b){
  const m={p:[a,b],score:[0,0],round:0,seed:0,ready:[false,false],res:[null,null],goAt:0,phase:"idle",over:false};
  a.match=b.match=m;a.idx=0;b.idx=1;a.lastTick=b.lastTick=0;
  {const k=pk(a.user,b.user),arr=pairHist.get(k)||[];arr.push(Date.now());pairHist.set(k,arr)}
  send(a,{t:"match",opp:pub(db.users[b.user])});
  send(b,{t:"match",opp:pub(db.users[a.user])});
  setTimeout(()=>nextRound(m),2500);
}
function nextRound(m){
  if(m.over)return;
  m.round++;m.seed=crypto.randomInt(1,2**31);m.ready=[false,false];m.res=[null,null];m.phase="countdown";
  m.p.forEach((ws,i)=>send(ws,{t:"round",n:m.round,seed:m.seed,score:i===0?m.score:[m.score[1],m.score[0]]}));
}
function endRound(m){
  const [ta,tb]=m.res;m.phase="between";
  let w=-1;if(Math.abs(ta-tb)>=0.01)w=ta>tb?0:1;
  if(w>=0)m.score[w]++;else m.round--; // égalité : manche rejouée
  m.p.forEach((ws,i)=>{
    const me=i,op=1-i;
    send(ws,{t:"roundEnd",winner:w<0?"tie":(w===me?"you":"opp"),times:[m.res[me],m.res[op]],score:[m.score[me],m.score[op]]});
  });
  if(m.score[0]>=WINS_NEEDED||m.score[1]>=WINS_NEEDED)setTimeout(()=>endMatch(m,m.score[0]>m.score[1]?0:1,false),3500);
  else setTimeout(()=>nextRound(m),4000);
}
function endMatch(m,winner,forfeit){
  if(m.over)return;m.over=true;
  const us=m.p.map(ws=>db.users[ws.user]);
  const r0=us.map(u=>u?u.rr:0);
  m.p.forEach((ws,i)=>{
    const u=us[i];let rr=null;
    if(u){
      const win=i===winner;if(win)u.wins++;else u.losses++;
      const before=u.rr;u.rr=Math.max(0,before+rrChange(win,r0[i],r0[1-i]));rr={delta:u.rr-before,now:u.rr};
    }
    ws.match=null;
    send(ws,{t:"matchEnd",win:i===winner,forfeit,score:[m.score[i],m.score[1-i]],me:u&&pub(u),rr});
  });
  save();
}
function forfeit(ws){
  const m=ws.match;if(!m||m.over)return;
  const w=1-ws.idx;m.score[w]=Math.max(m.score[w],WINS_NEEDED);
  endMatch(m,w,true);
}

/* ---------- Auth ---------- */
const PSEUDO_RE=/^[A-Za-z0-9_-]{3,16}$/;
function login(ws,u,withToken){
  if(u.banned){send(ws,{t:"banned"});return}
  const old=online.get(key(u.pseudo));
  if(old&&old!==ws){send(old,{t:"kicked"});forfeit(old);leaveQueue(old);old.user=null;old.close()}
  ws.user=key(u.pseudo);online.set(ws.user,ws);
  send(ws,{t:"authed",me:pub(u),token:withToken});
  broadcastOnline();
}
const rl=new Map();
function limited(ip){const n=Date.now(),a=(rl.get(ip)||[]).filter(t=>n-t<60000);a.push(n);rl.set(ip,a);return a.length>12}

wss.on("connection",(ws,req)=>{
  const ip=(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim();
  const org=req.headers.origin;
  if(ALLOWED.length&&!ALLOWED.includes(org)){ws.close(1008,"origin");return}
  ws.ip=ip;const nc=(ipConn.get(ip)||0)+1;ipConn.set(ip,nc);
  if(nc>MAX_CONN_IP){ws.close(1008,"limit");ws.on("close",()=>ipConn.set(ip,Math.max(0,(ipConn.get(ip)||1)-1)));return}
  ws.on("close",()=>{const c=(ipConn.get(ip)||1)-1;if(c<=0)ipConn.delete(ip);else ipConn.set(ip,c)});
  ws.bucket=30;ws.bAt=Date.now();ws.over=0;
  ws.isAlive=true;ws.on("pong",()=>ws.isAlive=true);
  send(ws,{t:"online",n:online.size});
  ws.on("message",raw=>{
    const now=Date.now();ws.bucket=Math.min(30,ws.bucket+(now-ws.bAt)/1000*15);ws.bAt=now;
    if(--ws.bucket<0){ws.bucket=0;if(++ws.over>60){flag(ws,"flood",1);ws.terminate()}return}
    let d;try{d=JSON.parse(raw)}catch(e){return}
    if(!d||typeof d!=="object"||typeof d.t!=="string")return;
    if(d.t!=="img"&&raw.length>2048)return;
    switch(d.t){
      case"reg":{
        if(limited(ip))return send(ws,{t:"err",msg:"Trop de tentatives, réessaie dans une minute."});
        const p=String(d.pseudo||""),pw=String(d.pass||"");
        if(!PSEUDO_RE.test(p))return send(ws,{t:"err",msg:"Pseudo : 3-16 caractères (lettres, chiffres, _ -)."});
        if(pw.length<4||pw.length>100)return send(ws,{t:"err",msg:"Mot de passe : 4 caractères minimum."});
        if(db.users[key(p)])return send(ws,{t:"err",msg:"Ce pseudo est déjà pris."});
        const iph=sha(ip).slice(0,16);
        if(Object.values(db.users).filter(x=>x.iph===iph&&Date.now()-x.created<864e5).length>=MAX_ACC_IP)return send(ws,{t:"err",msg:"Trop de comptes créés depuis ta connexion aujourd'hui."});
        const u={pseudo:p,...hashPw(pw),wins:0,losses:0,best:0,rr:0,created:Date.now(),iph,font:"inter",coin:"base",cape:"none"};
        db.users[key(p)]=u;save();login(ws,u,newSession(p));break}
      case"login":{
        if(limited(ip))return send(ws,{t:"err",msg:"Trop de tentatives, réessaie dans une minute."});
        const u=db.users[key(String(d.pseudo||""))];
        if(!u||!checkPw(String(d.pass||""),u))return send(ws,{t:"err",msg:"Pseudo ou mot de passe incorrect."});
        if(u.banned)return send(ws,{t:"banned"});
        login(ws,u,newSession(u.pseudo));break}
      case"auth":{
        const s=db.sessions[sha(String(d.token||""))];const u=s&&db.users[s.pseudo];
        if(!u||u.banned)return send(ws,{t:"authFail"});
        login(ws,u,undefined);break}
      case"logout":{
        if(d.token){delete db.sessions[sha(String(d.token))];save()}
        if(ws.user){forfeit(ws);leaveQueue(ws);online.delete(ws.user);ws.user=null;broadcastOnline()}
        break}
      case"queue":{
        if(!ws.user||ws.match||queue.includes(ws))return;
        queue.push(ws);send(ws,{t:"queued"});tryMatch();break}
      case"unqueue":leaveQueue(ws);send(ws,{t:"unqueued"});break;
      case"ready":{
        const m=ws.match;if(!m||m.phase!=="countdown")return;
        m.ready[ws.idx]=true;
        if(m.ready[0]&&m.ready[1]){m.phase="play";m.goAt=Date.now();m.p.forEach(w=>send(w,{t:"go"}))}
        break}
      case"tick":{
        const m=ws.match;if(!m||m.phase!=="play")return;
        let tt=Number(d.time);if(!isFinite(tt)||tt<0)return;
        const el=(Date.now()-m.goAt)/1000;
        if(tt>el+2){flag(ws,"tick>serveur "+tt.toFixed(1)+"/"+el.toFixed(1),2);tt=el}
        if(tt<ws.lastTick-0.01){flag(ws,"tick recule",1);return}
        ws.lastTick=tt;
        send(m.p[1-ws.idx],{t:"opp",time:tt,dead:false});break}
      case"result":{
        const m=ws.match;if(!m||m.phase!=="play"||m.res[ws.idx]!=null)return;
        let t=Number(d.time);if(!isFinite(t)||t<0)return;
        const max=(Date.now()-m.goAt)/1000+1.5;
        if(t>max){flag(ws,"result>serveur "+t.toFixed(1)+"/"+max.toFixed(1),2);t=max}
        if(t>ws.lastTick+3){flag(ws,"result sans ticks "+t.toFixed(1)+"/"+ws.lastTick.toFixed(1),2);t=Math.min(t,ws.lastTick+3)}
        m.res[ws.idx]=t;bump(ws.user,t);
        send(m.p[1-ws.idx],{t:"opp",time:t,dead:true});
        if(m.res[0]!=null&&m.res[1]!=null)endRound(m);
        break}
      case"solostart":ws.soloAt=Date.now();ws.soloT=0;break;
      case"stick":{
        if(!ws.user||!ws.soloAt||ws.match)return;
        let tt=Number(d.time);if(!isFinite(tt)||tt<0)return;
        const el=(Date.now()-ws.soloAt)/1000;
        if(tt>el+2){flag(ws,"stick>serveur "+tt.toFixed(1)+"/"+el.toFixed(1),2);tt=el}
        ws.soloT=Math.max(ws.soloT||0,tt);break}
      case"score":{
        if(!ws.user||!ws.soloAt||ws.match)return;
        let t=Number(d.time);if(!isFinite(t)||t<=0)return;
        const max=(Date.now()-ws.soloAt)/1000+1.5,lt=ws.soloT||0;ws.soloAt=0;
        if(t>max||t>lt+3){flag(ws,"score invalide "+t.toFixed(1)+"/"+lt.toFixed(1),2);return send(ws,{t:"scoreRes",best:db.users[ws.user].best,record:false})}
        const rec=bump(ws.user,t);send(ws,{t:"scoreRes",best:db.users[ws.user].best,record:rec});break}
      case"lb":{
        const n=Date.now();if(ws.lbAt&&n-ws.lbAt<700)return;ws.lbAt=n;
        const mode=d.mode==="normal"?"normal":"ranked";
        const arr=Object.entries(db.users).filter(([k,u])=>!u.banned&&(mode==="ranked"?(u.wins+u.losses)>0:u.best>0));
        arr.sort(mode==="ranked"?((a,b)=>b[1].rr-a[1].rr||b[1].wins-a[1].wins):((a,b)=>b[1].best-a[1].best));
        const rows=arr.slice(0,50).map(([k,u])=>({pseudo:u.pseudo,rr:u.rr,wins:u.wins,losses:u.losses,best:u.best,font:u.font||"inter",av:u.avv||0}));
        const pos=ws.user?arr.findIndex(([k])=>k===ws.user)+1:0;
        send(ws,{t:"lb",mode,rows,pos});break}
      case"prof":{
        const n=Date.now();if(ws.pfAt&&n-ws.pfAt<500)return;ws.pfAt=n;
        const u=db.users[key(String(d.pseudo||"").slice(0,16))];if(!u||u.banned)return send(ws,{t:"err",msg:"Profil introuvable."});
        send(ws,{t:"prof",p:pub(u)});break}
      case"img":{
        if(!ws.user)return;const u=db.users[ws.user];
        const n=Date.now();ws.imgN=(ws.imgN||[]).filter(t=>n-t<60000);if(ws.imgN.length>=6)return send(ws,{t:"err",msg:"Trop d'envois, réessaie dans une minute."});ws.imgN.push(n);
        if(!["av","coin","cape"].includes(d.kind))return;
        const im=imgParse(d.data);if(!im)return send(ws,{t:"err",msg:"Image refusée (PNG/JPEG/WebP, 60 Ko max)."});
        putImg(ws.user+":"+d.kind,im);
        if(d.kind==="av")u.avv=n;else if(d.kind==="coin")u.cnv=n;else u.cpv=n;
        save();send(ws,{t:"me",me:pub(u)});break}
      case"cos":{
        if(!ws.user)return;const u=db.users[ws.user];
        const f=String(d.font),c=String(d.coin),k=String(d.cape);
        if(!FONTS.includes(f)||!COINS.includes(c)||!CAPES.includes(k))return;
        if(c==="custom"&&!u.cnv)return send(ws,{t:"err",msg:"Importe d'abord une image de pièce."});
        if(k==="custom"&&!u.cpv)return send(ws,{t:"err",msg:"Importe d'abord une image de cape."});
        u.font=f;u.coin=c;u.cape=k;save();send(ws,{t:"me",me:pub(u)});break}
      case"ac":{ // rapport client : journalisé seulement (faux positifs possibles), jamais de ban auto
        if(!ws.user)return;const u=db.users[ws.user];
        (u.log=u.log||[]).push({at:Date.now(),why:"client:"+String(d.codes||"").slice(0,60),w:0});if(u.log.length>30)u.log.shift();save();break}
      case"leave":forfeit(ws);break;
    }
  });
  ws.on("close",()=>{
    leaveQueue(ws);forfeit(ws);
    if(ws.user&&online.get(ws.user)===ws){online.delete(ws.user);broadcastOnline()}
  });
});
setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},25000);
setInterval(()=>{const lim=Date.now()-365*864e5;let c=0;for(const k in db.sessions)if(db.sessions[k].at<lim){delete db.sessions[k];c++}if(c)save()},36e5);
init().then(()=>server.listen(PORT,()=>console.log("NoCoin Surfer sur http://localhost:"+PORT))).catch(e=>{console.error(e);process.exit(1)});
