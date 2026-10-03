// Çalıştırma: node --test  ya da tarayıcıda test.html
const isNode = typeof require === 'function';
const test = isNode ? require('node:test') : window.__test;
const assert = isNode ? require('node:assert') : window.__assert;
const C = isNode ? require('./calc.js') : window.Calc;

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} ≠ ${b}`);

// Tarifteki örnek: kur 45, VOO 7.000 / QQQ 2.000 / VXUS 2.000 USD, ALTINS1 0, eklenecek 35.000 TL
const sample = [
  { id: 'VOO', currency: 'USD', target: 50, qty: 10, price: 700 },
  { id: 'QQQ', currency: 'USD', target: 15, qty: 4, price: 500 },
  { id: 'VXUS', currency: 'USD', target: 15, qty: 20, price: 100 },
  { id: 'ALTINS1', currency: 'TRY', target: 20, qty: 0, price: 70 }
];

test('örnek: 35.000 TL\'nin tamamı ALTINS1\'e', () => {
  const r = C.rebalance(sample, 45, 35000);
  assert.deepStrictEqual(r.errors, []);
  near(r.currentTL, 495000, 'mevcut toplam');
  near(r.newTotalTL, 530000, 'yeni toplam');
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  near(by.VOO.valueTL, 315000, 'VOO TL');
  near(by.QQQ.valueTL, 90000, 'QQQ TL');
  near(by.VXUS.valueTL, 90000, 'VXUS TL');
  near(by.VOO.targetTL, 265000, 'VOO hedef');
  near(by.QQQ.targetTL, 79500, 'QQQ hedef');
  near(by.VXUS.targetTL, 79500, 'VXUS hedef');
  near(by.ALTINS1.targetTL, 106000, 'ALTINS1 hedef');
  near(by.VOO.deficit, 0, 'VOO eksik');
  near(by.ALTINS1.deficit, 106000, 'ALTINS1 eksik');
  near(by.ALTINS1.buyTL, 35000, 'ALTINS1 alım');
  near(by.VOO.buyTL + by.QQQ.buyTL + by.VXUS.buyTL, 0, 'USD alımları');
  assert.strictEqual(by.ALTINS1.units, 500); // 35000 / 70
  near(r.usdNeeded, 0, 'gereken USD');
});

test('eksik yoksa hedef oranlara göre dağıtır', () => {
  const a = [
    { id: 'A', currency: 'TRY', target: 60, qty: 60, price: 1 },
    { id: 'B', currency: 'TRY', target: 40, qty: 40, price: 1 }
  ];
  // Tam dengede: eksikler eşit oranda → yine 60/40
  const r = C.rebalance(a, 0, 100);
  near(r.rows[0].buyTL, 60, 'A');
  near(r.rows[1].buyTL, 40, 'B');
});

test('toplam eksik 0 ise hedef oranlarına göre dağıtır', () => {
  // A zaten hedefinin üstünde (eksik 0), B hariç → toplam eksik 0
  const a = [
    { id: 'A', currency: 'TRY', target: 50, qty: 1000, price: 1 },
    { id: 'B', currency: 'TRY', target: 50, qty: 0, price: 1 }
  ];
  const r = C.rebalance(a, 0, 100, ['B']);
  near(r.rows[0].buyTL, 100, 'A tümünü alır');
  near(r.rows[1].buyTL, 0, 'B hariç');
});

test('prim yüksekken altın hariç: payı diğerlerine gider, satış yok', () => {
  const r = C.rebalance(sample, 45, 35000, ['ALTINS1']);
  const sum = r.rows.reduce((s, x) => s + x.buyTL, 0);
  near(sum, 35000, 'toplam dağıtılan');
  assert.ok(r.rows.every(x => x.buyTL >= 0));
  near(r.rows.find(x => x.id === 'ALTINS1').buyTL, 0, 'altın 0');
  near(r.usdNeededTL, 35000, 'hepsi dolara');
});

test('USD alımda kesirli adet, artan para ve gereken dolar', () => {
  const a = [
    { id: 'VOO', currency: 'USD', target: 100, qty: 0, price: 700 }
  ];
  const r = C.rebalance(a, 45, 10000);
  near(r.usdNeeded, 10000 / 45, 'USD');
  assert.strictEqual(r.rows[0].units, C.floorTo(10000 / 45 / 700, 4));
  assert.ok(r.leftoverTL >= 0 && r.leftoverTL < 45 * 700 * 0.0001 + 0.01);
  near(r.rows[0].afterRatio, 100, 'alım sonrası oran');
});

test('500 TL altındaki alımlar önerilmez, tutar diğerlerine kayar', () => {
  // Kur 49,107; tutar 20.000 → normalde VXUS'a ~64 TL düşüyor
  const a = [
    { id: 'VOO', currency: 'USD', target: 50, qty: 10, price: 707.54 },
    { id: 'QQQ', currency: 'USD', target: 15, qty: 3, price: 749.58 },
    { id: 'VXUS', currency: 'USD', target: 15, qty: 20, price: 85.43 },
    { id: 'ALTINS1', currency: 'TRY', target: 20, qty: 0, price: 71.45 }
  ];
  const plain = C.rebalance(a, 49.107, 20000);
  const vx = plain.rows.find(x => x.id === 'VXUS').buyTL;
  assert.ok(vx > 0 && vx < 500, 'ön koşul: VXUS küçük');
  const r = C.rebalanceMin(a, 49.107, 20000, [], 500);
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  near(by.VXUS.buyTL, 0, 'VXUS atlandı');
  assert.strictEqual(by.VXUS.small, true);
  near(r.rows.reduce((s, x) => s + x.buyTL, 0), 20000, 'tutarın tamamı dağıtıldı');
  assert.ok(r.rows.every(x => x.buyTL === 0 || x.buyTL >= 500));
});

test('tutar sınırdan küçükse tamamı tek varlığa gider', () => {
  const r = C.rebalanceMin(sample, 45, 300, [], 500);
  near(r.rows.reduce((s, x) => s + x.buyTL, 0), 300, 'toplam');
  assert.strictEqual(r.rows.filter(x => x.buyTL > 0).length, 1);
});

test('geçersiz girişte anlaşılır hata', () => {
  const r = C.rebalance(sample, 0, -5);
  assert.ok(r.errors.some(e => e.includes('Eklenecek tutar')));
  assert.ok(r.errors.some(e => e.includes('kuru eksik')));
  const bad = sample.map(x => ({ ...x, target: 10 }));
  assert.ok(C.rebalance(bad, 45, 100).errors.some(e => e.includes('%100')));
});

test('altın primi ve renk eşikleri', () => {
  const gram = C.gramGoldFromSpot(4140.52, 49.107);
  near(gram, 6537.16, 'gram altın');
  const p = C.goldPremium(71.45, gram);
  near(p, 9.298, 'prim');
  assert.strictEqual(C.premiumLevel(p), 'green');
  assert.strictEqual(C.premiumLevel(15), 'yellow');
  assert.strictEqual(C.premiumLevel(25), 'red');
});
