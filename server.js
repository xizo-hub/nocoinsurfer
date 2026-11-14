// NoCoin Surfer — serveur comptes + matchmaking + 1v1 BO3
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const {WebSocketServer}=require("ws");
const PORT=process.env.PORT||3000;
const DB_FILE=process.env.DB_FILE||path.join(__dirname,"data.json");
const WINS_NEEDED=2;

/* ---------- Stockage ---------- */
let db={users:{},sessions:{}};
try{db=JSON.parse(fs.readFileSync(DB_FILE,"utf8"))}catch(e){}
for(const k in db.users){const u=db.users[k];u.rr=u.rr||0;u.best=u.best||0;u.wins=u.wins||0;u.losses=u.losses||0}
let saveT=null;
function save(){if(saveT)return;saveT=setTimeout(()=>{saveT=null;const tmp=DB_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DB_FILE)},300)}
const sha=s=>crypto.createHash("sha256").update(s).digest("hex");
const key=p=>p.toLowerCase();
function hashPw(pw,salt=crypto.randomBytes(16).toString("hex")){return{salt,hash:crypto.scryptSync(pw,salt,32).toString("hex")}}
function checkPw(pw,u){const h=crypto.scryptSync(pw,u.salt,32);return crypto.timingSafeEqual(h,Buffer.from(u.hash,"hex"))}
function newSession(pseudo){const tok=crypto.randomBytes(32).toString("hex");db.sessions[sha(tok)]={pseudo:key(pseudo),at:Date.now()};save();return tok}
const pub=u=>({pseudo:u.pseudo,wins:u.wins,losses:u.losses,best:u.best,rr:u.rr})
function rrChange(win,my,op){const d=(op-my)*0.08;return win?Math.round(Math.min(40,Math.max(12,24+d))):-Math.round(Math.min(32,Math.max(10,20-d)))}
function bump(uk,t){const u=db.users[uk];if(!u)return false;t=Math.round(t*100)/100;if(t>u.best){u.best=t;save();return true}return false}

/* ---------- HTTP ---------- */
const HTML=path.join(__dirname,"index.html");
const server=http.createServer((req,res)=>{
  if(req.url==="/health"){res.end("ok");return}
  fs.readFile(HTML,(e,d)=>{if(e){res.writeHead(500);res.end("index.html manquant");return}
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});res.end(d)});
});
const wss=new WebSocketServer({server,maxPayload:4096});

/* ---------- État en ligne ---------- */
const online=new Map(); // key -> ws
let queue=[];           // ws[]
const send=(ws,o)=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
const broadcastOnline=()=>{const n=online.size;for(const ws of online.values())send(ws,{t:"online",n})};

function leaveQueue(ws){queue=queue.filter(w=>w!==ws)}
function tryMatch(){
  while(queue.length>=2){
    const a=queue.shift(),b=queue.shift();
    if(a.readyState!==1){if(b.readyState===1)queue.unshift(b);continue}
    if(b.readyState!==1){queue.unshift(a);continue}
    startMatch(a,b);
  }
}

/* ---------- Match BO3 ---------- */
function startMatch(a,b){
  const m={p:[a,b],score:[0,0],round:0,seed:0,ready:[false,false],res:[null,null],goAt:0,phase:"idle",over:false};
  a.match=b.match=m;a.idx=0;b.idx=1;
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
  ws.isAlive=true;ws.on("pong",()=>ws.isAlive=true);
  send(ws,{t:"online",n:online.size});
  ws.on("message",raw=>{
    let d;try{d=JSON.parse(raw)}catch(e){return}
    switch(d.t){
      case"reg":{
        if(limited(ip))return send(ws,{t:"err",msg:"Trop de tentatives, réessaie dans une minute."});
        const p=String(d.pseudo||""),pw=String(d.pass||"");
        if(!PSEUDO_RE.test(p))return send(ws,{t:"err",msg:"Pseudo : 3-16 caractères (lettres, chiffres, _ -)."});
        if(pw.length<4||pw.length>100)return send(ws,{t:"err",msg:"Mot de passe : 4 caractères minimum."});
        if(db.users[key(p)])return send(ws,{t:"err",msg:"Ce pseudo est déjà pris."});
        const u={pseudo:p,...hashPw(pw),wins:0,losses:0,best:0,rr:0,created:Date.now()};
        db.users[key(p)]=u;save();login(ws,u,newSession(p));break}
      case"login":{
        if(limited(ip))return send(ws,{t:"err",msg:"Trop de tentatives, réessaie dans une minute."});
        const u=db.users[key(String(d.pseudo||""))];
        if(!u||!checkPw(String(d.pass||""),u))return send(ws,{t:"err",msg:"Pseudo ou mot de passe incorrect."});
        login(ws,u,newSession(u.pseudo));break}
      case"auth":{
        const s=db.sessions[sha(String(d.token||""))];const u=s&&db.users[s.pseudo];
        if(!u)return send(ws,{t:"authFail"});
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
        send(m.p[1-ws.idx],{t:"opp",time:Number(d.time)||0,dead:false});break}
      case"result":{
        const m=ws.match;if(!m||m.phase!=="play"||m.res[ws.idx]!=null)return;
        let t=Number(d.time);if(!isFinite(t)||t<0)return;
        const max=(Date.now()-m.goAt)/1000+1.5;if(t>max)t=max; // anti-triche basique
        m.res[ws.idx]=t;bump(ws.user,t);
        send(m.p[1-ws.idx],{t:"opp",time:t,dead:true});
        if(m.res[0]!=null&&m.res[1]!=null)endRound(m);
        break}
      case"solostart":ws.soloAt=Date.now();break;
      case"score":{
        if(!ws.user||!ws.soloAt||ws.match)return;
        let t=Number(d.time);if(!isFinite(t)||t<=0)return;
        const max=(Date.now()-ws.soloAt)/1000+1.5;ws.soloAt=0;if(t>max)t=max;
        const rec=bump(ws.user,t);send(ws,{t:"scoreRes",best:db.users[ws.user].best,record:rec});break}
      case"lb":{
        const n=Date.now();if(ws.lbAt&&n-ws.lbAt<700)return;ws.lbAt=n;
        const mode=d.mode==="normal"?"normal":"ranked";
        const arr=Object.entries(db.users).filter(([k,u])=>mode==="ranked"?(u.wins+u.losses)>0:u.best>0);
        arr.sort(mode==="ranked"?((a,b)=>b[1].rr-a[1].rr||b[1].wins-a[1].wins):((a,b)=>b[1].best-a[1].best));
        const rows=arr.slice(0,50).map(([k,u])=>({pseudo:u.pseudo,rr:u.rr,wins:u.wins,losses:u.losses,best:u.best}));
        const pos=ws.user?arr.findIndex(([k])=>k===ws.user)+1:0;
        send(ws,{t:"lb",mode,rows,pos});break}
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
server.listen(PORT,()=>console.log("NoCoin Surfer sur http://localhost:"+PORT));
