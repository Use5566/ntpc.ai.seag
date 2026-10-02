import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const allowed=new Set(['index.html','styles.css','app.js','core.js','icon.svg','prompt-system.txt','prompt-analyze.txt','prompt-revise.txt','prompt-output-schema.txt']);
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.txt':'text/plain'};
const port=Number(process.env.PORT||4173);
http.createServer(async(req,res)=>{let name;try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/ntpc\.ai\.seag\//,'/').replace(/^\//,'')||'index.html';}catch{res.writeHead(400).end();return;}if(!allowed.has(name)){res.writeHead(404).end('Not found');return;}try{const data=await fs.readFile(path.join(root,name));res.writeHead(200,{'Content-Type':`${types[path.extname(name)]||'text/plain'}; charset=utf-8`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).end(data);}catch{res.writeHead(404).end('Not found');}}).listen(port,'127.0.0.1',()=>console.log(`SEAG preview: http://127.0.0.1:${port}`));
