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
// - Bei jeder neuen Registrierung erhalten alle Admin-Konten mit hinterlegter
//   E-Mail-Adresse automatisch eine Benachrichtigungs-Mail (nur wenn GMAIL_USER/
//   GMAIL_APP_PASSWORD gesetzt sind).
// - Die Firestore-Regeln (firestore.rules) sperren das Dokument "appdata/users"
//   für JEDEN direkten Zugriff aus dem Browser — nur diese Funktion (mit dem
//   privaten Service-Account-Schlüssel) darf es lesen/schreiben.
//
// Einrichtung: siehe DEPLOYMENT.md. Benötigt die Umgebungsvariablen
// FIREBASE_SERVICE_ACCOUNT_JSON und SESSION_SECRET in den Netlify-Projekteinstellungen.
// ============================================================================

const crypto = require("crypto");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// Wird die Initialisierung NICHT abgesichert und FIREBASE_SERVICE_ACCOUNT_JSON ist
// ungültig, stürzt die gesamte Funktion mit einem kryptischen Laufzeitfehler ab
// (Runtime.UserCodeSyntaxError), noch bevor überhaupt eine JSON-Antwort möglich ist.
// Deshalb wird der Fehler hier abgefangen und weiter unten als klare, verständliche
// Fehlermeldung an den Client zurückgegeben.
let FIREBASE_INIT_ERROR = null;
let db = null;
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}"))
    });
  }
  db = admin.firestore();
} catch (e) {
  FIREBASE_INIT_ERROR = e.message;
}

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

// ---- E-Mail-Versand (Gmail SMTP über nodemailer). Optional: ohne GMAIL_USER/
// GMAIL_APP_PASSWORD wird die Verifizierungspflicht automatisch übersprungen,
// damit die App auch ohne konfigurierten Mailversand nutzbar bleibt. ----
const EMAIL_CONFIGURED = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
let mailTransporter = null;
function getTransporter() {
  if (!EMAIL_CONFIGURED) return null;
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
  }
  return mailTransporter;
}
async function sendMail(to, subject, html) {
  const t = getTransporter();
  if (!t) return false;
  await t.sendMail({ from: `"mSTaRT Sichtungstrainer" <${process.env.GMAIL_USER}>`, to, subject, html });
  return true;
}

async function loadUsers() {
  const doc = await db.collection("appdata").doc("users").get();
  return doc.exists ? JSON.parse(doc.data().value) : {};
}
async function saveUsers(users) {
  await db.collection("appdata").doc("users").set({ value: JSON.stringify(users), updatedAt: Date.now() });
}
function stripSecret(u) {
  const { password, passwordHash, passwordSalt, verifyToken: vt, ...rest } = u;
  return rest;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return resp({ ok: false, error: "Nur POST-Anfragen erlaubt." });

  const SECRET = process.env.SESSION_SECRET;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !SECRET) {
    return resp({ ok: false, error: "Server nicht konfiguriert: FIREBASE_SERVICE_ACCOUNT_JSON und/oder SESSION_SECRET fehlen in den Netlify-Umgebungsvariablen (siehe DEPLOYMENT.md)." });
  }
  if (FIREBASE_INIT_ERROR) {
    return resp({ ok: false, error: "FIREBASE_SERVICE_ACCOUNT_JSON ist ungültig (kein korrektes JSON): " + FIREBASE_INIT_ERROR + " — bitte in den Netlify-Umgebungsvariablen den KOMPLETTEN Inhalt der von Firebase heruntergeladenen JSON-Datei erneut einfügen (muss mit { beginnen und mit } enden, ohne zusätzlichen Text davor/danach)." });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return resp({ ok: false, error: "Ungültiger Request-Body." }); }

  try {
    let users = await loadUsers();

    // ---------------- ERSTEINRICHTUNG (ersetzt den früheren, fest im Quelltext
    // hinterlegten Standard-Admin "Martin/1234" — es gibt jetzt KEIN Konto mehr,
    // dessen Zugangsdaten irgendwo im Quelltext stehen) ----------------
    if (payload.action === "checkSetup") {
      return resp({ ok: true, needsSetup: Object.keys(users).length === 0 });
    }
    if (payload.action === "bootstrapAdmin") {
      if (Object.keys(users).length > 0) {
        return resp({ ok: false, error: "Ersteinrichtung bereits abgeschlossen." });
      }
      const { username, password, email } = payload;
      if (!username || !password || password.length < 6) {
        return resp({ ok: false, error: "Benutzername und ein Passwort mit mind. 6 Zeichen erforderlich" });
      }
      const { salt, hash } = hashPassword(password);
      users[username] = { username, email: email || "", role: "admin", locked: false,
        createdAt: nowStamp(), lastLogin: nowStamp(), passwordSalt: salt, passwordHash: hash,
        emailVerified: true }; // Ersteinrichtung durch die Person mit Server-/Hosting-Zugriff, keine Mail-Verifizierung nötig
      await saveUsers(users);
      const token = signToken({ username, role: "admin", exp: Date.now() + 12 * 3600 * 1000 }, SECRET);
      return resp({ ok: true, user: stripSecret(users[username]), token });
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

      // E-Mail-Verifizierung: nur blockieren, wenn explizit auf false gesetzt (neue,
      // noch unbestätigte Konten). Alt-Konten ohne dieses Feld bleiben nutzbar.
      if (u.emailVerified === false) {
        return resp({ ok: false, error: "Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Bestätigungs-Mail). Keine Mail erhalten? Auf der Anmeldeseite erneut anfordern." });
      }

      u.lastLogin = nowStamp();
      await saveUsers(users);
      const token = signToken({ username: u.username, role: u.role, exp: Date.now() + 12 * 3600 * 1000 }, SECRET);
      return resp({ ok: true, user: stripSecret(u), token });
    }

    // ---------------- REGISTRIERUNG (öffentlich) ----------------
    if (payload.action === "register") {
      const { username, password, email } = payload;
      if (!username || !password || password.length < 3) {
        return resp({ ok: false, error: "Benutzername und ein Passwort mit mind. 3 Zeichen erforderlich" });
      }
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return resp({ ok: false, error: "Bitte eine gültige E-Mail-Adresse angeben" });
      }
      if (users[username]) return resp({ ok: false, error: "Benutzername bereits vergeben" });
      const { salt, hash } = hashPassword(password);
      const newUser = { username, email, role: "teilnehmer", locked: false,
        createdAt: nowStamp(), lastLogin: null, passwordSalt: salt, passwordHash: hash };

      // Benachrichtigt alle Admin-Konten mit hinterlegter E-Mail-Adresse über die neue
      // Registrierung. Läuft über denselben Gmail-Versand wie die Verifizierungs-Mail;
      // ohne konfigurierten Mailversand (EMAIL_CONFIGURED=false) passiert hier nichts,
      // die Registrierung selbst wird davon nie beeinträchtigt (Fehler werden nur geloggt).
      async function notifyAdminsOfNewRegistration(verificationPending) {
        if (!EMAIL_CONFIGURED) return;
        const adminEmails = Object.values(users)
          .filter(u => u.role === "admin" && u.email)
          .map(u => u.email);
        if (!adminEmails.length) return;
        const statusLine = verificationPending
          ? "Der Nutzer muss seine E-Mail-Adresse noch bestätigen, bevor er sich einloggen kann."
          : "Das Konto ist sofort aktiv (keine E-Mail-Verifizierung konfiguriert).";
        try {
          await sendMail(adminEmails.join(","), `Neue Registrierung: ${username}`,
            `<p>Ein neuer Nutzer hat sich im mSTaRT Sichtungstrainer registriert:</p>
             <ul><li>Benutzername: ${username}</li><li>E-Mail: ${email}</li><li>Zeitpunkt: ${nowStamp()}</li></ul>
             <p>${statusLine}</p>`);
        } catch (mailErr) {
          console.error("Admin-Benachrichtigung fehlgeschlagen:", mailErr.message);
        }
      }

      if (EMAIL_CONFIGURED) {
        const token = crypto.randomBytes(24).toString("hex");
        newUser.emailVerified = false;
        newUser.verifyToken = token;
        newUser.verifyTokenExpires = Date.now() + 24 * 3600 * 1000;
        users[username] = newUser;
        await saveUsers(users);
        await notifyAdminsOfNewRegistration(true);
        const link = `https://${event.headers.host}/.netlify/functions/verify-email?token=${token}`;
        try {
          await sendMail(email, "Bitte E-Mail-Adresse bestätigen",
            `<p>Hallo ${username},</p><p>bitte bestätige deine E-Mail-Adresse für den mSTaRT Sichtungstrainer, indem du auf den folgenden Link klickst:</p><p><a href="${link}">${link}</a></p><p>Der Link ist 24 Stunden gültig.</p>`);
        } catch (mailErr) {
          // Konto bleibt angelegt, aber unverifiziert -> Nutzer kann "erneut senden" versuchen
          return resp({ ok: true, emailSent: false, mailError: mailErr.message });
        }
        return resp({ ok: true, emailSent: true });
      } else {
        // Kein Mailversand konfiguriert: Verifizierung überspringen, Konto sofort aktiv (wie zuvor)
        newUser.emailVerified = true;
        users[username] = newUser;
        await saveUsers(users);
        return resp({ ok: true, emailSent: false });
      }
    }

    // ---------------- VERIFIZIERUNGS-MAIL ERNEUT SENDEN ----------------
    if (payload.action === "resendVerification") {
      const { username } = payload;
      const u = users[username];
      if (!u) return resp({ ok: false, error: "Benutzer nicht gefunden" });
      if (u.emailVerified !== false) return resp({ ok: false, error: "Diese E-Mail-Adresse ist bereits bestätigt." });
      if (!EMAIL_CONFIGURED) return resp({ ok: false, error: "Mailversand ist serverseitig nicht konfiguriert." });
      const token = crypto.randomBytes(24).toString("hex");
      u.verifyToken = token;
      u.verifyTokenExpires = Date.now() + 24 * 3600 * 1000;
      await saveUsers(users);
      const link = `https://${event.headers.host}/.netlify/functions/verify-email?token=${token}`;
      try {
        await sendMail(u.email, "Bitte E-Mail-Adresse bestätigen",
          `<p>Hallo ${u.username},</p><p>hier ist dein neuer Bestätigungslink:</p><p><a href="${link}">${link}</a></p><p>Der Link ist 24 Stunden gültig.</p>`);
      } catch (mailErr) {
        return resp({ ok: false, error: "Mail konnte nicht gesendet werden: " + mailErr.message });
      }
      return resp({ ok: true });
    }

    // ---------------- ÜBUNGSLEITER-LISTE FÜR ZERTIFIKATE (jedes gültige Token) ----------------
    // Bewusst eine eigene, schwächer abgesicherte Aktion (kein Admin-Token nötig), da auch
    // Übungsleiter (nicht nur Admins) beim Zertifikate-Erstellen den passenden Übungsleiter samt
    // hinterlegter Signatur-ID auswählen können müssen. Es werden NUR unkritische Felder
    // zurückgegeben (kein Passwort-Hash, keine E-Mail, kein Sperrstatus).
    if (payload.action === "listTrainers") {
      const claims = verifyToken(payload.token, SECRET);
      if (!claims) return resp({ ok: false, error: "Sitzung abgelaufen oder ungültig – bitte neu einloggen" });
      const trainers = Object.values(users)
        .filter(u => u.role === "admin" || u.role === "uebungsleiter")
        .map(u => ({ username: u.username, role: u.role, signaturId: u.signaturId || "" }));
      return resp({ ok: true, trainers });
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
          locked: false, createdAt: nowStamp(), lastLogin: null, passwordSalt: salt, passwordHash: hash,
          emailVerified: true, signaturId: p.signaturId || "" }; // vom Admin direkt angelegt -> keine Mail-Verifizierung nötig
        await saveUsers(users);
        return resp({ ok: true });
      }

      if (op === "editUser") {
        const u = users[p.oldUsername];
        if (!u) return resp({ ok: false, error: "Nutzer nicht gefunden" });
        let finalUsername = p.oldUsername;
        if (p.newUsername && p.newUsername !== p.oldUsername) {
          if (users[p.newUsername]) return resp({ ok: false, error: "Dieser Benutzername ist bereits vergeben" });
          delete users[p.oldUsername];
          u.username = p.newUsername;
          users[p.newUsername] = u;
          finalUsername = p.newUsername;
        }
        if (p.email !== undefined) u.email = p.email;
        if (p.role !== undefined) u.role = p.role;
        if (p.locked !== undefined) u.locked = p.locked;
        if (p.signaturId !== undefined) u.signaturId = p.signaturId;
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
