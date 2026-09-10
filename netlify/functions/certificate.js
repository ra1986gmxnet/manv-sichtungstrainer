// ============================================================================
// Diese Funktion erzeugt ein ansprechend gestaltetes PDF-Teilnahmezertifikat
// (Hochformat, über die Bibliothek "pdfkit", rein serverseitig) und liefert es
// entweder:
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
//
// Für die handschriftlich wirkende Unterschrift wird eine mitgelieferte
// Schreibschrift-Schriftart genutzt (netlify/functions/fonts/Signature.ttf,
// SIL Open Font License). WICHTIG: diese Datei UND netlify.toml
// (included_files) müssen zusammen deployt werden, sonst schlägt die
// PDF-Erstellung fehl.
// ============================================================================

const crypto = require("crypto");
const path = require("path");
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

// ---- Datum als TT.MMMM.JJJJ (z.B. "05.September.2026") ----
const MONATE_DE = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
function formatDateLangDE(input) {
  if (!input) return "";
  let d = null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(input);
  if (iso) d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  else if (de) d = new Date(Number(de[3]), Number(de[2]) - 1, Number(de[1]));
  if (!d || isNaN(d.getTime())) return input; // unbekanntes Format -> unverändert übernehmen
  const tag = String(d.getDate()).padStart(2, "0");
  return `${tag}.${MONATE_DE[d.getMonth()]}.${d.getFullYear()}`;
}

// ---- Vektorbasierte Hilfsformen (keine Sonderzeichen/Bild-Assets nötig) ----
function polygonPoints(doc, points, color) { doc.polygon(...points).fill(color); }

function drawShield(doc, cx, cy, scale, color) {
  const pts = [
    [cx - 13*scale, cy - 15*scale], [cx + 13*scale, cy - 15*scale],
    [cx + 15*scale, cy - 4*scale],  [cx + 10*scale, cy + 8*scale],
    [cx, cy + 19*scale],
    [cx - 10*scale, cy + 8*scale],  [cx - 15*scale, cy - 4*scale]
  ];
  polygonPoints(doc, pts, color);
}

function drawBeadedRing(doc, cx, cy, radius, count, beadR, color) {
  for (let i = 0; i < count; i++) {
    const angle = (i * 360 / count) * Math.PI / 180;
    doc.circle(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), beadR).fill(color);
  }
}

// Ein kleines, stilisiertes Lorbeerblatt (Ellipse), an Position (x,y) um angleDeg gedreht
function drawLeaf(doc, x, y, angleDeg, len, wid, color) {
  doc.save();
  doc.translate(x, y);
  doc.rotate(angleDeg, { origin: [0, 0] });
  doc.ellipse(0, 0, len / 2, wid / 2).fill(color);
  doc.restore();
}
// Lorbeerzweig: eine Reihe kleiner Blätter entlang eines Bogens, symmetrisch links/rechts
function drawLaurelWreath(doc, cx, cy, radius, color) {
  const leafCount = 7;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < leafCount; i++) {
      const t = i / (leafCount - 1);
      const angleDeg = side === -1 ? (200 - t * 100) : (-20 + t * 100); // links unten->oben, rechts unten->oben
      const rad = angleDeg * Math.PI / 180;
      const lr = radius * (0.98 - t * 0.12);
      const x = cx + lr * Math.cos(rad);
      const y = cy + lr * Math.sin(rad);
      const leafSize = 13 - t * 5;
      drawLeaf(doc, x, y, angleDeg + 90 * side, leafSize, leafSize * 0.45, color);
    }
  }
}

// Ribbon-Enden unterhalb des Siegels (klassische Medaillen-Optik)
function drawRibbonTails(doc, cx, topY, color) {
  const w = 15, len = 46, spread = 9;
  [-1, 1].forEach((side) => {
    doc.save();
    doc.translate(cx + side * spread, topY);
    doc.rotate(side * 10, { origin: [0, 0] });
    const pts = [
      [-w / 2, 0], [w / 2, 0], [w / 2, len], [0, len - 12], [-w / 2, len]
    ];
    doc.polygon(...pts).fill(color);
    doc.restore();
  });
}

function drawSeal(doc, cx, cy) {
  const navy = "#123A63", gold = "#B8912F", goldLight = "#D9C27A", paper = "#FEFCF6", red = "#8f1c17";

  drawRibbonTails(doc, cx, cy + 50, red);

  // Ringe (außen nach innen)
  doc.circle(cx, cy, 64).lineWidth(1).strokeColor(gold).stroke();
  drawBeadedRing(doc, cx, cy, 58, 40, 1.3, gold);
  doc.circle(cx, cy, 52).lineWidth(3.5).strokeColor(navy).stroke();
  doc.circle(cx, cy, 46).lineWidth(1).strokeColor(gold).stroke();
  doc.circle(cx, cy, 44).fill(paper);
  doc.circle(cx, cy, 44).lineWidth(0.75).strokeColor(goldLight).stroke();

  // Lorbeerkranz innerhalb des Rings
  drawLaurelWreath(doc, cx, cy, 40, gold);

  // Wappen/Schild in der Mitte
  drawShield(doc, cx, cy - 10, 1.15, navy);
  drawShield(doc, cx, cy - 10, 0.8, gold);

  // Zweizeiliger Schriftzug unten im Ring
  doc.fillColor(navy).font("Helvetica-Bold").fontSize(6.5)
    .text("GEPRÜFT", cx - 34, cy + 14, { width: 68, align: "center", characterSpacing: 0.5 });
  doc.font("Helvetica").fontSize(5.5).fillColor(navy)
    .text("TEILNAHME BESTÄTIGT", cx - 34, cy + 23, { width: 68, align: "center" });
}

function buildCertificatePdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: 0 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width, H = doc.page.height;
    const navy = "#123A63", red = "#E2231A", gold = "#C9A227", ink = "#1B2A41", paper = "#FEFCF6";

    try {
      doc.registerFont("Signature", path.join(__dirname, "fonts", "Signature.ttf"));
    } catch (e) { /* Signatur-Schrift optional: bei Fehler wird unten ein Fallback genutzt */ }

    // Papierhintergrund (leicht cremefarben statt reinweiß, wirkt hochwertiger)
    doc.rect(0, 0, W, H).fill(paper);

    // Doppelter dekorativer Rahmen
    doc.rect(28, 28, W - 56, H - 56).lineWidth(2.5).stroke(navy);
    doc.rect(37, 37, W - 74, H - 74).lineWidth(1).stroke(gold);

    // Kopfzeile
    doc.fillColor(red).font("Helvetica-Bold").fontSize(11)
      .text("mSTaRT SICHTUNGSTRAINER", 0, 70, { align: "center", width: W, characterSpacing: 1 });
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(29)
      .text("TEILNAHMEZERTIFIKAT", 0, 94, { align: "center", width: W, characterSpacing: 1 });
    doc.moveTo(W / 2 - 130, 138).lineTo(W / 2 + 130, 138).lineWidth(1.5).strokeColor(gold).stroke();

    // Haupttext (fließend, damit unterschiedlich lange Angaben immer sauber umbrechen)
    const textW = 460, textX = (W - textW) / 2;
    doc.fillColor(ink).font("Helvetica").fontSize(13)
      .text("Hiermit wird bestätigt, dass", 0, 168, { align: "center", width: W });
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(26)
      .text(`${data.vorname} ${data.name}`, 0, 194, { align: "center", width: W });

    const datumLang = formatDateLangDE(data.uebungstag);
    const satz = `erfolgreich an einer ManV-Sichtungsübung nach dem mSTaRT Sichtungsschema am ${datumLang} im Umfang von ${data.ue} Unterrichtseinheiten teilgenommen hat.`;
    doc.fillColor(ink).font("Helvetica").fontSize(13).lineGap(6)
      .text(satz, textX, 236, { width: textW, align: "center" });

    // Siegel, zentriert im unteren Drittel
    drawSeal(doc, W / 2, 500);

    // Fusszeile: Ort/Datum links, Unterschrift rechts (zwei Spalten)
    const bottomY = H - 150;
    const colW = 210, leftX = 70, rightX = W - 70 - colW;

    doc.fillColor(ink).font("Helvetica").fontSize(12)
      .text(`${data.ort}, ${datumLang}`, leftX, bottomY, { width: colW, align: "center" });
    doc.moveTo(leftX, bottomY + 26).lineTo(leftX + colW, bottomY + 26).lineWidth(0.75).strokeColor("#888").stroke();
    doc.fillColor("#5C6B84").font("Helvetica").fontSize(8)
      .text("Ort, Datum", leftX, bottomY + 30, { width: colW, align: "center" });

    // Handschriftlich wirkende Unterschrift oberhalb der Linie
    try {
      doc.fillColor(navy).font("Signature").fontSize(26)
        .text("M. Dommes", rightX, bottomY - 20, { width: colW, align: "center" });
    } catch (e) {
      doc.fillColor(navy).font("Helvetica-Oblique").fontSize(15)
        .text("M. Dommes", rightX, bottomY - 2, { width: colW, align: "center" });
    }
    doc.moveTo(rightX, bottomY + 26).lineTo(rightX + colW, bottomY + 26).lineWidth(0.75).strokeColor("#888").stroke();
    doc.fillColor("#5C6B84").font("Helvetica").fontSize(8)
      .text(`Übungsleiter/in: ${data.uebungsleiter}`, rightX, bottomY + 30, { width: colW, align: "center" });

    doc.fillColor("#aaaaaa").font("Helvetica").fontSize(7)
      .text(`Ausgestellt am ${new Date().toLocaleDateString("de-DE")}`, 0, H - 44, { align: "center", width: W });

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
        html: `<p>Hallo ${payload.vorname},</p><p>anbei erhaeltst du dein Teilnahmezertifikat fuer die Uebung "${payload.thema}" am ${formatDateLangDE(payload.uebungstag)}.</p><p>Vielen Dank fuer deine Teilnahme!</p>`,
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
