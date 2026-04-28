const https = require("https");

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SITE_URL        = process.env.URL || "https://impressione3d.netlify.app";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!MP_ACCESS_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "MP_ACCESS_TOKEN nao configurado no Netlify." }) };
  }

  try {
    const { method, payer, orderId, total } = JSON.parse(event.body);

    if (method === "pix") {
      const pixBody = JSON.stringify({
        transaction_amount: parseFloat(total),
        description:        "Pedido impress.ione 3D - " + orderId,
        payment_method_id:  "pix",
        payer: {
          email:      payer.email,
          first_name: (payer.name || "Cliente").split(" ")[0],
          last_name:  (payer.name || "Cliente").split(" ").slice(1).join(" ") || "impress.ione",
          identification: { type: "CPF", number: (payer.cpf || "").replace(/\D/g,"") || "00000000000" },
        },
        external_reference: orderId,
        notification_url:   SITE_URL + "/.netlify/functions/payment-webhook",
        date_of_expiration: new Date(Date.now() + 15*60*1000).toISOString(),
      });

      const result = await callMP("POST", "/v1/payments", pixBody);
      return { statusCode: 200, headers, body: JSON.stringify({
        id:          result.id,
        status:      result.status,
        qr_code:     result.point_of_interaction?.transaction_data?.qr_code,
        qr_code_b64: result.point_of_interaction?.transaction_data?.qr_code_base64,
        ticket_url:  result.point_of_interaction?.transaction_data?.ticket_url,
        orderId,
      })};
    }

    if (method === "card") {
      const cardBody = JSON.stringify({
        transaction_amount: parseFloat(total),
        token:              payer.token,
        description:        "Pedido impress.ione 3D - " + orderId,
        installments:       parseInt(payer.installments) || 1,
        payment_method_id:  payer.payment_method_id,
        issuer_id:          payer.issuer_id,
        payer: {
          email:          payer.email,
          identification: { type: "CPF", number: (payer.cpf || "").replace(/\D/g,"") || "00000000000" },
        },
        external_reference:   orderId,
        notification_url:     SITE_URL + "/.netlify/functions/payment-webhook",
        statement_descriptor: "IMPRESSIONE 3D",
      });

      const result = await callMP("POST", "/v1/payments", cardBody);
      return { statusCode: 200, headers, body: JSON.stringify({
        id: result.id, status: result.status, status_detail: result.status_detail, orderId,
      })};
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Metodo invalido." }) };

  } catch (err) {
    console.error("create-payment error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function callMP(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.mercadopago.com", path, method,
      headers: {
        "Authorization":     "Bearer " + MP_ACCESS_TOKEN,
        "Content-Type":      "application/json",
        "X-Idempotency-Key": "impressione-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(d);
          if (res.statusCode >= 400) reject(new Error(p.message || p.cause?.[0]?.description || JSON.stringify(p)));
          else resolve(p);
        } catch { reject(new Error("Resposta invalida do Mercado Pago")); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
