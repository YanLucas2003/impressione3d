const { getAuth, getFirestore, hasFirebaseAdminConfig } = require("../lib/firebase-admin");

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

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

    const authHeader = req.headers.authorization || req.headers.Authorization || "";
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

  res.status(result.ok ? 200 : 500).json(result);
};
