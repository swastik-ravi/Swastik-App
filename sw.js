const V = "swastik-v4";
const FILES = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))));
  self.clients.claim();
});
// Cache first (opens instantly on slow/no net), refreshed quietly in the background.
// Only good (200) answers replace the saved copy, so a GitHub error never breaks the app.
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(r => {
      if (r && r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); }
      return r;
    }).catch(() => hit || Response.error());
    return hit || net;
  }));
});

/* ===== BACKGROUND UPLOAD =====
   When the phone gets internet again, the browser wakes this service worker (even if the app is closed)
   and it uploads the entries that are waiting on the phone. Works on Android Chrome; where it is not
   supported the app uploads as soon as it is opened. The server ignores an entry it has already saved,
   so it is safe if the app and this worker both send the same entry. */
const idb = () => new Promise((res, rej) => { const q = indexedDB.open("swastik", 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
const idbGet = (db, store, key) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbAll = (db, store) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
const idbPut = (db, store, key, val) => new Promise((res, rej) => { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
const idbDel = (db, store, key) => new Promise((res, rej) => { const t = db.transaction(store, "readwrite"); t.objectStore(store).delete(key); t.oncomplete = res; t.onerror = () => rej(t.error); });

async function flushOutbox() {
  const db = await idb();
  if (!db.objectStoreNames.contains("outbox") || !db.objectStoreNames.contains("kv")) return;
  const ops = (await idbAll(db, "outbox")).sort((a, b) => a.ts - b.ts);
  if (!ops.length) return;
  const session = await idbGet(db, "kv", "session"), url = await idbGet(db, "kv", "apiUrl");
  if (!session || !session.token || !url) return;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "sync", token: session.token, ops: ops }) });
  const j = await r.json();
  if (!j || j.auth === false || !j.ok) return;           // the app deals with this when it is opened
  for (const x of j.results) if (x.ok || x.drop) await idbDel(db, "outbox", x.opId);
  if (j.attendance) await idbPut(db, "kv", "snap", j.attendance);
  if (j.leaves) await idbPut(db, "kv", "leaves", j.leaves);
  if (j.assam) await idbPut(db, "kv", "assam", j.assam);
  await idbPut(db, "kv", "lastOnline", Date.now());
  if (j.results.some(x => !x.ok && !x.drop)) throw new Error("retry");   // let the browser try again later
}

self.addEventListener("sync", e => { if (e.tag === "swastik-sync") e.waitUntil(flushOutbox()); });
