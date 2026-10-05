// Portföy Dengeleyici — arayüz, kayıt, fiyat çekme
(function () {
  'use strict';

  var KEY = 'pd.v1';
  var VERSION = 10;
  var SCHEMA = 2;        // veri yapısı sürümü — 2: ALTINS1 kaldırıldı, hedefler 60/20/20
  var SCAN_URL = 'https://scanner.tradingview.com/global/scan';
  var FX_SYM = 'FX_IDC:USDTRY';
  var REMIND_DAYS = 25;
  var DEV_LIMIT = 5;
  var MIN_BUY = 500;     // bunun altındaki alımlar önerilmez (TL)
  var AUTO_MS = 60 * 1000; // uygulama açıkken otomatik yenileme aralığı

  var DEFAULT_ASSETS = [
    { id: 'voo', name: 'VOO', currency: 'USD', target: 60, symbol: 'AMEX:VOO', qty: 0 },
    { id: 'qqq', name: 'QQQ', currency: 'USD', target: 20, symbol: 'NASDAQ:QQQ', qty: 0 },
    { id: 'vxus', name: 'VXUS', currency: 'USD', target: 20, symbol: 'NASDAQ:VXUS', qty: 0 }
  ];

  function freshState() {
    return {
      schema: SCHEMA,
      assets: JSON.parse(JSON.stringify(DEFAULT_ASSETS)),
      prices: {},        // { assetId: { value } }
      fx: null,          // { value }
      updatedAt: null,   // son başarılı çekme
      amount: null,      // son girilen eklenecek tutar
      history: []        // aylık kayıtlar
    };
  }

  var state = freshState();
  var view = 'home';
  var result = null;     // son hesap sonucu (ekranda tutulur)
  var applied = false;   // alımlar adetlere eklendi mi
  var appliedTs = null;  // uygulanan alımın Geçmiş kaydı (geri alma için)
  var amountText = null; // tutar alanına yazılan ama henüz hesaplanmamış metin
  var editing = false;   // adetler kilitli; yalnızca "Adetleri düzenle" ile açılır
  var qtyText = {};      // düzenleme sırasında yazılan adetler (kaydedilene dek)
  var fetchStatus = null;
  var fetching = false;

  // ---------- Kayıt (localStorage + IndexedDB kopyası) ----------

  function readLocal() {
    try { var s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('idb yok'));
      var req = indexedDB.open('dengeleyici', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var db = req.result;
        var tx = db.transaction('kv', mode);
        var r = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { db.close(); resolve(r && r.result); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      };
    });
  }

  function save() {
    var json = JSON.stringify(state);
    try { localStorage.setItem(KEY, json); } catch (e) {}
    idb('readwrite', function (s) { return s.put(json, KEY); }).catch(function () {});
  }

  var migrated = false;  // açılışta eski veri yeni yapıya taşındıysa kaydetmek için

  function normalize(s) {
    var base = freshState();
    if (!s || !Array.isArray(s.assets)) return base;
    if (!s.schema) s.schema = 1;
    for (var k in base) if (!(k in s)) s[k] = base[k];
    if (s.schema < 2) { migrateNoGold(s); migrated = true; }
    return s;
  }

  function isAltins(name) { return String(name || '').toUpperCase() === 'ALTINS1'; }

  // Şema 1 → 2: ALTINS1 ve altınla ilgili her şey kalkar; fon adetleri korunur.
  // Geçmiş kayıtlarından ALTINS1 satırları silinir, toplamları üç fona göre yeniden hesaplanır.
  function migrateNoGold(s) {
    s.assets = DEFAULT_ASSETS.map(function (d) {
      var old = s.assets.filter(function (a) { return a.id === d.id; })[0];
      var qty = old && typeof old.qty === 'number' && isFinite(old.qty) ? old.qty : 0;
      return Object.assign({}, d, { qty: qty });
    });
    var keep = {};
    DEFAULT_ASSETS.forEach(function (d) { keep[d.id] = true; });
    Object.keys(s.prices || {}).forEach(function (id) { if (!keep[id]) delete s.prices[id]; });
    delete s.gram;
    (s.history || []).forEach(function (rec) {
      rec.assets = (rec.assets || []).filter(function (a) { return !isAltins(a.name); });
      if (rec.added) rec.added = rec.added.filter(function (x) { return !isAltins(x.name); });
      delete rec.gram;
      var usdTotal = 0;
      var ok = rec.fx > 0 && rec.assets.every(function (a) {
        if (a.currency !== 'USD' || !(a.price > 0) || !(a.qty >= 0)) return false;
        usdTotal += a.qty * a.price;
        return true;
      });
      if (ok) { rec.totalUSD = usdTotal; rec.totalTL = usdTotal * rec.fx; }
    });
    s.schema = 2;
  }

  // ---------- Biçim ----------

  var nfCache = {};
  function fmt(n, min, max) {
    if (n == null || !isFinite(n)) return '—';
    if (max == null) max = min;
    var k = min + '-' + max;
    if (!nfCache[k]) nfCache[k] = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: min, maximumFractionDigits: max });
    return nfCache[k].format(n);
  }
  function tl(n) { return fmt(n, 0) + ' TL'; }
  function tl2(n) { return fmt(n, 2) + ' TL'; }
  function usd(n) { return fmt(n, 2) + ' $'; }
  function pct(n) { return n == null || !isFinite(n) ? '—' : '%' + fmt(n, 1); }
  function units(n, cur) { return cur === 'USD' ? fmt(n, 0, 4) : fmt(n, 0); }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), 1); }
  function dateTime(ts) {
    return new Date(ts).toLocaleString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function date(ts) {
    return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function inputVal(n, maxDec) { return n == null ? '' : fmt(n, 0, maxDec == null ? 4 : maxDec).replace(/\./g, ''); }

  // "1.234,56" / "1234.56" / "12,5" → sayı; boş → null; bozuk → NaN
  function parseNum(str) {
    var s = String(str == null ? '' : str).replace(/[\s$%]|TL/gi, '');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
    return Number(s);
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  // ---------- Veri yardımcıları ----------

  function priceOf(a) { var p = state.prices[a.id]; return p ? p.value : null; }
  function fxVal() { return state.fx ? state.fx.value : null; }

  function calcInput() {
    return state.assets.map(function (a) {
      return { id: a.id, name: a.name, currency: a.currency, target: a.target, qty: a.qty, price: priceOf(a) };
    });
  }

  function lastRecord() { return state.history.length ? state.history[state.history.length - 1] : null; }

  // ---------- Fiyat çekme ----------

  // quiet: otomatik yenileme — "alınıyor" yazısı ve bildirim balonu göstermez
  function refresh(quiet) {
    if (fetching) return;
    fetching = true;
    if (!quiet) {
      fetchStatus = { text: 'Fiyatlar alınıyor…' };
      render();
    }

    var withSym = state.assets.filter(function (a) { return a.symbol; });
    var tickers = withSym.map(function (a) { return a.symbol; }).concat([FX_SYM]);
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);

    // Gövde düz metin gönderilir: tarayıcı ön-kontrol (preflight) yapmaz
    fetch(SCAN_URL, {
      method: 'POST',
      body: JSON.stringify({ symbols: { tickers: tickers }, columns: ['close', 'currency'] }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      var map = {};
      (data.data || []).forEach(function (row) {
        if (row && row.d && typeof row.d[0] === 'number') map[row.s] = { price: row.d[0], currency: row.d[1] };
      });
      var missing = [];
      var fx = map[FX_SYM] ? map[FX_SYM].price : null;
      if (fx) state.fx = { value: fx }; else missing.push('USD/TL kuru');
      withSym.forEach(function (a) {
        var m = map[a.symbol];
        var want = a.currency === 'USD' ? 'USD' : 'TRY';
        if (m && (!m.currency || m.currency === want)) state.prices[a.id] = { value: m.price };
        else missing.push(a.name + (m ? ' (para birimi ' + m.currency + ')' : ''));
      });
      state.updatedAt = Date.now();
      save();
      fetchStatus = missing.length
        ? { text: 'Alınamayanlar: ' + missing.join(', ') + '. Bunlar için son alınan fiyat kullanılıyor; biraz sonra tekrar dene.', warn: true }
        : null;
      if (!missing.length && !quiet) toast('Fiyatlar güncellendi');
      // Ekrandaki sonuç sabit kalır (kullanıcı onunla Midas'ta alım yapıyor olabilir);
      // fiyatlar değiştiyse yalnızca not düşülür
      if (result && result.rows && !applied && result.priceKey !== priceKey()) result.stale = true;
    }).catch(function () {
      fetchStatus = {
        text: (navigator.onLine === false ? 'İnternet bağlantısı yok.' : 'Fiyat kaynağı yanıt vermedi.') +
          (state.updatedAt ? ' Son alınan fiyatlar (' + dateTime(state.updatedAt) + ') kullanılıyor.' : ' Bağlantını kontrol edip tekrar dene.'),
        warn: true
      };
    }).then(function () {
      clearTimeout(timer);
      fetching = false;
      safeRender();
    });
  }

  // Kullanıcı bir alana yazarken ekranı yeniden çizme; yazma bitince çiz
  var renderWait = null;
  function typing() { var a = document.activeElement; return !!a && a.tagName === 'INPUT'; }
  function safeRender() {
    if (!typing()) { render(); return; }
    if (renderWait) return;
    renderWait = setInterval(function () {
      if (typing()) return;
      clearInterval(renderWait);
      renderWait = null;
      render();
    }, 1000);
  }

  function autoRefresh() {
    if (document.visibilityState !== 'visible') return;
    if (!state.updatedAt || Date.now() - state.updatedAt > 30 * 1000) refresh(true);
  }

  // ---------- Ekranlar ----------

  function render() {
    var el = document.getElementById('view');
    el.innerHTML = view === 'history' ? historyHTML() : homeHTML();
    document.body.classList.toggle('editing', editing && view !== 'history');
    document.querySelectorAll('nav button').forEach(function (b) {
      if (b.getAttribute('data-nav') === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  function homeHTML() {
    var fx = fxVal();
    var v = Calc.valuate(calcInput(), fx);
    var h = '<h1>Portföy Dengeleyici</h1>';

    // Hatırlatma
    var last = lastRecord();
    var days = last ? Calc.daysSince(last.ts) : null;
    if (days != null && days < REMIND_DAYS) {
      h += '<div class="note">' + (days === 0 ? 'Son kontrol bugün yapıldı.' : 'Son kontrol ' + days + ' gün önce yapıldı.') +
        ' Bu araç ayda bir kullanım için.</div>';
    }

    // Özet
    h += '<section class="card">';
    h += '<div class="muted small">Toplam portföy</div>';
    if (v.totalTL != null) {
      h += '<div class="big num">' + tl(v.totalTL) + '</div>';
      h += '<div class="muted num">' + (v.totalUSD != null ? usd(v.totalUSD) : '') + '</div>';
    } else {
      h += '<div class="big">—</div><div class="muted small">Eksik fiyat ya da kur var.</div>';
    }
    h += '<div class="small muted" style="margin-top:8px">Fiyatların son güncellemesi: ' +
      (state.updatedAt ? dateTime(state.updatedAt) : 'henüz yok') + '</div>';
    h += '<div class="prices num"><div class="tiny muted" style="margin-bottom:2px">Güncel fiyatlar</div>';
    h += '<div class="row small"><span class="muted">USD/TL</span><span>' + (fx ? fmt(fx, 4) : '—') + '</span></div>';
    state.assets.forEach(function (a) {
      var p = priceOf(a);
      h += '<div class="row small"><span class="muted">' + esc(a.name) + '</span><span>' +
        (p ? (a.currency === 'USD' ? usd(p) : tl2(p)) : '—') + '</span></div>';
    });
    h += '</div>';
    if (fetchStatus) h += '<div class="note ' + (fetchStatus.warn ? 'warn' : '') + '" style="margin:10px 0 0">' + esc(fetchStatus.text) + '</div>';
    h += '<button data-action="refresh"' + (fetching ? ' disabled' : '') + '>' + (fetching ? 'Güncelleniyor…' : 'Güncelle') + '</button>';
    h += '</section>';

    // Varlık kartları
    if (editing) {
      h += '<div class="note warn"><b>Düzenleme açık.</b> Adetleri Midas\'taki gibi gir. Yazdıkların, ekranın altındaki ' +
        '<b>"Adetleri kaydet"</b>e basıp onaylayana kadar kaydedilmez; toplam ve oranlar kayıtlı adetlerle hesaplanır.</div>';
    } else {
      h += '<button class="secondary" data-action="editQty" style="margin:0 0 12px">Adetleri düzenle</button>';
    }
    v.rows.forEach(function (r) {
      var a = state.assets.filter(function (x) { return x.id === r.id; })[0];
      var warn = r.deviation != null && Math.abs(r.deviation) > DEV_LIMIT;
      h += '<section class="card asset' + (warn ? ' warn' : '') + '">';
      h += '<div class="row"><div><b>' + esc(a.name) + '</b> <span class="muted small">' + (a.currency === 'USD' ? 'USD' : 'TL') + '</span></div>';
      h += '<div class="dev num">' + (r.deviation != null ? 'Sapma ' + signed(r.deviation) + ' puan' : '') + '</div></div>';
      if (editing) {
        h += '<label class="field">Adet<input data-qty="' + a.id + '" inputmode="decimal" autocomplete="off" value="' +
          esc(qtyText[a.id] != null ? qtyText[a.id] : inputVal(a.qty)) + '"></label>';
        h += '<div class="tiny muted" style="margin-top:4px">Kayıtlı adet: <b class="num">' + units(a.qty || 0, a.currency) + '</b></div>';
        h += '<div class="err" data-err="' + a.id + '" hidden></div>';
      } else {
        h += '<div class="row" style="margin-top:10px"><span class="small muted">Adet</span><b class="num">' + units(a.qty || 0, a.currency) + '</b></div>';
      }
      h += '<div class="row" style="margin-top:10px"><span class="small muted">Oran</span><span class="num">' +
        (r.ratio != null ? pct(r.ratio) : '—') + ' <span class="muted">· hedef %' + fmt(a.target, 0, 2) + '</span></span></div>';
      h += '</section>';
    });

    // Düzenlemede Kaydet/Vazgeç ekranın altına sabitlenir, kaydırmadan hep görünür
    if (editing) {
      h += '<div class="editbar"><div class="err" id="qtyErr" hidden></div><div class="inner">' +
        '<button class="secondary" data-action="cancelQty">Vazgeç</button>' +
        '<button data-action="saveQty">Adetleri kaydet</button></div></div>';
    }

    // Hesap
    h += '<section class="card"><h2>Bu ay</h2>';
    h += '<label class="field">Bu ay eklenecek tutar (TL)<input id="amount" inputmode="decimal" autocomplete="off" placeholder="ör. 35.000" value="' + esc(amountText != null ? amountText : inputVal(state.amount, 2)) + '"></label>';
    h += '<button data-action="calc">Hesapla</button>';
    h += resultHTML();
    h += '</section>';
    return h;
  }

  function resultHTML() {
    if (!result) return '';
    if (result.errors && result.errors.length) {
      return '<div class="note bad" style="margin:12px 0 0">' + result.errors.map(esc).join('<br>') + '</div>';
    }
    var r = result;
    var h = '<div style="margin-top:14px">';
    if (r.stale && !applied) {
      h += '<div class="note warn">Fiyatlar bu hesaptan sonra değişti. Aşağıdaki öneri hesapladığın andaki fiyatlarla. ' +
        'Henüz alım yapmadıysan istersen yeniden "Hesapla"ya bas.</div>';
    }
    if (r.usdNeeded > 0.005) {
      h += '<div class="step"><b>Önce ' + tl(r.usdNeededTL) + ' ile ' + usd(r.usdNeeded) + ' al.</b>' +
        '<div class="small muted num">Kur ' + fmt(fxVal(), 4) + '</div></div>';
    }
    r.rows.forEach(function (x) {
      var zero = x.buyTL < 0.005;
      h += '<div class="res' + (zero ? ' zero' : '') + '">';
      h += '<div class="row"><b>' + esc(x.name) + '</b><span class="amt num">' + tl(x.buyTL) + '</span></div>';
      if (x.currency === 'USD') h += '<div class="row small"><span class="muted">Dolar karşılığı</span><span class="num">' + usd(x.buyUSD) + '</span></div>';
      h += '<div class="row small"><span class="muted">Yaklaşık adet</span><span class="num">' + units(x.units, x.currency) + '</span></div>';
      h += '<div class="row small"><span class="muted">Oran</span><span class="num">' +
        pct(x.ratio) + ' → ' + pct(x.afterRatio) + ' <span class="muted">· hedef %' + fmt(x.target, 0, 2) + '</span></span></div>';
      if (x.small) h += '<div class="small muted">' + tl(MIN_BUY) + '\'den küçük kaldığı için bu ay atlandı, payı diğerlerine kaydırıldı.</div>';
      h += '</div>';
    });
    if (r.leftoverTL >= 1) {
      h += '<div class="small muted" style="margin-top:8px">Adetler aşağı yuvarlandığı için artan: ' + tl(r.leftoverTL) + '</div>';
    }
    if (applied) {
      h += '<div class="note" style="margin:12px 0 0">Adetlere eklendi, bu ay Geçmiş\'e kaydedildi.</div>';
      if (appliedTs) h += '<button class="secondary" data-action="undo">Geri al</button>';
    } else {
      h += '<button data-action="apply">Alımları yaptım, adetlere ekle</button>';
      h += '<div class="tiny muted" style="margin-top:6px">Adetlerini günceller ve bu ayı Geçmiş\'e otomatik kaydeder. Gerekirse sonra geri alabilirsin.</div>';
    }
    h += '</div>';
    return h;
  }

  function historyHTML() {
    var h = '<h1>Geçmiş</h1>';
    var foot = '<p class="tiny muted" style="text-align:center;margin-top:20px">Sürüm ' + VERSION + '</p>';
    if (!state.history.length) return h + '<p class="muted">Henüz kayıt yok. "Alımları yaptım, adetlere ekle"ye bastığında o ay buraya otomatik kaydedilir.</p>' + foot;
    state.history.slice().reverse().forEach(function (rec) {
      h += '<section class="card">';
      h += '<div class="row"><b>' + date(rec.ts) + '</b><button class="ghost" data-action="delRec" data-ts="' + rec.ts + '">Sil</button></div>';
      h += '<div class="num">' + tl(rec.totalTL) + ' <span class="muted">· ' + usd(rec.totalUSD) + '</span></div>';
      h += '<div class="small muted num">Eklenen: ' + (rec.amount ? tl(rec.amount) : '—') + ' · Kur: ' + fmt(rec.fx, 4) +
        '</div>';
      if (rec.added && rec.added.length) {
        h += '<div class="small num" style="margin-top:4px">Alınan: ' + rec.added.map(function (x) {
          return esc(x.name) + ' +' + units(x.units, x.currency);
        }).join(' · ') + '</div>';
      }
      h += '<details style="margin-top:6px"><summary class="small">Ayrıntı</summary>';
      (rec.assets || []).forEach(function (a) {
        h += '<div class="row small num"><span>' + esc(a.name) + '</span><span>' + units(a.qty, a.currency) + ' × ' +
          (a.currency === 'USD' ? usd(a.price) : tl2(a.price)) + '</span></div>';
      });
      h += '</details></section>';
    });
    return h + '<p class="small muted">Bir kaydı silersen o kayıtla eklenen adetler de geri alınır.</p>' + foot;
  }

  // ---------- Eylemler ----------

  function startEdit() {
    editing = true;
    qtyText = {};
    result = null;   // adetler değişecek; eski hesap geçersiz
    render();
  }

  function cancelEdit() {
    editing = false;
    qtyText = {};
    render();
  }

  // Tüm kutuları okur, doğrular, değişiklikleri gösterip onay ister
  function saveEdit() {
    var errEl = document.getElementById('qtyErr');
    var next = {}, bad = [], changes = [];
    document.querySelectorAll('[data-qty]').forEach(function (inp) {
      var id = inp.getAttribute('data-qty');
      var n = parseNum(inp.value);
      if (n == null) n = 0;
      var a = state.assets.filter(function (x) { return x.id === id; })[0];
      if (!isFinite(n) || n < 0) { bad.push(a.name); inp.classList.add('invalid'); return; }
      next[id] = n;
      if (Math.abs(n - (a.qty || 0)) > 1e-9) changes.push(a.name + ': ' + units(a.qty || 0, a.currency) + ' → ' + units(n, a.currency));
    });
    if (bad.length) {
      errEl.textContent = 'Geçerli bir adet girin (ör. 12 ya da 3,5): ' + bad.join(', ');
      errEl.hidden = false;
      return;
    }
    if (!changes.length) { cancelEdit(); toast('Adetler değişmedi'); return; }
    if (!confirm('Adetler şöyle değişecek:\n\n' + changes.join('\n') + '\n\nOnaylıyor musun?')) return;
    state.assets.forEach(function (a) { if (a.id in next) a.qty = next[a.id]; });
    editing = false;
    qtyText = {};
    result = null;
    save();
    render();
    toast('Adetler kaydedildi');
  }

  function doCalc() {
    if (editing) { toast('Önce adetleri kaydet ya da vazgeç.'); return; }
    var input = document.getElementById('amount');
    var amount = parseNum(input.value);
    applied = false;
    appliedTs = null;
    if (amount == null || !isFinite(amount) || amount <= 0) {
      result = { errors: ['Eklenecek tutarı 0\'dan büyük bir sayı olarak girin (ör. 35.000).'] };
      render();
      return;
    }
    state.amount = amount;
    save();
    result = compute(amount);
    render();
  }

  function compute(amount) {
    var res = Calc.rebalanceMin(calcInput(), fxVal(), amount, [], MIN_BUY);
    res.priceKey = priceKey();
    return res;
  }

  // Hesapta kullanılan fiyatların özeti; değişip değişmediğini anlamak için
  function priceKey() {
    return JSON.stringify([fxVal(), state.assets.map(priceOf)]);
  }

  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  function applyBuys() {
    if (!result || !result.rows || applied) return;
    var list = result.rows.filter(function (x) { return x.units > 0; })
      .map(function (x) { return x.name + ' +' + units(x.units, x.currency); });
    if (!list.length) { toast('Eklenecek adet yok.'); return; }
    // Aynı alımın iki kez eklenmesine karşı: bugün zaten kayıt varsa açıkça uyar
    var today = state.history.filter(function (r) { return sameDay(r.ts, Date.now()); });
    var warn = today.length
      ? '⚠️ Bugün zaten bir alım kaydettin (saat ' + new Date(today[today.length - 1].ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) +
        '). Aynı alımı tekrar eklemek üzere olabilirsin.\n\n'
      : '';
    if (!confirm(warn + 'Şu adetler mevcut adetlerine eklenecek ve bu ay Geçmiş\'e kaydedilecek:\n\n' + list.join('\n') +
      '\n\n' + (today.length ? 'Yine de eklensin mi?' : 'Gerçekte farklı adet aldıysan sonra "Adetleri düzenle" ile düzeltebilirsin.'))) return;
    var added = [];
    result.rows.forEach(function (x) {
      var a = state.assets.filter(function (y) { return y.id === x.id; })[0];
      if (a && x.units > 0) {
        a.qty = Calc.floorTo((a.qty || 0) + x.units + 1e-9, 4);
        added.push({ id: a.id, name: a.name, currency: a.currency, units: x.units });
      }
    });
    applied = true;
    appliedTs = saveMonth(added);
    save();
    render();
    toast(appliedTs ? 'Adetler güncellendi, bu ay kaydedildi' : 'Adetler güncellendi ama ay kaydedilemedi (fiyatlar eksik).');
  }

  // Bu ayı Geçmiş'e yazar; kaydın zaman damgasını (ya da kaydedilemezse null) döner
  function saveMonth(added) {
    var fx = fxVal();
    var v = Calc.valuate(calcInput(), fx);
    if (v.totalTL == null || !fx) return null;
    var ts = Date.now();
    state.history.push({
      ts: ts,
      added: added || [],
      fx: fx,
      amount: state.amount || 0,
      totalTL: v.totalTL,
      totalUSD: v.totalUSD,
      assets: state.assets.map(function (a) {
        return { name: a.name, currency: a.currency, qty: a.qty, price: priceOf(a) };
      })
    });
    return ts;
  }

  // Kaydı siler ve o kayıtla eklenen adetleri geri düşer
  function deleteRecord(ts) {
    var rec = state.history.filter(function (r) { return String(r.ts) === String(ts); })[0];
    if (!rec) return;
    var added = (rec.added || []).filter(function (x) { return x.units > 0; });
    var msg = added.length
      ? 'Bu kayıt silinecek ve o gün eklenen adetler geri alınacak:\n\n' +
        added.map(function (x) { return x.name + ' −' + units(x.units, x.currency); }).join('\n')
      : 'Bu kayıt silinsin mi? (Adetlerin değişmez.)';
    if (!confirm(msg)) return;
    added.forEach(function (x) {
      state.assets.forEach(function (a) {
        if (a.id === x.id) a.qty = Math.max(0, Calc.floorTo((a.qty || 0) - x.units + 1e-9, 4));
      });
    });
    state.history = state.history.filter(function (r) { return r !== rec; });
    // Geri alınan alım ekrandaki sonuçsa, sonucu tekrar uygulanabilir yap
    if (String(appliedTs) === String(ts)) { applied = false; appliedTs = null; }
    save();
    render();
    toast(added.length ? 'Kayıt silindi, adetler geri alındı' : 'Kayıt silindi');
  }

  // ---------- Olaylar ----------

  document.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) {
      view = nav.getAttribute('data-nav');
      render();
      window.scrollTo(0, 0);
      return;
    }
    var b = e.target.closest('[data-action]');
    if (!b) return;
    var act = b.getAttribute('data-action');
    if (act === 'refresh') refresh();
    else if (act === 'calc') doCalc();
    else if (act === 'apply') applyBuys();
    else if (act === 'delRec') deleteRecord(b.getAttribute('data-ts'));
    else if (act === 'undo') deleteRecord(appliedTs);
    else if (act === 'editQty') startEdit();
    else if (act === 'saveQty') saveEdit();
    else if (act === 'cancelQty') cancelEdit();
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    // Düzenlemede yazılanlar yalnızca taslakta tutulur; "Adetleri kaydet" olmadan kaydedilmez
    if (t.hasAttribute('data-qty')) {
      var id = t.getAttribute('data-qty');
      var n = parseNum(t.value);
      var err = document.querySelector('[data-err="' + id + '"]');
      qtyText[id] = t.value;
      var ok = n == null || (isFinite(n) && n >= 0);
      t.classList.toggle('invalid', !ok);
      err.textContent = ok ? '' : 'Geçerli bir adet girin (ör. 12 ya da 3,5).';
      err.hidden = ok;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'amount') amountText = e.target.value;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'amount') { e.target.blur(); doCalc(); }
  });

  // ---------- Başlangıç ----------

  var local = readLocal();
  state = normalize(local);
  if (migrated) save();   // yeni yapıya taşınan veriyi hemen kalıcı yap
  render();

  // localStorage boşsa (ör. tarayıcı temizlediyse) IndexedDB kopyasından geri yükle
  if (!local) {
    idb('readonly', function (s) { return s.get(KEY); }).then(function (json) {
      if (!json) return;
      state = normalize(JSON.parse(json));
      save();
      render();
      toast('Veriler yedekten geri yüklendi');
    }).catch(function () {});
  }

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {});

  // Açılışta, uygulamaya geri dönünce ve açık kaldıkça dakikada bir fiyatları yenile
  autoRefresh();
  setInterval(autoRefresh, AUTO_MS);
  document.addEventListener('visibilitychange', autoRefresh);
})();
