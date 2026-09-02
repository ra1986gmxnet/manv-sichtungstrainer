// Diese Funktion läuft NICHT im Browser, sondern serverseitig bei Netlify.
// Sie hält den Anthropic-API-Key geheim (aus einer Umgebungsvariable) und leitet
// die Anfrage der App an die echte Anthropic-API weiter. Der Key ist dadurch nie
// im Browser/Quelltext der Webseite sichtbar.
//
// Einrichtung: siehe DEPLOYMENT.md, Schritt 4.
// Die Umgebungsvariable ANTHROPIC_API_KEY muss in den Netlify-Projekteinstellungen
// unter "Site configuration" -> "Environment variables" gesetzt werden.

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  // Preflight-Anfragen des Browsers (CORS) direkt beantworten
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: { message: "Nur POST-Anfragen erlaubt." } })
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: {
          message:
            "ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt. Bitte in den Netlify-Umgebungsvariablen hinterlegen (siehe DEPLOYMENT.md, Schritt 4)."
        }
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: { message: "Ungültiger Request-Body (kein gültiges JSON)." } })
    };
  }

  if (!payload.messages) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: { message: 'Feld "messages" fehlt im Request.' } })
    };
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        // Modellname für die ECHTE Anthropic-API (mit eigenem Key) — nicht identisch
        // mit den Modell-Kurznamen aus der Claude-Chat-Oberfläche.
        model: "claude-sonnet-5",
        max_tokens: Math.min(payload.max_tokens || 1000, 2000),
        temperature: payload.temperature !== undefined ? payload.temperature : 1,
        messages: payload.messages
      })
    });

    const data = await resp.json();
    return {
      statusCode: resp.status,
      headers,
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: { message: "Fehler beim Aufruf der Anthropic API: " + e.message } })
    };
  }
};
