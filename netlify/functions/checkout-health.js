const { getAuth, getFirestore, hasFirebaseAdminConfig } = require("../../lib/firebase-admin");

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") return json(headers, 405, { error: "Method not allowed" });

  const result = {
    ok: true,
    env: {
      MP_ACCESS_TOKEN: Boolean(MP_ACCESS_TOKEN),
      FIREBASE_SERVICE_ACCOUNT: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
      FIREBASE_SERVICE_ACCOUNT_BASE64: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64),
      FIREBASE_PROJECT_ID: Boolean(process.env.FIREBASE_PROJECT_ID),
      FIREBASE_CLIENT_EMAIL: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
      FIREBASE_PRIVATE_KEY: Boolean(process.env.FIREBASE_PRIVATE_KEY),
      firebaseAdminConfig: hasFirebaseAdminConfig(),
    },
    firebaseAdmin: {
      initialized: false,
      tokenVerified: false,
      firestoreReachable: false,
    },
  };

  try {
    const auth = getAuth();
    result.firebaseAdmin.initialized = true;

    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      await auth.verifyIdToken(match[1]);
      result.firebaseAdmin.tokenVerified = true;
    }

    await getFirestore().collection("orders").limit(1).get();
    result.firebaseAdmin.firestoreReachable = true;
  } catch (err) {
    result.ok = false;
    result.firebaseAdmin.error = err.message;
  }

  return json(headers, result.ok ? 200 : 500, result);
};

function json(headers, statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}
