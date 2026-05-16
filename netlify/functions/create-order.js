const { fieldValue, getAuth, getFirestore, hasFirebaseAdminConfig } = require("../../lib/firebase-admin");
const { calculateOrderTotal } = require("../../lib/product-catalog");

exports.handler = async (event) => {
  const requestId = createRequestId();
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return json(headers, 405, { error: "Method not allowed" });

  try {
    const { items = [], couponCode = "", payer = {} } = parseBody(event.body);
    const user = await verifyRequestUser(event.headers || {});
    const db = getFirestore();
    const order = await createManualOrder(db, { items, couponCode, payer, uid: user.uid });
    return json(headers, 200, { orderId: order.orderId, total: order.total });
  } catch (err) {
    console.error("create-order error", JSON.stringify({
      requestId,
      hasAuthorization: Boolean((event.headers || {}).authorization || (event.headers || {}).Authorization),
      hasFirebaseAdminConfig: hasFirebaseAdminConfig(),
      error: err.message,
      stack: err.stack,
    }));
    return json(headers, err.statusCode || 500, {
      error: err.publicMessage || "Nao foi possivel criar o pedido. Tente novamente em instantes.",
      requestId,
    });
  }
};

function createRequestId() {
  return "ord_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function json(headers, statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function publicError(message, statusCode = 400) {
  const err = new Error(message);
  err.publicMessage = message;
  err.statusCode = statusCode;
  return err;
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw publicError("JSON invalido.");
  }
}

async function verifyRequestUser(headers) {
  const authHeader = headers.authorization || headers.Authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) throw publicError("Sessao invalida. Entre novamente.", 401);

  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch {
    throw publicError("Sessao expirada. Entre novamente.", 401);
  }
}

async function createManualOrder(db, { items, couponCode, payer, uid }) {
  const discountPct = await resolveDiscountPct(db, couponCode, uid);
  const hasItems = Array.isArray(items) && items.length;
  const priced = hasItems
    ? calculateOrderTotal(items, { method: "card", discountPct })
    : { subtotal: 0, total: 0, discountPct: 0 };

  const orderId = generateOrderId();
  const cartItems = hasItems ? items.map((item) => ({
    id: String(item.id),
    name: String(item.name || item.id || ""),
    qty: Number(item.qty) || 1,
  })) : [];
  const itens = cartItems.length ? cartItems.map((item) => item.name + " x" + item.qty) : ["(pedido de servico)"];
  const userSnap = await db.collection("users").doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : {};
  const ref = db.collection("orders").doc();

  await ref.set({
    num: orderId,
    data: new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    itens,
    cartItems,
    subtotal: priced.subtotal,
    total: priced.total,
    discountPct: priced.discountPct,
    couponCode: String(couponCode || "").trim().toUpperCase(),
    statusIdx: 0,
    userId: uid,
    userName: user.nome || payer.name || "",
    userEmail: user.email || payer.email || "",
    userTel: user.telefone || "",
    paymentMethod: "manual",
    createdAt: fieldValue.serverTimestamp(),
  });

  if (couponCode) await markCouponUsed(db, uid, couponCode, orderId);
  return { orderId, total: priced.total };
}

async function resolveDiscountPct(db, couponCode, uid) {
  const code = String(couponCode || "").trim().toUpperCase();
  if (!code) return 0;

  const userSnap = await db.collection("users").doc(uid).get();
  const coupons = userSnap.exists ? userSnap.data().coupons || [] : [];
  const coupon = coupons.find((item) => String(item.code || "").toUpperCase() === code && !item.used);
  if (!coupon) throw publicError("Cupom invalido ou ja utilizado.");
  return Number(coupon.pct) || 0;
}

async function markCouponUsed(db, uid, couponCode, orderId) {
  const code = String(couponCode || "").trim().toUpperCase();
  if (!code) return;

  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) return;

    const coupons = userSnap.data().coupons || [];
    const nextCoupons = coupons.map((coupon) => {
      if (String(coupon.code || "").toUpperCase() !== code || coupon.used) return coupon;
      return { ...coupon, orderId, used: true, usedAt: new Date().toISOString() };
    });
    tx.update(userRef, { coupons: nextCoupons });
  });
}

function generateOrderId() {
  return "PED" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}
