const https = require("https");
const { fieldValue, getAuth, getFirestore } = require("../lib/firebase-admin");
const { calculateOrderTotal } = require("../lib/product-catalog");

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SITE_URL = process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "https://impressione3d.vercel.app";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  if (!MP_ACCESS_TOKEN) { res.status(500).json({ error: "Pagamento nao configurado." }); return; }

  try {
    const { method, payer, orderId } = req.body || {};
    validatePaymentInput(method, payer, orderId);

    const user = await verifyRequestUser(req.headers || {});
    const db = getFirestore();
    const order = await loadAndPriceOrder(db, orderId, method, user.uid);
    const notificationUrl = SITE_URL + "/api/payment-webhook";

    const payment = await createPayment(method, payer, orderId, order.amount, notificationUrl);
    await persistPayment(order.ref, payment, method, order);

    if (method === "pix") {
      res.status(200).json({
        id: payment.id,
        status: payment.status,
        qr_code: payment.point_of_interaction?.transaction_data?.qr_code,
        qr_code_b64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
        ticket_url: payment.point_of_interaction?.transaction_data?.ticket_url,
        orderId,
      });
      return;
    }

    res.status(200).json({
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail,
      orderId,
    });
  } catch (err) {
    console.error("create-payment error:", err.message);
    res.status(err.statusCode || 500).json({ error: err.publicMessage || "Nao foi possivel criar o pagamento." });
  }
};

function publicError(message, statusCode = 400) {
  const err = new Error(message);
  err.publicMessage = message;
  err.statusCode = statusCode;
  return err;
}

function validatePaymentInput(method, payer, orderId) {
  if (!["pix", "card"].includes(method)) throw publicError("Metodo invalido.");
  if (!orderId) throw publicError("Pedido invalido.");
  if (!payer?.email) throw publicError("E-mail do pagador obrigatorio.");
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

async function loadAndPriceOrder(db, orderId, method, uid) {
  const snap = await db.collection("orders").where("num", "==", String(orderId)).limit(1).get();
  if (snap.empty) throw publicError("Pedido nao encontrado.", 404);

  const doc = snap.docs[0];
  const data = doc.data();
  if (data.userId !== uid) throw publicError("Pedido nao pertence ao usuario.", 403);
  if (data.paymentMethod && data.paymentMethod !== method) throw publicError("Metodo de pagamento divergente.");

  const discountPct = await resolveDiscountPct(db, data, uid);
  let priced;
  try {
    priced = calculateOrderTotal(data.cartItems, { method, discountPct });
  } catch (err) {
    throw publicError(err.message);
  }

  return {
    amount: priced.total,
    discountPct: priced.discountPct,
    ref: doc.ref,
    subtotal: priced.subtotal,
  };
}

async function resolveDiscountPct(db, order, uid) {
  const code = String(order.couponCode || "").trim().toUpperCase();
  if (!code) return 0;

  const userSnap = await db.collection("users").doc(uid).get();
  const coupons = userSnap.exists ? userSnap.data().coupons || [] : [];
  const coupon = coupons.find((item) => String(item.code || "").toUpperCase() === code && !item.used);
  if (!coupon) throw publicError("Cupom invalido ou ja utilizado.");
  return Number(coupon.pct) || 0;
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
            reject(new Error(parsed.message || parsed.cause?.[0]?.description || JSON.stringify(parsed)));
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
