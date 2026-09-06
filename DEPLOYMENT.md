# mSTaRT Sichtungstrainer – online stellen (Schritt für Schritt)

Diese Anleitung bringt dein System mit **kostenlosem Hosting (Netlify)** und
**kostenloser Datenbank (Firebase Firestore)** online. Die einzigen Kosten,
die entstehen können, sind die tatsächliche Nutzung der Anthropic-API für die
KI-Patientengenerierung (nutzungsabhängig, bei diesem Umfang typischerweise
nur Cent-Beträge) sowie optional eine eigene Domain (~10 €/Jahr, falls
gewünscht — die kostenlose Netlify-Subdomain reicht für den Betrieb völlig aus).

Benötigte Dateien (alle in diesem Ordner):
- `index.html` – die eigentliche Anwendung
- `netlify.toml` – Konfiguration für Netlify
- `netlify/functions/generate-patient.js` – sichere Server-Funktion für die KI-Generierung
- `firestore.rules` – Sicherheitsregeln für die Datenbank

---

## Schritt 1: GitHub-Repository anlegen

1. Falls noch nicht vorhanden: kostenloses Konto auf [github.com](https://github.com) anlegen.
2. Neues, privates oder öffentliches Repository erstellen (z.B. `manv-sichtungstrainer`).
3. Alle Dateien aus diesem Ordner **mit der gleichen Ordnerstruktur** hochladen:
   ```
   /index.html
   /netlify.toml
   /netlify/functions/generate-patient.js
   /firestore.rules
   ```
   (Am einfachsten über "Add file" -> "Upload files" im Browser, oder per Git.)

---

## Schritt 2: Firebase-Projekt anlegen (kostenlose Datenbank)

1. Auf [console.firebase.google.com](https://console.firebase.google.com) mit einem
   Google-Konto anmelden.
2. "Projekt hinzufügen" -> Namen vergeben (z.B. `manv-sichtungstrainer`) -> Google
   Analytics kann deaktiviert werden -> Projekt erstellen.
3. Im Projekt links auf "Build" -> "Firestore Database" -> "Datenbank erstellen".
   - Standort auswählen (z.B. `eur3 (europe-west)` für Europa).
   - Im Modus-Dialog: **"Testmodus starten"** wählen (wir ersetzen die Regeln gleich
     im nächsten Schritt durch die mitgelieferten `firestore.rules`).
4. Im Tab "Regeln" (oben in der Firestore-Ansicht) den kompletten Inhalt der
   Datei `firestore.rules` einfügen (ersetzt den vorhandenen Text) und auf
   "Veröffentlichen" klicken.
5. Zurück zur Projektübersicht (Zahnrad oben links -> "Projekteinstellungen").
   Unter "Deine Apps" auf das Web-Symbol `</>` klicken, um eine neue Web-App zu
   registrieren (Spitzname beliebig, Firebase Hosting NICHT aktivieren — wir
   nutzen Netlify).
6. Firebase zeigt dir jetzt ein Code-Snippet mit einem Objekt `firebaseConfig`,
   das z.B. so aussieht:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "manv-sichtungstrainer.firebaseapp.com",
     projectId: "manv-sichtungstrainer",
     storageBucket: "manv-sichtungstrainer.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abc123"
   };
   ```
7. Öffne `index.html` (im Editor oder direkt auf GitHub) und ersetze am Anfang
   des `<script>`-Bereichs den Platzhalter-Block `const firebaseConfig = {...}`
   durch **genau dieses Objekt** aus deinem eigenen Firebase-Projekt. Speichern
   und die Änderung zu GitHub hochladen/committen.

---

## Schritt 3: Anthropic-API-Key besorgen

1. Auf [console.anthropic.com](https://console.anthropic.com) ein Konto anlegen
   (getrennt von einem eventuellen claude.ai-Konto).
2. Unter "API Keys" einen neuen Key erstellen und **sicher notieren** (wird nur
   einmal angezeigt).
3. Ein kleines Startguthaben einrichten/aufladen (Anthropic verlangt i.d.R.
   eine minimale Zahlungsmethode für die API-Nutzung; die eigentlichen Kosten
   pro generiertem Patienten liegen im Bereich von Bruchteilen eines Cents).

---

## Schritt 4: Netlify-Konto anlegen und Projekt verbinden

1. Auf [app.netlify.com](https://app.netlify.com) kostenloses Konto anlegen
   (am einfachsten direkt mit dem GitHub-Konto anmelden).
2. "Add new site" -> "Import an existing project" -> GitHub auswählen -> das
   eben erstellte Repository auswählen.
3. Build-Einstellungen: Build-Command **leer lassen**, Publish-Directory auf
   `.` (Punkt) stehen lassen — das übernimmt `netlify.toml` bereits automatisch.
4. Vor dem ersten Deploy (oder danach unter "Site configuration" ->
   "Environment variables") eine neue Umgebungsvariable anlegen:
   - Key: `ANTHROPIC_API_KEY`
   - Value: der in Schritt 3 erzeugte API-Key
5. "Deploy site" klicken. Nach ein bis zwei Minuten ist die Seite unter einer
   Adresse wie `https://zufälliger-name-12345.netlify.app` erreichbar.
   (Der Name lässt sich unter "Site configuration" -> "Site details" ändern,
   z.B. in `https://manv-sichtungstrainer.netlify.app`.)

---

## Schritt 5: Testen

1. Die Netlify-URL im Browser öffnen.
2. Mit **Martin / 1234** anmelden (Passwort danach im Admin-Bereich ändern!).
3. Im Admin-Bereich unter "Patientendatenbank" testweise 1 Patienten per KI
   generieren, um zu prüfen, ob Firebase UND die Netlify-Funktion korrekt
   eingerichtet sind.
4. Falls ein Fehler erscheint: der rote Fehlerkasten zeigt an, ob es an
   Firestore (Speicherfehler) oder an der API-Funktion liegt (Fehlertext
   enthält dann meist "ANTHROPIC_API_KEY" oder einen HTTP-Status).

---

## Schritt 6 (optional): Eigene Domain verbinden

Die kostenlose `.netlify.app`-Adresse funktioniert dauerhaft und kostenlos —
dieser Schritt ist nur nötig, wenn du eine eigene Domain wie
`www.meine-feuerwehr-uebung.de` möchtest.

1. Domain bei einem Registrar kaufen (z.B. Namecheap, INWX, IONOS — ca. 8–15 €/Jahr,
   **echte komplett kostenlose Domains sind unseriös/unzuverlässig und werden
   nicht empfohlen**).
2. In Netlify: "Site configuration" -> "Domain management" -> "Add a domain"
   -> die gekaufte Domain eintragen.
3. Netlify zeigt dir die nötigen DNS-Einträge (meist ein CNAME oder mehrere
   A-Records). Diese beim Registrar in der DNS-Verwaltung eintragen.
4. Nach einiger Zeit (Minuten bis Stunden) ist die Seite unter der eigenen
   Domain erreichbar, inklusive kostenlosem SSL-Zertifikat (Netlify richtet
   das automatisch ein).

---

## Wichtige Sicherheitshinweise für den Praxisbetrieb

**Zum Quelltext:** Bei JEDER Webseite (nicht nur dieser) kann jeder Besucher über
"Seitenquelltext anzeigen" bzw. die Entwicklertools des Browsers den kompletten
HTML/JavaScript-Code einsehen — das ist eine technische Grundeigenschaft des Web
und lässt sich bei einer Anwendung, die im Browser läuft, durch nichts (auch keine
Verschleierung/Minifizierung) wirklich verhindern. Wichtig zu wissen: Die
Firebase-Konfiguration (`apiKey`, `projectId` etc.) ist dabei **kein Geheimnis** —
Firebase ist bewusst so konzipiert, dass diese Werte öffentlich sichtbar sein
dürfen. Die eigentliche Absicherung erfolgt über die Firestore-Sicherheitsregeln
(`firestore.rules`) und — für die Nutzerdaten — über die Server-Funktion
`netlify/functions/auth.js`, nicht durch Geheimhaltung der Konfiguration.

- **Passwörter werden serverseitig gehasht** (Node "crypto", scrypt + individuelles
  Salt) und nie im Klartext gespeichert. Der Browser bekommt nach dem Login nur ein
  signiertes, 12 Stunden gültiges Sitzungs-Token zurück — nie ein Passwort oder
  einen Passwort-Hash.
- Solange die Server-Funktion noch NICHT eingerichtet ist (siehe unten), fällt die
  App automatisch auf eine einfachere, clientseitige Absicherung zurück (gesalzener
  SHA-256-Hash), damit Login/Registrierung trotzdem sofort funktionieren. Das ist
  bereits deutlich sicherer als Klartext, aber noch nicht die volle Absicherung.
- Ändere das Admin-Passwort (Martin/1234) direkt nach dem ersten Login.
- Behalte deinen Anthropic-API-Key geheim und lade ihn niemals in ein
  öffentliches GitHub-Repository hoch (er gehört ausschließlich in die
  Netlify-Umgebungsvariable, nicht in den Code).

---

## Optional (empfohlen): Maximale Sicherheit für Benutzerdaten aktivieren

Mit diesem zusätzlichen Schritt ist das Dokument mit den Nutzerdaten (Benutzernamen,
E-Mails, Passwort-Hashes) für JEDEN direkten Zugriff aus dem Browser komplett
gesperrt — auch mit der öffentlich sichtbaren Firebase-Konfiguration kommt dann
niemand mehr direkt an diese Daten heran. Nur noch die Server-Funktion (mit einem
privaten Service-Account-Schlüssel, der Firestore-Regeln grundsätzlich umgeht) darf
sie lesen/schreiben. Login, Registrierung und alle Admin-Nutzeraktionen laufen dann
ausschließlich über diese Funktion.

**Schritt 1: Service-Account-Schlüssel erzeugen**
1. In der Firebase-Konsole dein Projekt öffnen → Zahnrad oben links →
   "Projekteinstellungen" → Tab "Dienstkonten" ("Service accounts").
2. "Neuen privaten Schlüssel generieren" klicken → eine JSON-Datei wird
   heruntergeladen. **Diese Datei ist hochsensibel — niemals ins Git-Repository
   einchecken, niemals weitergeben.**

**Schritt 2: Umgebungsvariablen in Netlify setzen**
1. Netlify-Dashboard → dein Projekt → "Site configuration" → "Environment variables".
2. Neue Variable `FIREBASE_SERVICE_ACCOUNT_JSON` anlegen. Als Wert den **kompletten
   Inhalt** der heruntergeladenen JSON-Datei einfügen (die ganze Datei, so wie sie
   ist, als eine einzige Zeile/einen Wert).
3. Neue Variable `SESSION_SECRET` anlegen. Als Wert eine lange, zufällige
   Zeichenkette eintragen (z.B. mit einem Passwort-Generator 40+ Zeichen erzeugen).
   Dieser Wert signiert die Sitzungs-Tokens — er darf niemandem bekannt sein.
4. "Save" klicken.

**Schritt 3: Neu deployen und testen**
1. Einen neuen Deploy anstoßen (z.B. "Trigger deploy" → "Deploy site" in Netlify,
   oder einen leeren Commit ins Repo pushen), damit die Funktion die neuen
   Umgebungsvariablen lädt.
2. Warten, bis der Deploy fertig ist, dann die Live-Seite öffnen und einmal ganz
   normal einloggen (z.B. als Martin). Wenn das funktioniert, läuft der Login jetzt
   bereits über die sichere Server-Funktion (die alten, einfacheren Firestore-Regeln
   erlauben das parallel weiterhin, das ist gewollt für diesen Zwischenschritt).
3. Falls eine Fehlermeldung wie "Server nicht konfiguriert" erscheint: die
   Umgebungsvariablen wurden noch nicht übernommen — Schritt 2 prüfen und erneut
   deployen.

**Schritt 4: Firestore-Regeln verschärfen (erst NACHDEM Schritt 3 erfolgreich war!)**
1. In der Firebase-Konsole → Firestore Database → Tab "Regeln".
2. Den kompletten Inhalt der Datei `firestore.rules.hardened` (aus diesem
   Deployment-Paket) einfügen — er ersetzt den bisherigen Inhalt.
3. "Veröffentlichen" klicken.
4. Die Live-Seite erneut testen: Login, Registrierung, und im Admin-Bereich einen
   Nutzer anlegen/bearbeiten/sperren/löschen sowie ein neues Passwort setzen —
   alles sollte weiterhin normal funktionieren, läuft jetzt aber ausschließlich über
   die abgesicherte Server-Funktion.

**Wichtig:** Führe Schritt 4 wirklich erst NACH einem erfolgreich getesteten Login
über die Server-Funktion aus. Sind die gehärteten Regeln aktiv, ohne dass die
Funktion richtig eingerichtet ist, kann sich niemand mehr an- oder abmelden, da dann
weder der Browser direkt noch die Funktion an die Nutzerdaten herankommt. Im
Zweifel einfach in der Firebase-Konsole wieder den Inhalt der ursprünglichen
`firestore.rules` einsetzen, bis alles läuft, und danach erneut versuchen.

Nach erfolgreicher Einrichtung gilt: **Kein Dritter kann mehr — egal mit welchem
Wissen über die öffentliche Firebase-Konfiguration — Benutzernamen, E-Mails oder
Passwort-Hashes direkt aus der Datenbank auslesen.** Der einzige Weg an die Daten
führt über die Server-Funktion, die jede Anfrage prüft (gültiges Admin-Token für
Admin-Aktionen, korrektes Passwort für den Login).

---

Bei Fragen oder wenn ein Schritt nicht funktioniert: den genauen Fehlertext
(z.B. aus der Browser-Konsole oder dem roten Fehlerkasten im Admin-Bereich)
notieren — damit lässt sich die Ursache gezielt eingrenzen.
