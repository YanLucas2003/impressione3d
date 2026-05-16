const PRODUCT_PRICES = Object.freeze({
  "58258690264": 35.9,
  "58258261766": 69.9,
  "58257298719": 999.0,
  "58256989266": 34.9,
  "58256951483": 19.9,
  "58256949339": 29.9,
  "58256946989": 50.0,
  "58256624100": 19.9,
  "58256624043": 20.9,
  "58256624011": 14.9,
  "58256567442": 49.9,
  "58256566785": 59.9,
  "58256566355": 9.9,
  "58256566328": 14.9,
  "58255165191": 50.9,
  "58255164243": 69.9,
  "58254875829": 13.99,
  "58254875414": 39.9,
  "58254676783": 22.9,
  "58209181849": 1999.0,
  "58208546845": 299.9,
  "58208320782": 29.9,
  "58208271473": 39.9,
  "58208271265": 49.9,
  "58208245120": 79.9,
  "58208193262": 20.0,
  "58206988284": 32.9,
  "58206984987": 49.9,
  "58206955893": 64.9,
  "58206955709": 49.9,
  "58206950621": 24.9,
  "58206950233": 34.9,
  "58206931153": 14.9,
  "58206849995": 14.9,
  "58206849632": 89.9,
  "58206702569": 199.0,
  "58206604886": 999.0,
  "58206563059": 29.9,
  "58206562851": 22.9,
  "58206281913": 49.9,
  "58206205506": 109.9,
  "58206060930": 49.9,
  "58205324104": 99.9,
  "58205275985": 34.9,
  "58205275961": 39.9,
  "58205275898": 29.9,
  "58205176521": 35.9,
  "23899363065": 24.9,
  "23799366192": 19.9,
  "23399438746": 249.9,
  "23394860428": 19.9,
  "23299373136": 29.9,
  "23299366265": 19.9,
  "23294899335": 39.9,
  "22899443981": 199.9,
  "22899372972": 24.9,
  "22894881876": 24.9,
  "22599448574": 19.0,
  "22599382807": 69.9,
  "22399408604": 999.0,
  "22199391285": 59.9,
  "22094916892": 20.0,
});

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeQty(value) {
  const qty = Number(value);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
    throw new Error("Quantidade invalida.");
  }
  return qty;
}

function normalizeDiscount(value) {
  const pct = Number(value) || 0;
  if (pct < 0 || pct > 90) throw new Error("Desconto invalido.");
  return pct;
}

function calculateOrderTotal(items, options = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error("Carrinho invalido.");
  }

  let subtotal = 0;
  for (const item of items) {
    const id = String(item?.id || "");
    const price = PRODUCT_PRICES[id];
    if (typeof price !== "number") throw new Error("Produto invalido.");
    subtotal += price * normalizeQty(item.qty);
  }

  const discountPct = normalizeDiscount(options.discountPct);
  const discounted = roundMoney(roundMoney(subtotal) * (1 - discountPct / 100));
  const total = options.method === "pix" ? roundMoney(discounted * 0.9) : discounted;

  return {
    discountPct,
    subtotal: roundMoney(subtotal),
    total,
  };
}

module.exports = {
  calculateOrderTotal,
};
