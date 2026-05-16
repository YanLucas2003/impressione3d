const https = require("https");
const { fieldValue, getFirestore } = require("../lib/firebase-admin");

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const STATUS_MAP = { approved: 1, in_process: 1, pending: 0, rejected: -1, cancelled: -1, refunded: -1 };

module.exports = async (req, res) => {
  const requestId = createRequestId();
  if (req.method === "GET") { res.status(200).send("OK"); return; }
  if (!MP_ACCESS_TOKEN) {
    console.error("webhook missing env", JSON.stringify({ requestId, missing: "MP_ACCESS_TOKEN" }));
    res.status(500).json({ error: "Pagamento nao configurado.", requestId });
    return;
  }

  try {
    const body = req.body || {};
    const topic = body.type || req.query?.topic;
    const dataId = body.data?.id || req.query?.id;

    if (!dataId || topic !== "payment") {
      res.status(200).json({ msg: "ignored" });
      return;
    }

    const payment = await callMP("GET", "/v1/payments/" + dataId);
    const orderId = payment.external_reference;
    const mpStatus = payment.status;
    const newIdx = STATUS_MAP[mpStatus] ?? 0;

    if (!orderId) { res.status(200).json({ msg: "no orderId" }); return; }

    if (newIdx >= 0) {
      await updateOrderInFirestore(orderId, newIdx, {
        mpPaymentId: String(dataId),
        mpStatus,
        mpStatusDetail: payment.status_detail || "",
        approved: mpStatus === "approved",
      });
      console.log("webhook order updated", JSON.stringify({ requestId, orderId, dataId: String(dataId), mpStatus, statusIdx: newIdx }));
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error", JSON.stringify({ requestId, error: err.message, stack: err.stack }));
    res.status(500).json({ error: "Webhook temporariamente indisponivel.", requestId });
  }
};

function createRequestId() {
  return "wh_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

async function updateOrderInFirestore(orderId, statusIdx, extra) {
  const db = getFirestore();
  const snap = await db.collection("orders").where("num", "==", String(orderId)).limit(1).get();

  if (snap.empty) {
    console.warn("Pedido nao encontrado:", orderId);
    return;
  }

  const doc = snap.docs[0];
  const order = doc.data();
  const fields = {
    statusIdx,
    mpPaymentId: extra.mpPaymentId || "",
    mpStatus: extra.mpStatus || "",
    mpStatusDetail: extra.mpStatusDetail || "",
    updatedAt: fieldValue.serverTimestamp(),
  };
  if (extra.approved) fields.paidAt = fieldValue.serverTimestamp();

  await doc.ref.set(fields, { merge: true });
  if (extra.approved) await markCouponUsed(db, order, orderId);
}

async function markCouponUsed(db, order, orderId) {
  const code = String(order.couponCode || "").trim().toUpperCase();
  if (!code || !order.userId) return;

  const userRef = db.collection("users").doc(order.userId);
  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) return;

    const coupons = userSnap.data().coupons || [];
    let changed = false;
    const nextCoupons = coupons.map((coupon) => {
      if (String(coupon.code || "").toUpperCase() !== code || coupon.used) return coupon;
      changed = true;
      return {
        ...coupon,
        orderId,
        used: true,
        usedAt: new Date().toISOString(),
      };
    });

    if (changed) tx.update(userRef, { coupons: nextCoupons });
  });
}

function callMP(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.mercadopago.com",
      path,
      method,
      headers: { "Authorization": "Bearer " + MP_ACCESS_TOKEN, "Content-Type": "application/json" },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => data += chunk);
      response.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (response.statusCode >= 400) reject(new Error(parsed.message || JSON.stringify(parsed)));
          else resolve(parsed);
        } catch {
          reject(new Error("MP parse error"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
