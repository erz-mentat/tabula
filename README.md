# Tabula

Notizbuch-App fürs iPad mit Apple Pencil: Notizbücher mit Deckblättern, Seiten von A4 bis A1, Stift, Marker, Radierer, Bilder, PDF-Import.
Läuft komplett im Browser, Notizen bleiben im Speicher des Geräts.

Öffnen: https://erz-mentat.github.io/tabula/ und über Teilen › „Zum Home-Bildschirm“ ablegen.

PDF-Darstellung: [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Apache 2.0, siehe `lib/PDFJS-LICENSE.txt`).
Strichglättung: perfect-freehand (MIT).

## Datenformat der GitHub-Sicherung (Format 4)

Im privaten Daten-Repository liegen `index.json` (Notizbücher und Seiten, ein Eintrag pro Zeile), `pages/<seiten-id>.jsonl` (ein Strich pro Zeile, Koordinaten als Differenzen in Zehntelmillimetern, Base36, zigzag-kodiert) und `assets/` (Bilder und PDF-Seiten). Jede Sicherung ist ein einzelner Commit über die Git-Data-Schnittstelle und enthält nur geänderte Dateien. Das alte Format (`tabula.json`) wird beim ersten Abgleich automatisch umgestellt.
