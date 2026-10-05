// Portföy Dengeleyici — hesaplama çekirdeği (tarayıcı + Node)
(function (root) {
  'use strict';

  // Aşağı yuvarla; kayan nokta hatasını tolere et (0.29999999 → 0.3)
  function floorTo(x, decimals) {
    var f = Math.pow(10, decimals);
    return Math.floor(x * f + 1e-7) / f;
  }

  function isPos(x) { return typeof x === 'number' && isFinite(x) && x > 0; }
  function isNonNeg(x) { return typeof x === 'number' && isFinite(x) && x >= 0; }

  // Varlıkların TL değeri, mevcut oran, sapma
  // assets: [{id, currency:'USD'|'TRY', target (yüzde), qty, price}]
  function valuate(assets, fx) {
    var rows = assets.map(function (a) {
      var rate = a.currency === 'USD' ? fx : 1;
      var ok = isNonNeg(a.qty) && isPos(a.price) && (a.currency !== 'USD' || isPos(fx));
      var valueNative = ok ? a.qty * a.price : null;
      return {
        id: a.id,
        name: a.name || a.id,
        currency: a.currency,
        target: a.target,
        qty: a.qty,
        price: a.price,
        valueNative: valueNative,
        valueTL: ok ? valueNative * rate : null
      };
    });
    var complete = rows.every(function (r) { return r.valueTL != null; });
    var total = complete ? rows.reduce(function (s, r) { return s + r.valueTL; }, 0) : null;
    rows.forEach(function (r) {
      // Portföy boşken oran/sapma anlamsız
      r.ratio = total ? r.valueTL / total * 100 : null;
      r.deviation = r.ratio == null ? null : r.ratio - r.target;
    });
    return {
      rows: rows,
      totalTL: total,
      totalUSD: total != null && isPos(fx) ? total / fx : null
    };
  }

  // Eksik veri kontrolü → okunur hata listesi
  function validate(assets, fx, amount) {
    var errs = [];
    if (!isPos(amount)) errs.push('Eklenecek tutarı 0\'dan büyük bir sayı olarak girin.');
    if (assets.some(function (a) { return a.currency === 'USD'; }) && !isPos(fx)) {
      errs.push('USD/TL kuru eksik. "Güncelle"ye basın.');
    }
    assets.forEach(function (a) {
      var n = a.name || a.id;
      if (!isNonNeg(a.qty)) errs.push(n + ' için adet geçersiz.');
      if (!isPos(a.price)) errs.push(n + ' için fiyat eksik. "Güncelle"ye basın.');
    });
    var sum = assets.reduce(function (s, a) { return s + (a.target || 0); }, 0);
    if (Math.abs(sum - 100) > 0.001) errs.push('Hedef oranların toplamı %100 değil (şu an %' + sum + ').');
    return errs;
  }

  // Ana hesap. exclude: bu ay alım yapılmayacak varlık id'leri (ör. çok küçük kalan alımlar)
  function rebalance(assets, fx, amount, exclude) {
    exclude = exclude || [];
    var errors = validate(assets, fx, amount);
    if (errors.length) return { errors: errors };

    var v = valuate(assets, fx);
    var current = v.totalTL;
    var newTotal = current + amount;

    var rows = v.rows.map(function (r) {
      var included = exclude.indexOf(r.id) === -1;
      var targetTL = newTotal * r.target / 100;
      return {
        id: r.id, name: r.name, currency: r.currency, target: r.target, price: r.price, qty: r.qty,
        valueTL: r.valueTL, ratio: r.ratio, included: included,
        targetTL: targetTL,
        deficit: included ? Math.max(0, targetTL - r.valueTL) : 0
      };
    });

    var inc = rows.filter(function (r) { return r.included; });
    if (!inc.length) return { errors: ['Alım yapılabilecek varlık yok.'] };

    var totalDeficit = inc.reduce(function (s, r) { return s + r.deficit; }, 0);
    var incTarget = inc.reduce(function (s, r) { return s + r.target; }, 0);

    rows.forEach(function (r) {
      if (!r.included) { r.buyTL = 0; return; }
      if (totalDeficit > 1e-9) r.buyTL = amount * r.deficit / totalDeficit;
      else r.buyTL = incTarget > 0 ? amount * r.target / incTarget : amount / inc.length;
    });

    var spentTL = 0;
    rows.forEach(function (r) {
      var rate = r.currency === 'USD' ? fx : 1;
      r.buyUSD = r.currency === 'USD' ? r.buyTL / fx : null;
      var native = r.buyTL / rate;
      // USD varlıklar kesirli (4 ondalık), TL varlıklar tam adet
      r.units = floorTo(native / r.price, r.currency === 'USD' ? 4 : 0);
      r.unitsCostTL = r.units * r.price * rate;
      spentTL += r.unitsCostTL;
      r.afterRatio = newTotal > 0 ? (r.valueTL + r.buyTL) / newTotal * 100 : 0;
    });

    var usdRows = rows.filter(function (r) { return r.currency === 'USD'; });
    var usdNeeded = usdRows.reduce(function (s, r) { return s + r.buyUSD; }, 0);
    var usdTL = usdRows.reduce(function (s, r) { return s + r.buyTL; }, 0);

    return {
      errors: [],
      currentTL: current,
      newTotalTL: newTotal,
      rows: rows,
      usdNeeded: usdNeeded,
      usdNeededTL: usdTL,
      leftoverTL: Math.max(0, amount - spentTL)
    };
  }

  // Çok küçük alımları önerme: minBuy TL altındaki en küçük öneriyi çıkar,
  // tutarı kalanlara yeniden dağıt; hepsi sınırı geçene dek tekrarla.
  // Tek varlık kalırsa tutarın tamamı ona gider.
  function rebalanceMin(assets, fx, amount, exclude, minBuy) {
    var skip = (exclude || []).slice();
    var small = [];
    for (;;) {
      var res = rebalance(assets, fx, amount, skip);
      if (res.errors.length || !minBuy) return res;
      var inc = res.rows.filter(function (r) { return r.included; });
      var tiny = inc.filter(function (r) { return r.buyTL > 1e-9 && r.buyTL < minBuy; });
      if (!tiny.length || inc.length <= 1) {
        res.rows.forEach(function (r) { r.small = small.indexOf(r.id) !== -1; });
        return res;
      }
      tiny.sort(function (a, b) { return a.buyTL - b.buyTL; });
      skip.push(tiny[0].id);
      small.push(tiny[0].id);
    }
  }

  function daysSince(ts, now) {
    if (!ts) return null;
    return Math.floor(((now || Date.now()) - ts) / 86400000);
  }

  var api = {
    floorTo: floorTo,
    valuate: valuate,
    validate: validate,
    rebalance: rebalance,
    rebalanceMin: rebalanceMin,
    daysSince: daysSince
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(this);
