# Feature: feed inactiviteitsindicator in spelerslijst

## Lees eerst
- `modules/sidebar.js` — volledig, focus op de functie die player rijen rendert
- `index.html` regels 460–468 — bestaande CSS klassen `.plcd`, `.plcd.warn`, `.plcd.old`

---

## Context

Elke speler in `data.json` heeft nu een `feed` veld — een timestamp (ms) van
de volgende feed deadline. Spelers moeten elke 3 dagen "Feed People" uitvoeren.

We willen alleen spelers markeren die duidelijk inactief zijn:
`feed` meer dan 7 dagen in het verleden → waarschijnlijk gestopt met spelen.

Voor actieve spelers (feed in de toekomst of minder dan 7 dagen geleden)
tonen we niets extra — die zijn al zichtbaar via de live data in het garrison modal.

---

## Bestaande CSS (hergebruiken, niet aanpassen)

```css
.plcd       { font-size:9px; color:#666; }
.plcd.warn  { color:#FAC775; }   /* oranje */
.plcd.old   { color:#ff8483; }   /* rood   */
```

Deze klassen worden al gebruikt voor `lcd` (last change days).
We voegen een feed indicator toe in hetzelfde visuele stijl.

---

## Logica

```javascript
var now = Date.now();
var feedDeadline = player.feed || 0;

if (feedDeadline === 0) {
    // Geen feed data — toon niets
} else {
    var daysOverdue = (now - feedDeadline) / (24 * 60 * 60 * 1000);

    if (daysOverdue >= 7) {
        // Waarschijnlijk inactief — toon rood label
        // label: "no feed 7d+" of exact aantal dagen bijv. "no feed 142d"
        var days = Math.floor(daysOverdue);
        // gebruik klasse: plcd old
    } else if (daysOverdue >= 3) {
        // Feed overdue maar nog recent — toon oranje label
        // label: "feed due Xd" 
        var days = Math.floor(daysOverdue);
        // gebruik klasse: plcd warn
    }
    // daysOverdue < 3 → toon niets
}
```

---

## Implementatie

Zoek in `sidebar.js` de functie die een player rij rendert (waarschijnlijk
iets als `renderPlayerRow` of de plek waar de HTML string per speler wordt
opgebouwd).

Voeg de feed indicator toe als een extra span element in de rij,
naast het bestaande `lcd` element (last change days).

Het label moet kort zijn zodat het past in de smalle spelerslijst:
- `≥ 7 dagen overdue` → `<span class="plcd old">no feed Xd</span>`
- `3–7 dagen overdue` → `<span class="plcd warn">feed Xd</span>`

Zorg dat de indicator alleen zichtbaar is als `player.feed` beschikbaar is
en de drempel wordt overschreden — voor de meeste actieve spelers verschijnt niets.

---

## Vereisten
- Alleen `modules/sidebar.js` aanpassen
- Geen CSS wijzigingen nodig — bestaande klassen hergebruiken
- Bump versienummer in `index.html`
- Geef alleen de gewijzigde sectie terug
- Commit message en changelog in het Engels
