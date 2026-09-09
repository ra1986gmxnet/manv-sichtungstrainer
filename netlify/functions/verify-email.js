// Diese Funktion wird aufgerufen, wenn ein Teilnehmer auf den Bestätigungslink in seiner
// Registrierungs-E-Mail klickt (einfacher GET-Aufruf, kein POST nötig). Sie markiert das
// Konto als "E-Mail bestätigt" und zeigt eine einfache Bestätigungsseite an.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}"))
  });
}
const db = admin.firestore();

function page(title, message, ok) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
    <title>${title}</title>
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        background:#F4F8FC;color:#1B2A41;display:flex;align-items:center;justify-content:center;
        min-height:100vh;margin:0;padding:20px;}
      .card{background:#fff;border-radius:14px;padding:32px;max-width:420px;text-align:center;
        box-shadow:0 12px 40px rgba(18,58,99,.15);}
      h1{font-size:1.3rem;color:${ok ? "#2FAE55" : "#E2231A"};}
      a{display:inline-block;margin-top:18px;background:#FFCC00;color:#123A63;font-weight:700;
        padding:10px 22px;border-radius:10px;text-decoration:none;}
    </style></head>
    <body><div class="card"><h1>${ok ? "✓" : "✕"} ${title}</h1><p>${message}</p>
    <a href="/">Zur Anmeldung</a></div></body></html>`
  };
}

exports.handler = async function (event) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return page("Server nicht konfiguriert", "Bitte den Administrator kontaktieren.", false);
  }
  const token = (event.queryStringParameters || {}).token;
  if (!token) return page("Ungültiger Link", "Es wurde kein Bestätigungs-Code übergeben.", false);

  try {
    const doc = await db.collection("appdata").doc("users").get();
    const users = doc.exists ? JSON.parse(doc.data().value) : {};
    const username = Object.keys(users).find(k => users[k].verifyToken === token);

    if (!username) {
      return page("Link ungültig oder bereits verwendet", "Bitte erneut registrieren oder auf der Anmeldeseite eine neue Bestätigungs-Mail anfordern.", false);
    }
    const u = users[username];
    if (u.verifyTokenExpires && Date.now() > u.verifyTokenExpires) {
      return page("Link abgelaufen", "Der Bestätigungslink ist nur 24 Stunden gültig. Bitte auf der Anmeldeseite eine neue Bestätigungs-Mail anfordern.", false);
    }

    u.emailVerified = true;
    delete u.verifyToken;
    delete u.verifyTokenExpires;
    await db.collection("appdata").doc("users").set({ value: JSON.stringify(users), updatedAt: Date.now() });

    return page("E-Mail bestätigt", `Danke, ${username}! Deine E-Mail-Adresse wurde bestätigt. Du kannst dich jetzt anmelden.`, true);
  } catch (e) {
    return page("Fehler", "Es ist ein Fehler aufgetreten: " + e.message, false);
  }
};
