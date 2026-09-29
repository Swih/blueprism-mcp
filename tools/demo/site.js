// Original, loopback-only synthetic target; records provide independent business evidence.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { log } from "node:console";
import { setTimeout } from "node:timers";
import { URL } from "node:url";

const port = Number(env.BPDEMO_PORT ?? 8931);
const records = new Map();
const attempts = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const send = (status, data) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  };
  if (request.method === "GET" && url.pathname === "/records") {
    send(200, { records: [...records.values()], attempts: Object.fromEntries(attempts) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/submit") {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 4096) {
        send(413, { error: "Too large" });
        return;
      }
    }
    let item;
    try {
      item = JSON.parse(body);
    } catch {
      send(400, { error: "Invalid JSON" });
      return;
    }
    if (
      typeof item.caseKey !== "string" ||
      !/^demo-[a-z0-9-]{1,60}$/.test(item.caseKey) ||
      typeof item.displayName !== "string" ||
      item.displayName.length < 1 ||
      item.displayName.length > 80
    ) {
      send(400, { error: "Invalid synthetic item" });
      return;
    }
    attempts.set(item.caseKey, (attempts.get(item.caseKey) ?? 0) + 1);
    // Explicit business rejection: acknowledged, correlated and no business record created.
    if (/^demo-business-reject(?:-|$)/.test(item.caseKey)) {
      send(200, { confirmation: `REJECTED:${item.caseKey}` });
      return;
    }
    if (!records.has(item.caseKey))
      records.set(item.caseKey, {
        caseKey: item.caseKey,
        displayName: item.displayName,
        receipt: randomUUID(),
        createdAt: new Date().toISOString(),
      });
    // Commit succeeded, but the business acknowledgement is unreadable. Finish the HTTP
    // response so a transport retry cannot mask this deliberate application-level fault.
    if (/^demo-lost-ack(?:-|$)/.test(item.caseKey) && attempts.get(item.caseKey) === 1) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end('{"confirmation":');
      return;
    }
    send(200, { confirmation: `CONFIRMED:${item.caseKey}` });
    return;
  }
  if (request.method !== "GET" || url.pathname !== "/") {
    send(404, { error: "Not found" });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  });
  const id1 = `field-${randomUUID()}`,
    id2 = `field-${randomUUID()}`;
  const fields = [
    `<div><label for="${id1}">Case reference</label><input id="${id1}" autocomplete="off" required></div>`,
    `<div><label for="${id2}">Display name</label><input id="${id2}" autocomplete="off" required></div>`,
  ];
  if (Math.random() > 0.5) fields.reverse();
  const unavailable = url.searchParams.get("mode") === "unavailable";
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>BPDEV Service Desk</title>
<style>body{font:18px system-ui;background:#f4f6fa;color:#182335;margin:60px auto;max-width:740px}main{background:white;padding:40px;border-radius:16px;box-shadow:0 8px 40px #1231}small{color:#64748b}label{display:block;margin:22px 0 8px}input{font:inherit;padding:10px;width:95%;border:1px solid #bbb;border-radius:6px}button{font:inherit;background:#245bda;color:white;border:0;padding:14px 30px;border-radius:6px;margin-top:25px}output{display:block;color:#16713e;margin-top:25px;min-height:30px}</style>
<main><small>SYNTHETIC DEMO · NO REAL CUSTOMERS</small><h1>Create a service request</h1><p>Send one request and retain its confirmation.</p><form>${unavailable ? "<p>Temporarily unavailable</p>" : fields.join("")}<button ${unavailable ? "disabled" : ""}>Submit request</button></form><output aria-live="polite"></output></main>
<script>const form=document.querySelector('form'),out=document.querySelector('output');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;out.textContent='Submitting…';try{const reply=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caseKey:document.getElementById('${id1}')?.value,displayName:document.getElementById('${id2}')?.value})});const data=await reply.json();await new Promise(done=>setTimeout(done,450));out.textContent=reply.ok?data.confirmation:'REJECTED';}catch{out.textContent='Outcome unknown — reconcile the request';}finally{button.disabled=false;}});</script></html>`;
  // Delay initial render to exercise state-based waiting instead of immediate blind writes.
  setTimeout(() => {
    response.end(html);
  }, 350);
});
server.listen(port, "127.0.0.1", () => {
  log(`Synthetic demo: http://127.0.0.1:${port}/; evidence: /records`);
});
