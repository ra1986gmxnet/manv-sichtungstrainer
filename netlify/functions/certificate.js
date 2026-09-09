// ============================================================================
// Diese Funktion erzeugt ein ansprechend gestaltetes PDF-Teilnahmezertifikat
// (über die Bibliothek "pdfkit", rein serverseitig, keine externen Assets nötig)
// und liefert es entweder:
//   - mode "email": als Anhang direkt per E-Mail an den Teilnehmer, oder
//   - mode "download": als Base64-codierte PDF-Datei zurück an den Browser
//     (zum Öffnen/Ausdrucken bzw. Speichern).
//
// Nur Übungsleiter und Admins dürfen Zertifikate erzeugen — dafür wird dasselbe
// signierte Sitzungs-Token geprüft, das auch beim normalen Login ausgestellt wird
// (siehe netlify/functions/auth.js). Ohne gültiges Token wird die Anfrage abgelehnt.
//
// Für den E-Mail-Versand werden dieselben Umgebungsvariablen GMAIL_USER /
// GMAIL_APP_PASSWORD genutzt, die bereits für die Registrierungs-Bestätigung
// eingerichtet wurden (siehe DEPLOYMENT.md). Ohne diese ist nur "Ausdrucken/
// Herunterladen" möglich, kein E-Mail-Versand.
// ============================================================================

const crypto = require("crypto");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function resp(obj) { return { statusCode: 200, headers, body: JSON.stringify(obj) }; }

// ---- Dieselbe Token-Prüfung wie in auth.js (bewusst hier dupliziert, damit diese
// Funktion unabhängig deploybar bleibt und keine gemeinsame Datei benötigt). ----
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

// ---- Kleine Hilfsfunktion: zeichnet einen fünfzackigen Stern (rein vektorbasiert,
// keine Sonderzeichen/Schriftglyphen nötig, damit es mit der Standardschrift
// zuverlässig funktioniert). ----
function drawStar(doc, cx, cy, outerR, innerR, color) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (-90 + i * 36) * (Math.PI / 180);
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  doc.polygon(...points).fill(color);
}

function buildCertificatePdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width, H = doc.page.height;
    const navy = "#123A63", red = "#E2231A", gold = "#C9A227", ink = "#1B2A41", paper = "#FEFCF6";

    // Papierhintergrund (leicht cremefarben statt reinweiß, wirkt hochwertiger)
    doc.rect(0, 0, W, H).fill(paper);

    // Doppelter dekorativer Rahmen
    doc.rect(24, 24, W - 48, H - 48).lineWidth(2.5).stroke(navy);
    doc.rect(33, 33, W - 66, H - 66).lineWidth(1).stroke(gold);

    // Kopfzeile
    doc.fillColor(red).font("Helvetica-Bold").fontSize(11)
      .text("mSTaRT SICHTUNGSTRAINER", 0, 58, { align: "center", width: W });
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(32)
      .text("TEILNAHMEZERTIFIKAT", 0, 82, { align: "center", width: W });
    doc.moveTo(W / 2 - 150, 128).lineTo(W / 2 + 150, 128).lineWidth(1.5).strokeColor(gold).stroke();

    // Haupttext
    doc.fillColor(ink).font("Helvetica").fontSize(13)
      .text("Hiermit wird bestätigt, dass", 0, 155, { align: "center", width: W });
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(27)
      .text(`${data.vorname} ${data.name}`, 0, 180, { align: "center", width: W });
    doc.fillColor(ink).font("Helvetica").fontSize(13)
      .text("erfolgreich an der Übung", 0, 220, { align: "center", width: W });
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(17)
      .text(`"${data.thema}"`, 60, 240, { align: "center", width: W - 120 });
    doc.fillColor(ink).font("Helvetica").fontSize(13)
      .text(`am ${data.uebungstag} im Umfang von ${data.ue} Unterrichtseinheiten teilgenommen hat.`,
        60, 270, { align: "center", width: W - 120 });

    // Dekoratives Siegel (rein vektorbasiert)
    const sealX = W / 2, sealY = H - 145, rOuter = 46, rInner = 39;
    doc.circle(sealX, sealY, rOuter).lineWidth(2.5).strokeColor(gold).stroke();
    doc.circle(sealX, sealY, rInner).lineWidth(1).strokeColor(gold).stroke();
    drawStar(doc, sealX, sealY - 6, 15, 6, gold);
    doc.fillColor(gold).font("Helvetica-Bold").fontSize(8)
      .text("GEPRÜFT & BESTÄTIGT", sealX - rOuter, sealY + 14, { width: rOuter * 2, align: "center" });

    // Fusszeile: Ort/Datum links, Unterschriftslinie rechts
    const bottomY = H - 78;
    doc.fillColor(ink).font("Helvetica").fontSize(12)
      .text(`${data.ort}, ${data.uebungstag}`, 80, bottomY);

    doc.moveTo(W - 320, bottomY + 20).lineTo(W - 80, bottomY + 20).lineWidth(1).strokeColor(ink).stroke();
    doc.font("Helvetica").fontSize(10)
      .text(`Übungsleiter/in: ${data.uebungsleiter}`, W - 320, bottomY + 26, { width: 240, align: "center" });

    doc.end();
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return resp({ ok: false, error: "Nur POST-Anfragen erlaubt" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return resp({ ok: false, error: "Ungueltiger Request-Body" }); }

  const SECRET = process.env.SESSION_SECRET;
  if (!SECRET) {
    return resp({ ok: false, error: "Server nicht konfiguriert: SESSION_SECRET fehlt in den Netlify-Umgebungsvariablen." });
  }
  const auth = verifyToken(payload.token, SECRET);
  if (!auth || (auth.role !== "admin" && auth.role !== "uebungsleiter")) {
    return resp({ ok: false, error: "Nicht angemeldet oder keine Berechtigung (nur Uebungsleiter/Admin)." });
  }

  const required = ["name", "vorname", "uebungstag", "uebungsleiter", "thema", "ue", "ort"];
  for (const f of required) {
    if (!payload[f] || !String(payload[f]).trim()) {
      return resp({ ok: false, error: `Feld "${f}" fehlt oder ist leer.` });
    }
  }

  let pdfBuffer;
  try {
    pdfBuffer = await buildCertificatePdfBuffer(payload);
  } catch (e) {
    return resp({ ok: false, error: "Fehler bei der PDF-Erstellung: " + e.message });
  }

  const filenameSafe = `Zertifikat_${payload.vorname}_${payload.name}`.replace(/[^a-zA-Z0-9_\-]/g, "_") + ".pdf";

  if (payload.mode === "email") {
    if (!payload.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) {
      return resp({ ok: false, error: "Bitte eine gueltige E-Mail-Adresse des Teilnehmers angeben." });
    }
    const t = getTransporter();
    if (!t) {
      return resp({ ok: false, error: "E-Mail-Versand ist nicht konfiguriert (GMAIL_USER/GMAIL_APP_PASSWORD fehlen)." });
    }
    try {
      await t.sendMail({
        from: `"mSTaRT Sichtungstrainer" <${process.env.GMAIL_USER}>`,
        to: payload.email,
        subject: `Dein Teilnahmezertifikat: ${payload.thema}`,
        html: `<p>Hallo ${payload.vorname},</p><p>anbei erhaeltst du dein Teilnahmezertifikat fuer die Uebung "${payload.thema}" am ${payload.uebungstag}.</p><p>Vielen Dank fuer deine Teilnahme!</p>`,
        attachments: [{ filename: filenameSafe, content: pdfBuffer, contentType: "application/pdf" }]
      });
    } catch (mailErr) {
      return resp({ ok: false, error: "Fehler beim E-Mail-Versand: " + mailErr.message });
    }
    return resp({ ok: true, emailSent: true });
  }

  // mode === "download" (Standard): PDF als Base64 zurückgeben
  return resp({ ok: true, pdfBase64: pdfBuffer.toString("base64"), filename: filenameSafe });
};
