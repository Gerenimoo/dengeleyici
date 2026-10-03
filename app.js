// Portföy Dengeleyici — arayüz, kayıt, fiyat çekme
(function () {
  'use strict';

  var KEY = 'pd.v1';
  var SCAN_URL = 'https://scanner.tradingview.com/global/scan';
  var FX_SYM = 'FX_IDC:USDTRY';
  var OZ_SYM = 'OANDA:XAUUSD';
  var REMIND_DAYS = 25;
  var DEV_LIMIT = 5;

  var DEFAULT_ASSETS = [
    { id: 'voo', name: 'VOO', currency: 'USD', target: 50, symbol: 'AMEX:VOO', qty: 0 },
    { id: 'qqq', name: 'QQQ', currency: 'USD', target: 15, symbol: 'NASDAQ:QQQ', qty: 0 },
    { id: 'vxus', name: 'VXUS', currency: 'USD', target: 15, symbol: 'NASDAQ:VXUS', qty: 0 },
    { id: 'altins1', name: 'ALTINS1', currency: 'TRY', target: 20, symbol: 'BIST:ALTIN', qty: 0, gold: true }
  ];

  function freshState() {
    return {
      assets: JSON.parse(JSON.stringify(DEFAULT_ASSETS)),
      prices: {},        // { assetId: { value, manual } }
      fx: null,          // { value, manual }
      gram: null,        // { value, manual }
      updatedAt: null,   // son başarılı çekme
      amount: null,      // son girilen eklenecek tutar
      history: []        // aylık kayıtlar
    };
  }

  var state = freshState();
  var view = 'home';
  var result = null;     // son hesap sonucu (ekranda tutulur)
  var applied = false;   // alımlar adetlere eklendi mi
  var fetchStatus = null;
  var fetching = false;
  var draft = null;      // ayarlar taslağı
  var manualOpen = false; // "Fiyatları elle gir" açık mı

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

  function normalize(s) {
    var base = freshState();
    if (!s || !Array.isArray(s.assets)) return base;
    for (var k in base) if (!(k in s)) s[k] = base[k];
    return s;
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
  function pct(n) { return '%' + fmt(n, 1); }
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
  function gramVal() { return state.gram ? state.gram.value : null; }
  function goldAsset() { return state.assets.filter(function (a) { return a.gold; })[0] || null; }

  function calcInput() {
    return state.assets.map(function (a) {
      return { id: a.id, name: a.name, currency: a.currency, target: a.target, qty: a.qty, price: priceOf(a) };
    });
  }

  function premium() {
    var g = goldAsset();
    if (!g) return null;
    var p = Calc.goldPremium(priceOf(g), gramVal());
    return p == null ? null : { value: p, level: Calc.premiumLevel(p) };
  }

  function lastRecord() { return state.history.length ? state.history[state.history.length - 1] : null; }

  // ---------- Fiyat çekme ----------

  function refresh() {
    if (fetching) return;
    fetching = true;
    fetchStatus = { text: 'Fiyatlar alınıyor…' };
    render();

    var withSym = state.assets.filter(function (a) { return a.symbol; });
    var tickers = withSym.map(function (a) { return a.symbol; }).concat([FX_SYM, OZ_SYM]);
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
      if (fx) state.fx = { value: fx, manual: false }; else missing.push('USD/TL kuru');
      var oz = map[OZ_SYM] ? map[OZ_SYM].price : null;
      if (oz && fx) state.gram = { value: Calc.gramGoldFromSpot(oz, fx), manual: false };
      else missing.push('gram altın');
      withSym.forEach(function (a) {
        var m = map[a.symbol];
        var want = a.currency === 'USD' ? 'USD' : 'TRY';
        if (m && (!m.currency || m.currency === want)) state.prices[a.id] = { value: m.price, manual: false };
        else missing.push(a.name + (m ? ' (para birimi ' + m.currency + ')' : ''));
      });
      state.assets.forEach(function (a) { if (!a.symbol && !priceOf(a)) missing.push(a.name); });
      state.updatedAt = Date.now();
      save();
      fetchStatus = missing.length
        ? { text: 'Alınamayanlar: ' + missing.join(', ') + '. Bunları "Fiyatları elle gir" bölümünden girebilirsin.', warn: true }
        : null;
      if (!missing.length) toast('Fiyatlar güncellendi');
    }).catch(function () {
      fetchStatus = {
        text: (navigator.onLine === false ? 'İnternet bağlantısı yok.' : 'Fiyat kaynağı yanıt vermedi.') +
          ' Fiyatları "Fiyatları elle gir" bölümünden girebilirsin.',
        warn: true
      };
    }).then(function () {
      clearTimeout(timer);
      fetching = false;
      render();
    });
  }

  // ---------- Ekranlar ----------

  function render() {
    var el = document.getElementById('view');
    if (view === 'home') el.innerHTML = homeHTML();
    else if (view === 'history') el.innerHTML = historyHTML();
    else el.innerHTML = settingsHTML();
    document.querySelectorAll('nav button').forEach(function (b) {
      if (b.getAttribute('data-nav') === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  function manualBadge(o) { return o && o.manual ? ' <span class="badge">elle</span>' : ''; }

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
    h += '<div class="small muted" style="margin-top:8px">Son güncelleme: ' +
      (state.updatedAt ? dateTime(state.updatedAt) : 'henüz yok') + '</div>';
    h += '<div class="small muted num">USD/TL: ' + (fx ? fmt(fx, 4) : '—') + manualBadge(state.fx) +
      ' · Gram altın: ' + (gramVal() ? tl2(gramVal()) : '—') + manualBadge(state.gram) + '</div>';
    if (fetchStatus) h += '<div class="note ' + (fetchStatus.warn ? 'warn' : '') + '" style="margin:10px 0 0">' + esc(fetchStatus.text) + '</div>';
    h += '<button data-action="refresh"' + (fetching ? ' disabled' : '') + '>' + (fetching ? 'Güncelleniyor…' : 'Güncelle') + '</button>';
    h += '</section>';

    // Varlık kartları
    var prem = premium();
    v.rows.forEach(function (r) {
      var a = state.assets.filter(function (x) { return x.id === r.id; })[0];
      var warn = r.deviation != null && Math.abs(r.deviation) > DEV_LIMIT;
      h += '<section class="card asset' + (warn ? ' warn' : '') + '">';
      h += '<div class="row"><div><b>' + esc(a.name) + '</b> <span class="muted small">' + (a.currency === 'USD' ? 'USD' : 'TL') + '</span></div>';
      h += '<div class="dev num">' + (r.deviation != null ? 'Sapma ' + signed(r.deviation) + ' puan' : '') + '</div></div>';
      h += '<label class="field">Adet<input data-qty="' + a.id + '" inputmode="decimal" autocomplete="off" value="' + esc(inputVal(a.qty)) + '"></label>';
      h += '<div class="err" data-err="' + a.id + '" hidden></div>';
      h += '<div class="grid3">';
      h += '<div><span class="lbl">Fiyat</span><span class="val">' +
        (r.price ? (a.currency === 'USD' ? usd(r.price) : tl2(r.price)) : '—') + manualBadge(state.prices[a.id]) + '</span></div>';
      h += '<div><span class="lbl">Değer</span><span class="val">' + (r.valueTL != null ? tl(r.valueTL) : '—') +
        (a.currency === 'USD' && r.valueNative != null ? '<br><span class="muted small">' + usd(r.valueNative) + '</span>' : '') + '</span></div>';
      h += '<div><span class="lbl">Oran / hedef</span><span class="val">' + (r.ratio != null ? pct(r.ratio) : '—') +
        ' <span class="muted">/ %' + fmt(a.target, 0, 2) + '</span></span></div>';
      h += '</div>';
      if (a.gold) {
        h += '<div class="row" style="margin-top:10px"><span class="small muted">Altın primi</span>' +
          (prem ? '<span class="pill ' + prem.level + ' num">' + pct(prem.value) + '</span>' : '<span class="muted small">gram altın fiyatı gerekli</span>') + '</div>';
      }
      h += '</section>';
    });

    // Elle giriş
    h += '<details class="card" id="manual"' + (manualOpen ? ' open' : '') + '><summary>Fiyatları elle gir</summary>';
    h += '<p class="small muted" style="margin:6px 0 0">Elle girilen değerler "elle" etiketiyle görünür. "Güncelle" başarılı olursa yerlerine güncel fiyat gelir.</p>';
    h += '<div class="two">';
    h += priceField('fx', 'USD/TL kuru', state.fx);
    h += priceField('gram', 'Gram altın (TL)', state.gram);
    state.assets.forEach(function (a) {
      h += priceField('p:' + a.id, esc(a.name) + ' (' + (a.currency === 'USD' ? '$' : 'TL') + ')', state.prices[a.id]);
    });
    h += '</div><div class="err" data-err="price" hidden></div></details>';

    // Hesap
    h += '<section class="card"><h2>Bu ay</h2>';
    h += '<label class="field">Bu ay eklenecek tutar (TL)<input id="amount" inputmode="decimal" autocomplete="off" placeholder="ör. 35.000" value="' + esc(inputVal(state.amount, 2)) + '"></label>';
    h += '<button data-action="calc">Hesapla</button>';
    h += resultHTML();
    h += '</section>';
    return h;
  }

  function priceField(key, label, o) {
    return '<label class="field">' + label + '<input data-price="' + key + '" inputmode="decimal" autocomplete="off" value="' +
      esc(o ? inputVal(o.value, 4) : '') + '"></label>';
  }

  function resultHTML() {
    if (!result) return '';
    if (result.errors && result.errors.length) {
      return '<div class="note bad" style="margin:12px 0 0">' + result.errors.map(esc).join('<br>') + '</div>';
    }
    var r = result;
    var h = '<div style="margin-top:14px">';
    if (r.goldSkipped) {
      h += '<div class="note bad">Altın primi ' + pct(r.goldSkipped) + '. Prim çok yüksek, bu ay altın alımını ertele. Altının payı diğer varlıklara dağıtıldı.</div>';
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
      if (!x.included) h += '<div class="small" style="color:var(--bad)">Prim çok yüksek, bu ay altın alımını ertele.</div>';
      h += '</div>';
    });
    if (r.leftoverTL >= 1) {
      h += '<div class="small muted" style="margin-top:8px">Adetler aşağı yuvarlandığı için artan: ' + tl(r.leftoverTL) + '</div>';
    }
    h += '<button class="secondary" data-action="apply"' + (applied ? ' disabled' : '') + '>' +
      (applied ? 'Adetlere eklendi' : 'Alımları yaptım, adetlere ekle') + '</button>';
    h += '<button class="secondary" data-action="saveMonth">Bu ayı kaydet</button>';
    h += '</div>';
    return h;
  }

  function historyHTML() {
    var h = '<h1>Geçmiş</h1>';
    h += '<section class="card"><p class="small muted" style="margin:0">Bu ayın tarihini, kuru, fiyatları, adetleri ve eklenen tutarı kaydeder.</p>';
    h += '<button data-action="saveMonth">Bu ayı kaydet</button></section>';
    if (!state.history.length) return h + '<p class="muted">Henüz kayıt yok.</p>';
    state.history.slice().reverse().forEach(function (rec) {
      h += '<section class="card">';
      h += '<div class="row"><b>' + date(rec.ts) + '</b><button class="ghost" data-action="delRec" data-ts="' + rec.ts + '">Sil</button></div>';
      h += '<div class="num">' + tl(rec.totalTL) + ' <span class="muted">· ' + usd(rec.totalUSD) + '</span></div>';
      h += '<div class="small muted num">Eklenen: ' + (rec.amount ? tl(rec.amount) : '—') + ' · Kur: ' + fmt(rec.fx, 4) +
        (rec.gram ? ' · Gram altın: ' + tl2(rec.gram) : '') + '</div>';
      h += '<details style="margin-top:6px"><summary class="small">Ayrıntı</summary>';
      (rec.assets || []).forEach(function (a) {
        h += '<div class="row small num"><span>' + esc(a.name) + '</span><span>' + units(a.qty, a.currency) + ' × ' +
          (a.currency === 'USD' ? usd(a.price) : tl2(a.price)) + '</span></div>';
      });
      h += '</details></section>';
    });
    return h;
  }

  function settingsHTML() {
    if (!draft) draft = state.assets.map(function (a) { return Object.assign({}, a); });
    var sum = draftSum();
    var h = '<h1>Ayarlar</h1>';
    h += '<section class="card"><h2>Varlıklar ve hedef oranlar</h2>';
    draft.forEach(function (a, i) {
      h += '<div class="set-row">';
      h += '<div class="two"><label class="field">Ad<input data-d="name" data-i="' + i + '" value="' + esc(a.name) + '" autocomplete="off"></label>';
      h += '<label class="field">Hedef (%)<input data-d="target" data-i="' + i + '" inputmode="decimal" value="' +
        esc(a.targetText != null ? a.targetText : inputVal(a.target, 2)) + '"></label></div>';
      h += '<div class="two"><label class="field">Para birimi<select data-d="currency" data-i="' + i + '">' +
        '<option value="USD"' + (a.currency === 'USD' ? ' selected' : '') + '>USD</option>' +
        '<option value="TRY"' + (a.currency === 'TRY' ? ' selected' : '') + '>TL</option></select></label>';
      h += '<label class="field">Fiyat sembolü<input data-d="symbol" data-i="' + i + '" value="' + esc(a.symbol || '') +
        '" placeholder="boş = elle" autocomplete="off" autocapitalize="characters"></label></div>';
      h += '<div class="row" style="margin-top:4px"><span class="tiny muted">' + (a.gold ? 'Altın primi bu varlık için hesaplanır.' : '') + '</span>' +
        '<button class="ghost" data-action="delAsset" data-i="' + i + '">Çıkar</button></div>';
      h += '</div>';
    });
    h += '<div class="row" style="margin-top:12px"><span>Toplam</span><b class="num" id="setSum">' + sumText(sum) + '</b></div>';
    h += '<div class="err" id="setErr" hidden></div>';
    h += '<button class="secondary" data-action="addAsset">Varlık ekle</button>';
    h += '<button data-action="saveSettings">Kaydet</button>';
    h += '</section>';
    h += '<section class="card small muted">';
    h += '<p style="margin-top:0"><b>Fiyat sembolü</b> TradingView biçimindedir, ör. <code>NASDAQ:QQQ</code> ya da <code>BIST:ALTIN</code>. Boş bırakılırsa fiyat elle girilir.</p>';
    h += '<p>Fiyatlar TradingView\'den alınır, birkaç dakika gecikmeli olabilir. Gram altın spot fiyattan hesaplanır (ons × kur ÷ 31,1035).</p>';
    h += '<p style="margin-bottom:0">Veriler yalnızca bu telefonda tutulur ve her değişiklikte otomatik olarak iki ayrı yere kaydedilir. Uygulamayı ana ekrandan açmak verilerin silinmemesi için en güvenli yoldur.</p>';
    h += '</section>';
    return h;
  }

  function draftSum() {
    return draft.reduce(function (s, a) {
      var t = parseNum(a.targetText != null ? a.targetText : a.target);
      return s + (isFinite(t) && t ? t : 0);
    }, 0);
  }

  function sumText(sum) {
    var ok = Math.abs(sum - 100) < 0.001;
    return '<span style="color:' + (ok ? 'var(--good)' : 'var(--bad)') + '">%' + fmt(sum, 0, 2) + '</span>';
  }

  // Değişiklikten sonra yeniden çiz; kullanıcının dokunduğu yeni alanın odağını koru
  function rerender() {
    setTimeout(function () {
      var a = document.activeElement, sel = null;
      if (a && a.getAttribute) {
        if (a.id) sel = '#' + a.id;
        else if (a.hasAttribute('data-qty')) sel = '[data-qty="' + a.getAttribute('data-qty') + '"]';
        else if (a.hasAttribute('data-price')) sel = '[data-price="' + a.getAttribute('data-price') + '"]';
      }
      render();
      var n = sel && document.querySelector(sel);
      if (n) n.focus();
    }, 0);
  }

  // ---------- Eylemler ----------

  function doCalc() {
    var input = document.getElementById('amount');
    var amount = parseNum(input.value);
    applied = false;
    if (amount == null || !isFinite(amount) || amount <= 0) {
      result = { errors: ['Eklenecek tutarı 0\'dan büyük bir sayı olarak girin (ör. 35.000).'] };
      render();
      return;
    }
    state.amount = amount;
    save();
    var prem = premium();
    var g = goldAsset();
    var skip = prem && prem.level === 'red' && g && state.assets.length > 1;
    var res = Calc.rebalance(calcInput(), fxVal(), amount, skip ? [g.id] : []);
    if (!res.errors.length && skip) res.goldSkipped = prem.value;
    result = res;
    render();
  }

  function applyBuys() {
    if (!result || !result.rows || applied) return;
    var list = result.rows.filter(function (x) { return x.units > 0; })
      .map(function (x) { return x.name + ' +' + units(x.units, x.currency); });
    if (!list.length) { toast('Eklenecek adet yok.'); return; }
    if (!confirm('Şu adetler mevcut adetlerine eklenecek:\n\n' + list.join('\n') + '\n\nGerçekte farklı adet aldıysan sonra kartlardan düzeltebilirsin.')) return;
    result.rows.forEach(function (x) {
      var a = state.assets.filter(function (y) { return y.id === x.id; })[0];
      if (a && x.units > 0) a.qty = Calc.floorTo((a.qty || 0) + x.units + 1e-9, 4);
    });
    applied = true;
    save();
    render();
    toast('Adetler güncellendi');
  }

  function saveMonth() {
    var fx = fxVal();
    var v = Calc.valuate(calcInput(), fx);
    if (v.totalTL == null || !fx) {
      toast('Kaydetmek için tüm fiyatlar ve kur gerekli.');
      return;
    }
    state.history.push({
      ts: Date.now(),
      fx: fx,
      gram: gramVal(),
      amount: state.amount || 0,
      totalTL: v.totalTL,
      totalUSD: v.totalUSD,
      assets: state.assets.map(function (a) {
        return { name: a.name, currency: a.currency, qty: a.qty, price: priceOf(a) };
      })
    });
    save();
    render();
    toast('Bu ay kaydedildi');
  }

  function deleteRecord(ts) {
    if (!confirm('Bu kayıt silinsin mi?')) return;
    state.history = state.history.filter(function (r) { return String(r.ts) !== String(ts); });
    save();
    render();
  }

  function saveSettings() {
    var errEl = document.getElementById('setErr');
    var errs = [];
    var names = {};
    var out = draft.map(function (a) {
      var t = parseNum(a.targetText != null ? a.targetText : a.target);
      var name = String(a.name || '').trim();
      if (!name) errs.push('Her varlığın bir adı olmalı.');
      else if (names[name.toLowerCase()]) errs.push('"' + name + '" adı iki kez kullanılmış.');
      names[name.toLowerCase()] = true;
      if (t == null || !isFinite(t) || t < 0 || t > 100) errs.push((name || 'Bir varlık') + ' için hedef 0–100 arası olmalı.');
      return Object.assign({}, a, { name: name, target: t, symbol: String(a.symbol || '').trim().toUpperCase() });
    });
    if (!out.length) errs.push('En az bir varlık olmalı.');
    var sum = out.reduce(function (s, a) { return s + (isFinite(a.target) ? a.target : 0); }, 0);
    if (!errs.length && Math.abs(sum - 100) > 0.001) errs.push('Hedeflerin toplamı %100 olmalı. Şu an %' + fmt(sum, 0, 2) + '. Kaydedilmedi.');
    if (errs.length) {
      errEl.innerHTML = errs.filter(function (e, i) { return errs.indexOf(e) === i; }).map(esc).join('<br>');
      errEl.hidden = false;
      return;
    }
    var keep = {};
    state.assets = out.map(function (a) {
      delete a.targetText;
      keep[a.id] = true;
      var old = state.assets.filter(function (x) { return x.id === a.id; })[0];
      // Para birimi ya da sembol değiştiyse eski fiyat geçersiz
      if (old && (old.currency !== a.currency || old.symbol !== a.symbol)) delete state.prices[a.id];
      return a;
    });
    Object.keys(state.prices).forEach(function (id) { if (!keep[id]) delete state.prices[id]; });
    result = null;
    draft = null;
    save();
    render();
    toast('Ayarlar kaydedildi');
  }

  // ---------- Olaylar ----------

  document.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) {
      view = nav.getAttribute('data-nav');
      if (view !== 'settings') draft = null;
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
    else if (act === 'saveMonth') saveMonth();
    else if (act === 'delRec') deleteRecord(b.getAttribute('data-ts'));
    else if (act === 'addAsset') {
      draft.push({ id: 'a' + Date.now().toString(36), name: '', currency: 'USD', target: 0, symbol: '', qty: 0 });
      render();
    } else if (act === 'delAsset') {
      var i = +b.getAttribute('data-i');
      if (confirm((draft[i].name || 'Bu varlık') + ' çıkarılsın mı? ("Kaydet"e basınca geçerli olur.)')) {
        draft.splice(i, 1);
        render();
      }
    } else if (act === 'saveSettings') saveSettings();
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-qty')) {
      var id = t.getAttribute('data-qty');
      var n = parseNum(t.value);
      var err = document.querySelector('[data-err="' + id + '"]');
      if (n == null) n = 0;
      if (!isFinite(n) || n < 0) {
        t.classList.add('invalid');
        err.textContent = 'Geçerli bir adet girin (ör. 12 ya da 3,5).';
        err.hidden = false;
        return;
      }
      state.assets.forEach(function (a) { if (a.id === id) a.qty = n; });
      result = null;
      save();
      rerender();
    } else if (t.hasAttribute('data-price')) {
      var key = t.getAttribute('data-price');
      var v = parseNum(t.value);
      var perr = document.querySelector('[data-err="price"]');
      if (v != null && (!isFinite(v) || v <= 0)) {
        t.classList.add('invalid');
        perr.textContent = 'Fiyat 0\'dan büyük bir sayı olmalı.';
        perr.hidden = false;
        return;
      }
      var o = v == null ? null : { value: v, manual: true };
      if (key === 'fx') state.fx = o;
      else if (key === 'gram') state.gram = o;
      else {
        var aid = key.slice(2);
        if (o) state.prices[aid] = o; else delete state.prices[aid];
      }
      result = null;
      save();
      rerender();
    }
  });

  // Ayar taslağı: yazarken güncelle, ekranı yeniden çizme (odak kaybolmasın)
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t.hasAttribute('data-d') || !draft) return;
    var row = draft[+t.getAttribute('data-i')];
    var field = t.getAttribute('data-d');
    if (field === 'target') row.targetText = t.value;
    else row[field] = t.value;
    var el = document.getElementById('setSum');
    if (el) el.innerHTML = sumText(draftSum());
  });

  document.addEventListener('toggle', function (e) {
    if (e.target.id === 'manual') manualOpen = e.target.open;
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'amount') { e.target.blur(); doCalc(); }
  });

  // ---------- Başlangıç ----------

  var local = readLocal();
  state = normalize(local);
  render();

  // localStorage boşsa (ör. tarayıcı temizlediyse) IndexedDB kopyasından geri yükle
  if (!local) {
    idb('readonly', function (s) { return s.get(KEY); }).then(function (json) {
      if (!json) return;
      state = normalize(JSON.parse(json));
      try { localStorage.setItem(KEY, json); } catch (e) {}
      render();
      toast('Veriler yedekten geri yüklendi');
    }).catch(function () {});
  }

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
