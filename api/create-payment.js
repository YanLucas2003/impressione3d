const https = require("https");
const { fieldValue, getAuth, getFirestore, hasFirebaseAdminConfig } = require("../lib/firebase-admin");
const { calculateOrderTotal } = require("../lib/product-catalog");

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SITE_URL = process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "https://impressione3d.vercel.app";

module.exports = async (req, res) => {
  const requestId = createRequestId();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  if (!MP_ACCESS_TOKEN) {
    logBackendError("create-payment missing env", { requestId, missing: "MP_ACCESS_TOKEN" });
    res.status(500).json({ error: "Pagamento nao configurado. MP_ACCESS_TOKEN ausente.", requestId });
    return;
  }

  try {
    const { method, payer, items, couponCode } = req.body || {};
    validatePaymentInput(method, payer, items);
    validateFirebaseAdminReady();

    const user = await verifyRequestUser(req.headers || {});
    const db = getFirestore();
    const order = await createOrder(db, { method, payer, items, couponCode, uid: user.uid });
    const notificationUrl = SITE_URL + "/api/payment-webhook";

    const payment = await createPayment(method, payer, order.orderId, order.amount, notificationUrl);
    await persistPayment(order.ref, payment, method, order);

    if (method === "pix") {
      res.status(200).json({
        id: payment.id,
        status: payment.status,
        qr_code: payment.point_of_interaction?.transaction_data?.qr_code,
        qr_code_b64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
        ticket_url: payment.point_of_interaction?.transaction_data?.ticket_url,
        orderId: order.orderId,
      });
      return;
    }

    res.status(200).json({
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail,
      orderId: order.orderId,
    });
  } catch (err) {
    logBackendError("create-payment error", {
      requestId,
      method: req.body?.method,
      hasAuthorization: Boolean((req.headers || {}).authorization || (req.headers || {}).Authorization),
      hasFirebaseAdminConfig: hasFirebaseAdminConfig(),
      error: err.message,
      stack: err.stack,
    });
    res.status(err.statusCode || 500).json({
      error: err.publicMessage || "Nao foi possivel criar o pagamento. Tente novamente em instantes.",
      requestId,
    });
  }
};

function createRequestId() {
  return "chk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function validateFirebaseAdminReady() {
  if (!hasFirebaseAdminConfig()) {
    throw publicError("Checkout indisponivel: Firebase Admin nao configurado no deploy.", 500);
  }
}

function logBackendError(message, details) {
  console.error(message, JSON.stringify(details));
}

function publicError(message, statusCode = 400) {
  const err = new Error(message);
  err.publicMessage = message;
  err.statusCode = statusCode;
  return err;
}

function validatePaymentInput(method, payer, items) {
  if (!["pix", "card"].includes(method)) throw publicError("Metodo invalido.");
  if (!payer?.email) throw publicError("E-mail do pagador obrigatorio.");
  if (!Array.isArray(items) || !items.length) throw publicError("Carrinho invalido.");
  if (method === "card" && (!payer.token || !payer.payment_method_id)) {
    throw publicError("Dados do cartao invalidos.");
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

async function createOrder(db, { method, payer, items, couponCode, uid }) {
  const discountPct = await resolveDiscountPct(db, couponCode, uid);
  let priced;
  try {
    priced = calculateOrderTotal(items, { method, discountPct });
  } catch (err) {
    throw publicError(err.message);
  }

  const orderId = generateOrderId();
  const cartItems = items.map((item) => ({
    id: String(item.id),
    name: String(item.name || item.id || ""),
    qty: Number(item.qty) || 1,
  }));
  const itens = cartItems.map((item) => item.name + " x" + item.qty);
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
    paymentMethod: method,
    createdAt: fieldValue.serverTimestamp(),
  });

  return {
    orderId,
    amount: priced.total,
    discountPct: priced.discountPct,
    ref,
    subtotal: priced.subtotal,
  };
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

function generateOrderId() {
  return "PED" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function persistPayment(orderRef, payment, method, order) {
  const update = {
    discountPct: order.discountPct,
    mpPaymentId: String(payment.id || ""),
    mpStatus: payment.status || "",
    mpStatusDetail: payment.status_detail || "",
    paymentMethod: method,
    subtotal: order.subtotal,
    total: order.amount,
    updatedAt: fieldValue.serverTimestamp(),
  };

  if (payment.status === "approved" || payment.status === "in_process") update.statusIdx = 1;
  if (payment.status === "approved") update.paidAt = fieldValue.serverTimestamp();

  await orderRef.set(update, { merge: true });
}

function createPayment(method, payer, orderId, amount, notificationUrl) {
  const cleanCpf = (payer.cpf || "").replace(/\D/g, "") || "00000000000";
  const common = {
    transaction_amount: amount,
    description: "Pedido impress.ione 3D - " + orderId,
    external_reference: orderId,
    notification_url: notificationUrl,
  };

  if (method === "pix") {
    return callMP("POST", "/v1/payments", JSON.stringify({
      ...common,
      payment_method_id: "pix",
      payer: {
        email: payer.email,
        first_name: (payer.name || "Cliente").split(" ")[0],
        last_name: (payer.name || "Cliente").split(" ").slice(1).join(" ") || "impress.ione",
        identification: { type: "CPF", number: cleanCpf },
      },
      date_of_expiration: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }), orderId, method);
  }

  return callMP("POST", "/v1/payments", JSON.stringify({
    ...common,
    token: payer.token,
    installments: parseInt(payer.installments, 10) || 1,
    payment_method_id: payer.payment_method_id,
    issuer_id: payer.issuer_id,
    payer: {
      email: payer.email,
      identification: { type: "CPF", number: cleanCpf },
    },
    statement_descriptor: "IMPRESSIONE 3D",
  }), orderId, method);
}

function callMP(method, path, body, orderId, paymentMethod) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.mercadopago.com",
      path,
      method,
      headers: {
        "Authorization": "Bearer " + MP_ACCESS_TOKEN,
        "Content-Type": "application/json",
        "X-Idempotency-Key": "impressione-" + orderId + "-" + paymentMethod,
      },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => data += chunk);
      response.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (response.statusCode >= 400) {
            const message = parsed.message || parsed.cause?.[0]?.description || JSON.stringify(parsed);
            const err = new Error("Mercado Pago " + response.statusCode + ": " + message);
            err.mpStatusCode = response.statusCode;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error("Resposta invalida do Mercado Pago"));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
