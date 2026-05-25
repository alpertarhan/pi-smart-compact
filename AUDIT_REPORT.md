# pi-smart-compact Audit Raporu

> **Tarih:** 2026-05-26  
> **Kapsam:** v7.13.0 tam kaynak kodu, testleri (276 pass / 0 fail), dokümantasyon, mimari ve build pipeline  
> **Yaklaşım:** Statik analiz, tip güvenliği kontrolu, anti-pattern tespiti, dokuman-uygulama eslesmesi ve edge-case taramasi

---

## P0 — Kritik Bug'lar (Hemen Duzeltilmeli)

### 1. `parseExplorationReport`: Tek Tirnak Replacement'i JSON'i Bozuyor
**Dosya:** `src/phases/explore.ts:98`

```ts
const cleaned = rawJson
  .replace(/\/\*[\s\S]*?\*\//g, "")   // strip comments
  .replace(/'/g, "\"")                   // <- BUG
  .replace(/,\s*([}\]])/g, "$1");
```

**Sorun:** Eger LLM'in dondurdugu exploration JSON'inda bir string icinde tek tirnak (`'`) varsa — ornegin `{"mainGoal": "Don't refactor the DB layer"}` — bu replacement gecersiz JSON uretir: `{"mainGoal": "Don"t refactor the DB layer"}`.  
**Sonuc:** `JSON.parse` basarisiz olur, ikinci parse denemesi de patlar. Fallback'e duser ve `mainGoal`/`keyTopics` gibi kritik bilgileri kaybetme riski var. Bu da maliyetli bir tekrar LLM cagrisina yol acar.  
**Duzeltme:** `'` -> `"` replacement'i tamamen kaldirin veya sadece JSON key pattern'larini hedefleyen bir repair kullanin.

### 2. `getDefaultServices()` Kullanimi — Global State Riski
**Dosya:** `src/phases/explore.ts:187, 206`

```ts
const toolSupport = getDefaultServices().toolSupport;
```

**Sorun:** `exploreConversation` dogrudan global `getDefaultServices()`'e erisiyor. `run-smart-compact.ts` her run basinda `resetDefaultServices()` cagiriyor. Ayni Node process'te iki farkli session eszamanli calisirsa birinin reset'i digerinin `toolSupport` cache'ini silebilir.  
**Duzeltme:** `exploreConversation` fonksiyonuna `rc.services` parametre olarak gecilmeli.

---

## P1 — Onemli Bug'lar / Mantik Hatalari

### 3. `pruneRedundant`: Sabit Kodlanmis 400 vs `MAX_TOOL_OUTPUT_CHARS`
**Dosya:** `src/utils/pruning.ts:35-40`

```ts
const MAX_TOOL_OUTPUT_CHARS = 800;
if (text.length > MAX_TOOL_OUTPUT_CHARS) {
  const head = text.slice(0, 400);   // <- sabit 400
  const marker = "\n\n... [truncated ...\n\n";
  const tail = text.slice(-400);     // <- sabit 400
  text = head + marker + tail;
}
```

**Sorun:** `MAX_TOOL_OUTPUT_CHARS = 800` ama truncation 400+400 sabit kodlanmis. Gelecekte sabit degisirse kod guncellenmeyecek. Ayrica `head + marker + tail` toplami 800'u asiyor.  
**Duzeltme:** `headSize = Math.floor((MAX_TOOL_OUTPUT_CHARS - marker.length) / 2)` seklinde dinamik hesaplayin.

### 4. `selectModel`: Tum Modeller `supportsTools: true`
**Dosya:** `src/ui/overlays.ts:130`

```ts
available.map(m => ({ ...m, supportsTools: true }))
```

**Sorun:** UI'da tum modeller tool destekliyormus gibi gosteriliyor. Oysa `explore.ts` runtime probe ile gercek destegi kontrol ediyor. UI yaniltici bilgi gosteriyor.  
**Duzeltme:** `supportsTools` field'i kaldirilmali veya runtime probe sonuclarina gore set edilmeli.

### 5. `explore.ts`: `JSON.stringify` Siralama Belirsizligi
**Dosya:** `src/phases/explore.ts:147`

```ts
JSON.stringify(block).toLowerCase().includes(target)
```

**Sorun:** `JSON.stringify` obje key sirasini garanti etmez. `target` string search ile aranirken farkli sirada yazilmis JSON hedefi bulamayabilir.  
**Duzeltme:** Spesifik key'leri kontrol edin: `block.path === target || block.file === target`.

### 6. `extractUserNote`: `/` Iceren Token'lar Atlaniyor
**Dosya:** `src/utils/helpers.ts:393`

```ts
tokens.filter(t => !t.includes("/") && !SKIP.has(t.toLowerCase()))
```

**Sorun:** Kullanici notunda `src/auth.ts hakkinda` veya `fix the bug in utils/` gibi bir ifade varsa `/` iceren token'lar filtreleniyor. Bu beklenmedik davranis; kullanici notu zarar gorebilir.  
**Duzeltme:** Filtreleme mantigini gozden gecirin — muhtemelen `http://` veya `file://` skiplamak icin konulmus ama cok agresif.

---

## P2 — Anti-Pattern'ler ve Kod Kalitesi Sorunlari

### 7. Dead / Unused Import'lar
**Dosyalar:** `src/phases/synthesize.ts`, `src/phases/verify.ts`, `src/phases/explore.ts`

**Sorun:** Uc dosyada da `CacheAwareOptions` import edilmis ama hic kullanilmiyor.  
**Duzeltme:** ESLint `no-unused-vars` veya benzeri kural eklenmeli. Import'lar temizlenmeli.

### 8. `any[]` Kullanimi
**Dosya:** `src/phases/explore.ts:225`

```ts
messages: any[]
```

**Sorun:** `exploreConversation` fonksiyonunun `messages` parametresi `any[]` tipinde. Bu, type safety'yi dusuruyor ve refactor sirasinda hatali kullanimlara yol acabilir.  
**Duzeltme:** `LlmMessage[]` veya daha spesifik bir tip kullanilmali.

### 9. Gereksiz Type Assertion
**Dosya:** `src/app/steps/synthesize.ts:141`

```ts
failedChunkSummary: ch.messages.map(m => (m as LlmMessage)),
```

**Sorun:** `ch.messages` zaten `LlmMessage[]` tipinde. `as LlmMessage` cast'i gereksiz.  
**Duzeltme:** Cast kaldirilmali.

### 10. `as unknown as` Cast
**Dosya:** `src/index.ts:187`

```ts
ctx as unknown as ExtensionCommandContext
```

**Sorun:** `session_before_compact` event handler'i farkli bir context tipi aliyor ve `unknown` uzerinden cast yapiliyor. Bu runtime hatasi riski tasiyor.  
**Duzeltme:** `session_before_compact` icin ozel bir handler tipi tanimlanmali veya `ExtensionCommandContext` ile uyumlu hale getirilmeli.

### 11. `computeToolCharPercentage`: `type` Kontrolu Eksik
**Dosya:** `src/utils/helpers.ts:360`

```ts
if (Array.isArray(blocks)) {
  for (const part of blocks) {
    const text = (part as any).text || (part as any).content;
    // ...
  }
}
```

**Sorun:** `part.type === "text"` kontrolu yapilmiyor. Eger `toolCall` block'larinin `text` field'i olursa (simdilik yok), yanlis hesaplama yapilir.  
**Duzeltme:** `part.type === "text"` kontrolu eklenmeli.

---

## P2 — Performans Gap'leri

### 12. `estimateTokens`: Her Cagrida Regex
**Dosya:** `src/utils/tokens.ts:19`

```ts
const isTurkish = /[cC][\u0307\u0300\u0301\u0302\u0308]?/.test(text) || /[gG][\u0306]/.test(text) || /[Iiİı]/.test(text);
```

**Sorun:** Her token hesaplamada regex calistiriliyor. Cok buyuk bir sorun degil ama binlerce mesaj icin toplamda kucuk bir overhead.  
**Duzeltme:** Turkce detection'i bir kere yapip `cachedIsTurkish` seklinde tutabilir veya daha hizli bir karakter set kontrolu kullanilabilir.

### 13. `acquireLockSync`: Spin-Lock
**Dosya:** `src/infra/fs.ts:70`

```ts
while (Date.now() < until) {}
```

**Sorun:** 25ms'lik bir spin-lock CPU'yu %100 kullanir. Nadir cagrilsa da kabul edilebilir olsa da, `Atomics.wait` veya `setImmediate` ile backoff daha iyi olur. Node.js sync FS context'inde `setImmediate` kullanilamaz ama `sleep` veya `usleep` mekanizmalari dusunulebilir.  
**Duzeltme:** Spin yerine `fs.existsSync` loop'u ile exponential backoff eklenebilir. Pratikte cok kritik degil.

### 14. `ensureMissingSection`: Switch-Case Yerine If-Else
**Dosya:** `src/phases/verify.ts:270`

```ts
if (kind === "goal") return ensureGoal(parsed);
if (kind === "openLoop") return ensureOpenLoops(parsed);
// ...
```

**Sorun:** Yeni bir section turu eklendiginde buraya eklenmesi unutulabilir. `classifyHeading` ile `canonicalHeading` zaten tanimli.  
**Duzeltme:** `SECTIONS` array'ini iterate ederek otomatik kontrol yapilabilir. Ayrica `default` case'te `log.warn` eklenmeli.

---

## P3 — Mimari ve Dokumantasyon Eksiklikleri

### 15. `trackFileOps`: Sadece "write" ve "edit" Iceren Tool'lar
**Dosya:** `src/utils/extraction.ts:495`

```ts
if (tool.includes("write") || tool.includes("edit")) {
```

**Sorun:** Eger bir tool adi "patch", "diff", "create", "append" gibi bir isimle gelirse, file operation olarak tanimlanmaz. Bu genisletilebilirlik gap'i.  
**Duzeltme:** Daha kapsamli bir allowlist veya `m.toolArgs?.path` varsa otomatik file op olarak kabul etme mantigi.

### 16. `computeDelta`: 60 Karakter Truncation
**Dosya:** `src/utils/state.ts:80`

```ts
const key = (summary: string) => summary.toLowerCase().slice(0, 60);
```

**Sorun:** Kararlar 60 karakterden uzunsa, farkli kararlar ayni key'e dusebilir. Pratikte cok nadir ama teorik bir collision riski.  
**Duzeltme:** Tam metin hash'lenip karsilastirilabilir veya truncation limiti artirilabilir.

### 17. Test Coverage Gap: `overlays.ts` ve `damage.ts`
**Sorun:** `overlays.ts` (TUI) ve `damage.ts` (post-compaction) icin hicbir test dosyasi yok. `damage.ts` kritik bir dosya cunku compaction sonrasi bozulmayi tespit ediyor.  
**Duzeltme:** En azindan `damage.ts` icin birim testleri yazilmali.

### 18. `llm-client.ts`: `throttleDelay` vs `retryDelay`
**Dosya:** `src/infra/llm-client.ts:40`

```ts
// setThrottle(...)
```

**Sorun:** `setThrottle` ile `callLLM` ayri mekanizmalar. Throttle global, retry per-call. Eger ayni anda cok fazla paralel call yapilirsa, throttle rate-limit'i engelleyebilir ama retry mekanizmasi bunu handle ediyor.  
**Not:** Bu tasarim karari olabilir, ama merkezi bir rate-limiter daha temiz olur.

---

## Olumlu Bulgular

- **Test Coverage:** 276 test, 0 fail. Kritik path'ler (`verify`, `extraction`, `pruning`, `tokens`, `llm-retry`) test edilmis.
- **State Machine:** `RunContext` stage machine'i type-safe. `advance` fonksiyonu compile-time guvenlik sagliyor.
- **Atomic Writes:** `writeJsonSync` temp+rename pattern'i kullaniyor. Crash aninda yarim dosya birakma riski yok.
- **Version Sync:** `package.json` (7.13.0), `constants.ts` (7.13.0), ve ROADMAP hedefleri uyumlu.
- **Error Handling:** `runSmartCompact` icinde `try/finally` ile `timeoutId` ve `isRunning` temizleniyor.
- **Cache Invalidation:** `CompactionStateFile` icinde TTL kontrolu var. `messageCount` tabanli cache key'i dogru calisiyor.

---

## Oncelikli Aksiyon Plani

| Oncelik | Madde | Tahmini Efor |
|---------|-------|--------------|
| P0 | `parseExplorationReport` tek tirnak fix | 15 dk |
| P0 | `explore.ts` global services -> DI | 30 dk |
| P1 | `pruneRedundant` dinamik truncation | 15 dk |
| P1 | `selectModel` supportsTools fix | 10 dk |
| P1 | `explore.ts` JSON.stringify fix | 15 dk |
| P1 | `extractUserNote` `/` filter fix | 20 dk |
| P2 | Unused import'lari temizle | 10 dk |
| P2 | `any[]` -> `LlmMessage[]` | 10 dk |
| P2 | `damage.ts` testleri yaz | 1-2 saat |
| P3 | `trackFileOps` genisletilebilirlik | 20 dk |
