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
// Für das Siegel und die Unterschrift werden mitgelieferte Bilder genutzt
// (netlify/functions/images/Siegel.png bzw. Unterschrift.jpg). Fehlt eine Datei
// ausnahmsweise, greift jeweils ein einfacher Text-Fallback. WICHTIG: der
// gesamte Bilderordner muss zusammen mit netlify.toml (included_files) deployt
// werden, sonst schlägt die PDF-Erstellung fehl.
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

// ---- Datum als "TT. MMMM JJJJ" (z.B. "05. September 2026") ----
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
  return `${tag}. ${MONATE_DE[d.getMonth()]} ${d.getFullYear()}`;
}

// ---- Siegel: eingebettetes, vom Nutzer geliefertes Bild (kreisförmig zugeschnitten) ----
function drawSealImage(doc, cx, cy, radius) {
  const imgPath = path.join(__dirname, "images", "Siegel.png");
  doc.save();
  doc.circle(cx, cy, radius).clip();
  doc.image(imgPath, cx - radius, cy - radius, { width: radius * 2, height: radius * 2 });
  doc.restore();
  // Feiner Kontrastring um das Siegel, damit es sich von der cremefarbenen Fläche abhebt
  doc.circle(cx, cy, radius).lineWidth(1).strokeColor("#B8912F").stroke();
}

// ---- Fallback: einfache Vektor-Variante, falls die Bilddatei einmal fehlen sollte ----
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
function drawSealFallback(doc, cx, cy) {
  const navy = "#123A63", gold = "#B8912F", paper = "#FEFCF6";
  doc.circle(cx, cy, 64).lineWidth(3.5).strokeColor(navy).stroke();
  doc.circle(cx, cy, 58).fill(paper);
  doc.circle(cx, cy, 58).lineWidth(1).strokeColor(gold).stroke();
  drawShield(doc, cx, cy, 1.4, navy);
  doc.fillColor(navy).font("Helvetica-Bold").fontSize(7)
    .text("GEPRÜFT", cx - 40, cy + 24, { width: 80, align: "center" });
}
function drawSeal(doc, cx, cy, radius) {
  try { drawSealImage(doc, cx, cy, radius); }
  catch (e) { drawSealFallback(doc, cx, cy); }
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

    // Papierhintergrund (leicht cremefarben statt reinweiß, wirkt hochwertiger)
    doc.rect(0, 0, W, H).fill(paper);

    // Doppelter dekorativer Rahmen
    doc.rect(28, 28, W - 56, H - 56).lineWidth(2.5).stroke(navy);
    doc.rect(37, 37, W - 74, H - 74).lineWidth(1).stroke(gold);

    // Kopfzeile
    doc.fillColor(red).font("Helvetica-Bold").fontSize(12)
      .text("SICHTUNGSTRAINER", 0, 62, { align: "center", width: W, characterSpacing: 1.2 });
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(33)
      .text("TEILNAHMEZERTIFIKAT", 0, 88, { align: "center", width: W, characterSpacing: 1 });
    doc.moveTo(W / 2 - 140, 138).lineTo(W / 2 + 140, 138).lineWidth(1.5).strokeColor(gold).stroke();

    // Haupttext (fließend, damit unterschiedlich lange Angaben immer sauber umbrechen)
    const textW = 480, textX = (W - textW) / 2;
    doc.fillColor(ink).font("Helvetica").fontSize(14)
      .text("Hiermit wird bestätigt, dass", 0, 176, { align: "center", width: W });
    doc.fillColor(navy).font("Helvetica-Bold").fontSize(30)
      .text(`${data.vorname} ${data.name}`, 0, 206, { align: "center", width: W });

    const datumLang = formatDateLangDE(data.uebungstag);
    const schema = data.schema || "mSTaRT";
    const satz = `erfolgreich an einer ManV-Sichtungsübung nach dem Sichtungsschema ${schema} am ${datumLang} im Umfang von ${data.ue} Unterrichtseinheiten teilgenommen hat.`;
    doc.fillColor(ink).font("Helvetica").fontSize(14.5).lineGap(9)
      .text(satz, textX, 256, { width: textW, align: "center" });

    // Siegel: ca. 1/3 kleiner als zuvor (Radius 120 -> 80)
    drawSeal(doc, W / 2, 470, 80);

    // Fusszeile: Ort/Datum links, Unterschrift rechts (zwei Spalten)
    const bottomY = H - 178;
    const colW = 210, leftX = 70, rightX = W - 70 - colW;

    doc.fillColor(ink).font("Helvetica").fontSize(12)
      .text(`${data.ort}, ${datumLang}`, leftX, bottomY, { width: colW, align: "center" });
    doc.moveTo(leftX, bottomY + 26).lineTo(leftX + colW, bottomY + 26).lineWidth(0.75).strokeColor("#888").stroke();
    doc.fillColor("#5C6B84").font("Helvetica").fontSize(8)
      .text("Ort, Datum", leftX, bottomY + 30, { width: colW, align: "center" });

    // Eingescanntes Unterschriftsbild oberhalb der Linie (Seitenverhältnis beibehalten)
    try {
      const sigPath = path.join(__dirname, "images", "Unterschrift.jpg");
      const sigW = 150, sigH = sigW * (562 / 1370); // Original-Seitenverhältnis der Datei
      doc.image(sigPath, rightX + (colW - sigW) / 2, bottomY - sigH + 4, { width: sigW, height: sigH });
    } catch (e) {
      doc.fillColor(navy).font("Helvetica-Oblique").fontSize(15)
        .text("M. Dommes", rightX, bottomY - 2, { width: colW, align: "center" });
    }
    doc.moveTo(rightX, bottomY + 26).lineTo(rightX + colW, bottomY + 26).lineWidth(0.75).strokeColor("#888").stroke();
    doc.fillColor("#5C6B84").font("Helvetica").fontSize(8)
      .text(`Übungsleiter/in: ${data.uebungsleiter}`, rightX, bottomY + 30, { width: colW, align: "center" });

    doc.fillColor("#aaaaaa").font("Helvetica").fontSize(7)
      .text(`Ausgestellt am ${new Date().toLocaleDateString("de-DE")}`, 0, H - 58, { align: "center", width: W });

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
