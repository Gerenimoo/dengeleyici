// Çalıştırma: node --test  ya da tarayıcıda test.html
const isNode = typeof require === 'function';
const test = isNode ? require('node:test') : window.__test;
const assert = isNode ? require('node:assert') : window.__assert;
const C = isNode ? require('./calc.js') : window.Calc;

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} ≠ ${b}`);

// Kur 45; VOO 7.000 / QQQ 2.000 / VXUS 0 USD; hedefler 60/20/20; eklenecek 35.000 TL
const sample = [
  { id: 'VOO', currency: 'USD', target: 60, qty: 10, price: 700 },
  { id: 'QQQ', currency: 'USD', target: 20, qty: 4, price: 500 },
  { id: 'VXUS', currency: 'USD', target: 20, qty: 0, price: 100 }
];

test('örnek: 35.000 TL\'nin tamamı VXUS\'a', () => {
  const r = C.rebalance(sample, 45, 35000);
  assert.deepStrictEqual(r.errors, []);
  // TL değerler 315.000 / 90.000 / 0 → toplam 405.000; yeni toplam 440.000
  near(r.currentTL, 405000, 'mevcut toplam');
  near(r.newTotalTL, 440000, 'yeni toplam');
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  near(by.VOO.valueTL, 315000, 'VOO TL');
  near(by.QQQ.valueTL, 90000, 'QQQ TL');
  near(by.VOO.targetTL, 264000, 'VOO hedef');
  near(by.QQQ.targetTL, 88000, 'QQQ hedef');
  near(by.VXUS.targetTL, 88000, 'VXUS hedef');
  near(by.VOO.deficit, 0, 'VOO eksik');
  near(by.QQQ.deficit, 0, 'QQQ eksik');
  near(by.VXUS.deficit, 88000, 'VXUS eksik');
  near(by.VXUS.buyTL, 35000, 'VXUS alım');
  near(by.VOO.buyTL + by.QQQ.buyTL, 0, 'diğer alımlar');
  near(r.usdNeeded, 35000 / 45, 'gereken USD');
  assert.strictEqual(by.VXUS.units, C.floorTo(35000 / 45 / 100, 4));
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

test('hariç tutulan varlığın payı diğerlerine gider, satış yok', () => {
  const r = C.rebalance(sample, 45, 35000, ['VXUS']);
  const sum = r.rows.reduce((s, x) => s + x.buyTL, 0);
  near(sum, 35000, 'toplam dağıtılan');
  assert.ok(r.rows.every(x => x.buyTL >= 0));
  near(r.rows.find(x => x.id === 'VXUS').buyTL, 0, 'VXUS 0');
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
  // Kur 1; eksikler 570 / 240 / 1.190 → QQQ'ya 240 TL düşer
  const a = [
    { id: 'VOO', currency: 'USD', target: 60, qty: 6000, price: 1 },
    { id: 'QQQ', currency: 'USD', target: 20, qty: 1950, price: 1 },
    { id: 'VXUS', currency: 'USD', target: 20, qty: 1000, price: 1 }
  ];
  const plain = C.rebalance(a, 1, 2000);
  near(plain.rows.find(x => x.id === 'QQQ').buyTL, 240, 'ön koşul: QQQ küçük');
  const r = C.rebalanceMin(a, 1, 2000, [], 500);
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  near(by.QQQ.buyTL, 0, 'QQQ atlandı');
  assert.strictEqual(by.QQQ.small, true);
  near(by.VOO.buyTL, 2000 * 570 / 1760, 'VOO');
  near(by.VXUS.buyTL, 2000 * 1190 / 1760, 'VXUS');
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
