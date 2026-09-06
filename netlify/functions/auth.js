// ============================================================================
// Diese Funktion läuft NICHT im Browser, sondern serverseitig bei Netlify.
// Sie ist der EINZIGE Ort, an dem Benutzerdaten (inkl. Passwörter) gelesen oder
// geschrieben werden. Der Browser/Quelltext sieht Passwörter NIEMALS im Klartext:
// - Passwörter werden serverseitig gehasht (Node "crypto", scrypt + individuelles Salt)
//   gespeichert, nie im Klartext in der Datenbank abgelegt.
// - Der Client bekommt nach dem Login nur ein signiertes, zeitlich begrenztes
//   Sitzungs-Token zurück (kein Passwort, kein Passwort-Hash).
// - Admin-Aktionen (Nutzer anlegen/ändern/löschen/Passwort setzen/Rolle ändern)
//   erfordern dieses gültige Admin-Token; das Token wird serverseitig geprüft.
// - Die Firestore-Regeln (firestore.rules) sperren das Dokument "appdata/users"
//   für JEDEN direkten Zugriff aus dem Browser — nur diese Funktion (mit dem
//   privaten Service-Account-Schlüssel) darf es lesen/schreiben.
//
// Einrichtung: siehe DEPLOYMENT.md. Benötigt die Umgebungsvariablen
// FIREBASE_SERVICE_ACCOUNT_JSON und SESSION_SECRET in den Netlify-Projekteinstellungen.
// ============================================================================

const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}"))
  });
}
const db = admin.firestore();

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function resp(obj) { return { statusCode: 200, headers, body: JSON.stringify(obj) }; }
function nowStamp() {
  return new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

// ---- Passwort-Hashing (Node-eigenes "crypto", keine Zusatz-Bibliothek nötig) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(hash, "hex"));
  } catch (e) { return false; }
}

// ---- Signierte, zeitlich begrenzte Sitzungs-Tokens (kleines eigenes JWT-Äquivalent) ----
function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); } catch (e) { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

async function loadUsers() {
  const doc = await db.collection("appdata").doc("users").get();
  return doc.exists ? JSON.parse(doc.data().value) : {};
}
async function saveUsers(users) {
  await db.collection("appdata").doc("users").set({ value: JSON.stringify(users), updatedAt: Date.now() });
}
function stripSecret(u) {
  const { password, passwordHash, passwordSalt, ...rest } = u;
  return rest;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return resp({ ok: false, error: "Nur POST-Anfragen erlaubt." });

  const SECRET = process.env.SESSION_SECRET;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !SECRET) {
    return resp({ ok: false, error: "Server nicht konfiguriert: FIREBASE_SERVICE_ACCOUNT_JSON und/oder SESSION_SECRET fehlen in den Netlify-Umgebungsvariablen (siehe DEPLOYMENT.md)." });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return resp({ ok: false, error: "Ungültiger Request-Body." }); }

  try {
    let users = await loadUsers();

    // Einmalige Ersteinrichtung: falls noch nie ein Nutzer existiert hat, Standard-Admin anlegen.
    if (!users || Object.keys(users).length === 0) {
      const { salt, hash } = hashPassword("1234");
      users = {
        Martin: { username: "Martin", email: "admin@example.org", role: "admin", locked: false,
          createdAt: nowStamp(), lastLogin: null, passwordSalt: salt, passwordHash: hash }
      };
      await saveUsers(users);
    }

    // ---------------- LOGIN ----------------
    if (payload.action === "login") {
      const { username, password } = payload;
      const u = users[username];
      if (!u) return resp({ ok: false, error: "Benutzer nicht gefunden" });
      if (u.locked) return resp({ ok: false, error: "Konto gesperrt – bitte Admin kontaktieren" });

      let valid = false;
      if (u.passwordHash && u.passwordSalt) {
        valid = verifyPassword(password, u.passwordSalt, u.passwordHash);
      } else if (u.password !== undefined) {
        // Altbestand mit Klartext-Passwort (vor diesem Sicherheits-Update angelegt):
        // bei erfolgreichem Login transparent auf gehashtes Passwort migrieren.
        valid = u.password === password;
        if (valid) {
          const { salt, hash } = hashPassword(password);
          delete u.password;
          u.passwordSalt = salt;
          u.passwordHash = hash;
        }
      }
      if (!valid) return resp({ ok: false, error: "Passwort falsch" });

      u.lastLogin = nowStamp();
      await saveUsers(users);
      const token = signToken({ username: u.username, role: u.role, exp: Date.now() + 12 * 3600 * 1000 }, SECRET);
      return resp({ ok: true, user: stripSecret(u), token });
    }

    // ---------------- REGISTRIERUNG (öffentlich, wie bisher) ----------------
    if (payload.action === "register") {
      const { username, password, email } = payload;
      if (!username || !password || password.length < 3) {
        return resp({ ok: false, error: "Benutzername und ein Passwort mit mind. 3 Zeichen erforderlich" });
      }
      if (users[username]) return resp({ ok: false, error: "Benutzername bereits vergeben" });
      const { salt, hash } = hashPassword(password);
      users[username] = { username, email: email || "", role: "teilnehmer", locked: false,
        createdAt: nowStamp(), lastLogin: null, passwordSalt: salt, passwordHash: hash };
      await saveUsers(users);
      return resp({ ok: true });
    }

    // ---------------- ADMIN-AKTIONEN (erfordern gültiges Admin-Token) ----------------
    if (payload.action === "adminOp") {
      const claims = verifyToken(payload.token, SECRET);
      if (!claims) return resp({ ok: false, error: "Sitzung abgelaufen oder ungültig – bitte neu einloggen" });
      const caller = users[claims.username];
      if (!caller || caller.role !== "admin" || caller.locked) {
        return resp({ ok: false, error: "Keine Admin-Berechtigung" });
      }

      const op = payload.op;
      const p = payload.opPayload || {};

      if (op === "listUsers") {
        return resp({ ok: true, users: Object.values(users).map(stripSecret) });
      }

      if (op === "createUser") {
        if (!p.username || !p.password || p.password.length < 3) {
          return resp({ ok: false, error: "Benutzername und Passwort (mind. 3 Zeichen) erforderlich" });
        }
        if (users[p.username]) return resp({ ok: false, error: "Benutzername bereits vergeben" });
        const { salt, hash } = hashPassword(p.password);
        users[p.username] = { username: p.username, email: p.email || "", role: p.role || "teilnehmer",
          locked: false, createdAt: nowStamp(), lastLogin: null, passwordSalt: salt, passwordHash: hash };
        await saveUsers(users);
        return resp({ ok: true });
      }

      if (op === "editUser") {
        const u = users[p.oldUsername];
        if (!u) return resp({ ok: false, error: "Nutzer nicht gefunden" });
        let finalUsername = p.oldUsername;
        if (p.newUsername && p.newUsername !== p.oldUsername) {
          if (p.oldUsername === "Martin") return resp({ ok: false, error: "Der Benutzername von Martin kann nicht geändert werden" });
          if (users[p.newUsername]) return resp({ ok: false, error: "Dieser Benutzername ist bereits vergeben" });
          delete users[p.oldUsername];
          u.username = p.newUsername;
          users[p.newUsername] = u;
          finalUsername = p.newUsername;
        }
        if (p.email !== undefined) u.email = p.email;
        if (p.role !== undefined && p.oldUsername !== "Martin") u.role = p.role;
        if (p.locked !== undefined) u.locked = p.locked;
        await saveUsers(users);
        return resp({ ok: true, finalUsername });
      }

      if (op === "setPassword") {
        const u = users[p.username];
        if (!u) return resp({ ok: false, error: "Nutzer nicht gefunden" });
        if (!p.newPassword || p.newPassword.length < 3) return resp({ ok: false, error: "Passwort zu kurz (mind. 3 Zeichen)" });
        const { salt, hash } = hashPassword(p.newPassword);
        delete u.password;
        u.passwordSalt = salt;
        u.passwordHash = hash;
        await saveUsers(users);
        return resp({ ok: true });
      }

      if (op === "deleteUser") {
        if (p.username === "Martin") return resp({ ok: false, error: "Admin Martin kann nicht gelöscht werden" });
        delete users[p.username];
        await saveUsers(users);
        return resp({ ok: true });
      }

      if (op === "toggleLock") {
        const u = users[p.username];
        if (!u) return resp({ ok: false, error: "Nutzer nicht gefunden" });
        u.locked = !u.locked;
        await saveUsers(users);
        return resp({ ok: true, locked: u.locked });
      }

      if (op === "assignRole") {
        const u = users[p.username];
        if (!u) return resp({ ok: false, error: "Nutzer nicht gefunden" });
        if (p.username === "Martin") return resp({ ok: false, error: "Die Rolle von Martin kann nicht geändert werden" });
        u.role = p.role;
        await saveUsers(users);
        return resp({ ok: true });
      }

      return resp({ ok: false, error: "Unbekannte Admin-Operation" });
    }

    return resp({ ok: false, error: "Unbekannte Aktion" });
  } catch (e) {
    return resp({ ok: false, error: "Serverfehler: " + e.message });
  }
};
