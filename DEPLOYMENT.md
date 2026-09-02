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

- **Passwörter werden aktuell im Klartext in der Datenbank gespeichert**
  (kein Hashing) und die App nutzt ein einfaches eigenes Login statt
  "Firebase Authentication". Für eine interne Übung mit vertrauenswürdigen
  Teilnehmern ist das ein akzeptabler Kompromiss, für einen Einsatz mit
  sensiblen Daten oder öffentlichem Zugriff nicht ausreichend.
- Die mitgelieferten Firestore-Regeln erlauben aus diesem Grund jedem mit der
  (im Quelltext sichtbaren) Firebase-Konfiguration Lese-/Schreibzugriff auf
  die Datenbank. Das lässt sich nur durch eine echte Migration auf "Firebase
  Authentication" sauber schließen.
- Ändere das Admin-Passwort (Martin/1234) direkt nach dem ersten Login.
- Behalte deinen Anthropic-API-Key geheim und lade ihn niemals in ein
  öffentliches GitHub-Repository hoch (er gehört ausschließlich in die
  Netlify-Umgebungsvariable, nicht in den Code).

---

Bei Fragen oder wenn ein Schritt nicht funktioniert: den genauen Fehlertext
(z.B. aus der Browser-Konsole oder dem roten Fehlerkasten im Admin-Bereich)
notieren — damit lässt sich die Ursache gezielt eingrenzen.
