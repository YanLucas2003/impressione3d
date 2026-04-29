const https = require("https");

const MP_ACCESS_TOKEN  = process.env.MP_ACCESS_TOKEN;
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || "impressione3d-4cd76";

const STATUS_MAP = { approved: 1, in_process: 1, pending: 0, rejected: -1, cancelled: -1, refunded: -1 };

module.exports = async (req, res) => {
  if (req.method === "GET") { res.status(200).send("OK"); return; }

  try {
    const body   = req.body || {};
    const topic  = body.type || req.query?.topic;
    const dataId = body.data?.id || req.query?.id;

    if (!dataId || topic !== "payment") {
      res.status(200).json({ msg: "ignored" }); return;
    }

    const payment  = await callMP("GET", "/v1/payments/" + dataId);
    const orderId  = payment.external_reference;
    const mpStatus = payment.status;
    const newIdx   = STATUS_MAP[mpStatus] ?? 0;

    if (!orderId) { res.status(200).json({ msg: "no orderId" }); return; }

    if (newIdx >= 0) {
      await updateOrderInFirestore(orderId, newIdx, {
        mpPaymentId:    String(dataId),
        mpStatus,
        mpStatusDetail: payment.status_detail || "",
        paidAt:         mpStatus === "approved" ? new Date().toISOString() : null,
        updatedAt:      new Date().toISOString(),
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error:", err.message);
    res.status(200).json({ error: err.message });
  }
};

async function updateOrderInFirestore(orderId, statusIdx, extra) {
  const base = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT + "/databases/(default)/documents";

  const queryBody = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: "orders" }],
      where: { fieldFilter: { field: { fieldPath: "num" }, op: "EQUAL", value: { stringValue: orderId } } },
      limit: 1,
    },
  });

  const queryResult = await callFirestore("POST", base + ":runQuery", queryBody);
  const results = Array.isArray(queryResult) ? queryResult : [queryResult];
  const docPath = results[0]?.document?.name;

  if (!docPath) { console.warn("Pedido nao encontrado:", orderId); return; }

  const fields = {
    statusIdx:      { integerValue: String(statusIdx) },
    mpPaymentId:    { stringValue: extra.mpPaymentId || "" },
    mpStatus:       { stringValue: extra.mpStatus || "" },
    mpStatusDetail: { stringValue: extra.mpStatusDetail || "" },
    updatedAt:      { stringValue: extra.updatedAt },
  };
  if (extra.paidAt) fields.paidAt = { stringValue: extra.paidAt };

  const mask = Object.keys(fields).map(f => "updateMask.fieldPaths=" + f).join("&");
  await callFirestore("PATCH", "https://firestore.googleapis.com/v1/" + docPath + "?" + mask, JSON.stringify({ fields }));
}

function callMP(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.mercadopago.com", path, method,
      headers: { "Authorization": "Bearer " + MP_ACCESS_TOKEN, "Content-Type": "application/json" },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("MP parse error")); } });
    });
    req.on("error", reject); req.end();
  });
}

function callFirestore(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method,
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
