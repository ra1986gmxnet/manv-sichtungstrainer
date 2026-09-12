// ============================================================================
// Erzeugt den Debriefing-Bericht einer Übung als echtes, formatiertes PDF
// (Einsatzdaten, chronologischer Verlauf, Fazit) und verschickt es als Anhang
// an eine oder mehrere vom Übungsleiter/Admin angegebene E-Mail-Adressen.
//
// Zugriff nur mit gültigem Sitzungs-Token einer Rolle "uebungsleiter" oder
// "admin" (dasselbe Token-Format wie in auth.js/certificate.js).
//
// Benötigt GMAIL_USER, GMAIL_APP_PASSWORD (E-Mail-Versand) sowie SESSION_SECRET
// (Token-Prüfung). Siehe DEPLOYMENT.md.
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

// Trennt eine frei eingegebene Liste von E-Mail-Adressen (Komma, Semikolon,
// Zeilenumbruch oder Leerzeichen getrennt) und behält nur plausibel aussehende.
function parseEmailList(raw) {
  return (raw || "")
    .split(/[,;\s\n]+/)
    .map(s => s.trim())
    .filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

function buildDebriefingPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: 50 });
      const chunks = [];
      doc.on("data", c => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const navy = "#123A63", muted = "#5C6B84";
      const pageBottom = doc.page.height - 50;

      function ensureSpace(needed) {
        if (doc.y + needed > pageBottom) doc.addPage();
      }
      function heading(text) {
        ensureSpace(30);
        doc.moveDown(0.5).fillColor(navy).font("Helvetica-Bold").fontSize(15).text(text);
        doc.moveTo(50, doc.y + 2).lineTo(doc.page.width - 50, doc.y + 2).strokeColor("#D9C27A").lineWidth(1).stroke();
        doc.moveDown(0.5);
      }
      function kvRow(label, value) {
        if (!value) return;
        ensureSpace(18);
        doc.fillColor(muted).font("Helvetica-Bold").fontSize(9).text(label, { continued: false });
        doc.fillColor("#1B2A41").font("Helvetica").fontSize(11).text(String(value));
        doc.moveDown(0.3);
      }

      doc.fillColor(navy).font("Helvetica-Bold").fontSize(22).text(`Debriefing: ${data.exName}`);
      doc.fillColor(muted).font("Helvetica").fontSize(10)
        .text(`Szenario: ${data.scenario || "-"}${data.meta ? " · " + data.meta : ""}`);
      doc.text(`Status: ${data.status || "-"} · Exportiert: ${new Date().toLocaleString("de-DE")}`);
      doc.moveDown(0.5);

      if (data.briefingFields && data.briefingFields.length) {
        heading("Einsatzdaten");
        data.briefingFields.forEach(([k, v]) => kvRow(k, v));
      }

      heading("Chronologischer Verlauf");
      if (!data.timeline || !data.timeline.length) {
        doc.fillColor("#888").font("Helvetica-Oblique").fontSize(10).text("Keine Ereignisse erfasst");
      } else {
        const colTimeW = 130, colEventW = doc.page.width - 100 - colTimeW;
        data.timeline.forEach(entry => {
          ensureSpace(20);
          const y = doc.y;
          doc.fillColor(muted).font("Helvetica").fontSize(9).text(entry.time || "", 50, y, { width: colTimeW });
          doc.fillColor("#1B2A41").font("Helvetica").fontSize(10).text(entry.text || "", 50 + colTimeW, y, { width: colEventW });
          doc.moveDown(0.35);
        });
      }

      heading("Fazit");
      const s = data.stats || {};
      kvRow("Gesamtzeit der Übung", s.gesamtzeitText);
      kvRow("Ø Sichtungszeit pro Patient", s.avgDurationText);
      kvRow("Gesichtete Patienten gesamt", s.totalGesichtet);
      kvRow("Richtig gesichtet", s.correct);
      kvRow("Falsch gesichtet", s.wrong);

      doc.end();
    } catch (e) { reject(e); }
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return resp({ ok: false, error: "Nur POST erlaubt" });

  const SECRET = process.env.SESSION_SECRET;
  if (!SECRET) {
    return resp({ ok: false, error: "Server nicht konfiguriert: SESSION_SECRET fehlt in den Netlify-Umgebungsvariablen." });
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch (e) { return resp({ ok: false, error: "Ungültiger Request-Body" }); }

  const tokenData = verifyToken(payload.token, SECRET);
  if (!tokenData || (tokenData.role !== "admin" && tokenData.role !== "uebungsleiter")) {
    return resp({ ok: false, error: "Nicht angemeldet oder keine Berechtigung (nur Übungsleiter/Admin)." });
  }

  if (!payload.exName) return resp({ ok: false, error: "Fehlende Übungsdaten" });

  const emails = parseEmailList(payload.emails);
  if (!emails.length) {
    return resp({ ok: false, error: "Bitte mindestens eine gültige E-Mail-Adresse angeben." });
  }
  if (!EMAIL_CONFIGURED) {
    return resp({ ok: false, error: "Mailversand ist serverseitig nicht konfiguriert (GMAIL_USER/GMAIL_APP_PASSWORD fehlen)." });
  }

  let pdfBuffer;
  try {
    pdfBuffer = await buildDebriefingPdf(payload);
  } catch (e) {
    return resp({ ok: false, error: "Fehler bei der PDF-Erstellung: " + e.message });
  }

  try {
    const t = getTransporter();
    await t.sendMail({
      from: `"mSTaRT Sichtungstrainer" <${process.env.GMAIL_USER}>`,
      to: emails.join(","),
      subject: `Debriefing-Bericht: ${payload.exName}`,
      html: `<p>Anbei der Debriefing-Bericht zur Übung "${payload.exName}".</p>`,
      attachments: [{ filename: `Debriefing_${payload.exName}.pdf`.replace(/[^a-zA-Z0-9_\-.]/g, "_"), content: pdfBuffer, contentType: "application/pdf" }]
    });
    return resp({ ok: true, sentTo: emails });
  } catch (e) {
    return resp({ ok: false, error: "Fehler beim E-Mail-Versand: " + e.message });
  }
};
