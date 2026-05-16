const admin = require("firebase-admin");

function parseServiceAccount(raw, envName) {
  try {
    const account = JSON.parse(raw);
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
    return account;
  } catch (err) {
    throw new Error(envName + " invalido: " + err.message);
  }
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) return parseServiceAccount(raw, "FIREBASE_SERVICE_ACCOUNT");

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    return parseServiceAccount(decoded, "FIREBASE_SERVICE_ACCOUNT_BASE64");
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, "\n"),
    };
  }

  return null;
}

function hasFirebaseAdminConfig() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
  );
}

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const serviceAccount = getServiceAccount();
  if (!serviceAccount) {
    throw new Error("Firebase Admin nao configurado. Defina FIREBASE_SERVICE_ACCOUNT no ambiente.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID,
  });

  return admin;
}

function getAuth() {
  return getFirebaseAdmin().auth();
}

function getFirestore() {
  return getFirebaseAdmin().firestore();
}

module.exports = {
  fieldValue: admin.firestore.FieldValue,
  getAuth,
  getFirestore,
  hasFirebaseAdminConfig,
};
