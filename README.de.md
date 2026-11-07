# homebridge-homematic-ccu

[English](README.md) | **Deutsch**

Homebridge-Plugin für die **Homematic CCU3 und OpenCCU** (auch RaspberryMatic und CCU2), geschrieben für **Homebridge v2**.
Die CCU wird per XML-RPC angebunden, Zustandsänderungen kommen per Event-Callback, es wird nicht gepollt (Ausnahme: Systemvariablen und CUxD, siehe unten).

> **Hinweis zur Entstehung:** Der Code dieses Plugins wurde vollständig von **Claude** (KI-Assistent von [Anthropic](https://www.anthropic.com)) geschrieben und getestet, im Auftrag und unter Anleitung des Repository-Inhabers.
> Die **Ursprungsidee** stammt von [thkl/homebridge-homematic](https://github.com/thkl/homebridge-homematic), dem langjährigen Homematic-Plugin für Homebridge. Dieses Projekt ist eine Neuentwicklung für Homebridge v2 und **kein Fork**, es wurde kein Code aus dem Originalprojekt übernommen. Siehe [Credits](#credits).

**Homebridge v2:** Das Plugin ist für **Homebridge v2** gebaut und läuft damit (getestet mit Homebridge 2.4.0 auf Node.js 22). Es nutzt die aktuellen APIs von Homebridge v2 / HAP-NodeJS (`onGet`/`onSet`-Handler, `HapStatusError`) und keine veralteten Aufrufe; im Testlog gibt es keine Deprecation-Warnungen. Homebridge 1.9+ ist in den `engines` als unterstützt eingetragen, durch den automatischen Test abgedeckt ist aber nur v2.

**Status:** frühe Version (0.1.0). Der Ende-zu-Ende-Test läuft gegen eine echte Homebridge 2.x und eine *simulierte* CCU. Gegen echte Hardware ist das Plugin noch nicht breit getestet. Fehlerberichte mit Log sind willkommen.

## Inhalt

- [Funktionen](#funktionen)
- [Unterstützte Geräte](#unterstützte-geräte)
- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Konfiguration](#konfiguration)
- [Umstieg von homebridge-homematic](#umstieg-von-homebridge-homematic)
- [Funktionsweise](#funktionsweise)
- [Fehlersuche](#fehlersuche)
- [Grenzen](#grenzen)
- [Entwicklung und Tests](#entwicklung-und-tests)
- [Credits](#credits)
- [Lizenz](#lizenz)

## Funktionen

- Automatische Geräteerkennung über die CCU (BidCos-RF, HmIP-RF, optional BidCos-Wired)
- Kanalnamen aus der CCU (ReGa) werden als HomeKit-Namen übernommen
- Events per XML-RPC-Callback, mit Watchdog, der sich nach CCU-Neustart oder Verbindungsabbruch neu anmeldet
- Typrichtige Schreibzugriffe (`FLOAT` als `double`, `ENUM`/`INTEGER` als `int`, `BOOL` als `bool`), wie die CCU sie verlangt
- Systemvariablen (Logikwerte) und CUxD-Kanäle als Schalter
- Filter (`include`/`exclude`) und Zuordnung als Steckdose, Licht oder Fenster in der Config UI X
- Geräteauswahl nach Gewerk der CCU: nur die gewählten Gewerke einbinden, alles andere ignorieren

## Unterstützte Geräte

| HomeKit | Homematic-Kanaltypen | Beispielgeräte |
|---|---|---|
| Schalter / Steckdose / Licht | `SWITCH`, `SWITCH_VIRTUAL_RECEIVER` | HM-LC-Sw1-FM, HmIP-PS, HmIP-PSM, HmIP-BSM, HmIP-FSM |
| Dimmer (Licht) | `DIMMER`, `DIMMER_VIRTUAL_RECEIVER` | HM-LC-Dim1T-FM, HmIP-BDT, HmIP-FDT |
| Rollladen / Jalousie (optional als Fenster) | `BLIND`, `BLIND_VIRTUAL_RECEIVER`, `SHUTTER_VIRTUAL_RECEIVER` | HM-LC-Bl1-FM, HmIP-BROLL, HmIP-FROLL, HmIP-BBL |
| Kontaktsensor | `SHUTTER_CONTACT`, `ROTARY_HANDLE_SENSOR`, `ROTARY_HANDLE_TRANSCEIVER` | HM-Sec-SC, HM-Sec-RHS, HmIP-SWDO, HmIP-SRH |
| Thermostat | `CLIMATECONTROL_RT_TRANSCEIVER`, `HEATING_CLIMATECONTROL_TRANSCEIVER`, `THERMALCONTROL_TRANSMIT` | HM-CC-RT-DN, HmIP-eTRV, HmIP-WTH, HmIP-STH |
| Schalter (per ReGa) | Systemvariablen (Logikwert), CUxD-Kanäle | `Anwesenheit`, `CUxD.CUX0200001:1` |

Welche Kanäle eingebunden werden, entscheidet das Plugin anhand der Parameterbeschreibung der CCU (zum Beispiel nur Kanäle mit schreibbarem `STATE` oder `LEVEL`). Die Gerätenamen in der Tabelle sind Beispiele für Kanaltypen, keine geprüfte Kompatibilitätsliste.

**Thermostate:** *Aus* entspricht der Mindesttemperatur, *Heizen* ist manuell, *Auto* schaltet in den Automatikbetrieb. Bei HmIP wird `CONTROL_MODE` genutzt, beim HM-CC-RT-DN `AUTO_MODE`/`MANU_MODE`. Das Verstellen der Solltemperatur wird entprellt, damit der HomeKit-Regler die CCU nicht mit Befehlen flutet.

**Rollläden:** Die Position wird 1:1 übernommen (100 % = offen). Fahrtrichtung kommt aus `ACTIVITY_STATE` (HmIP) beziehungsweise `WORKING`/`DIRECTION` (HM).

## Voraussetzungen

- **Homebridge v2** (getestet mit 2.4.0); Homebridge 1.9+ ist als unterstützt eingetragen, aber nicht von den Tests abgedeckt. Node.js 20.18+, 22.10+ oder 24
- Eine CCU3 oder OpenCCU (RaspberryMatic/CCU2 sollten genauso funktionieren)
- Firewall der CCU (*Einstellungen > Systemsteuerung > Sicherheit > Firewall*):
  - **Homematic XML-RPC API** auf *Vollzugriff* oder *Eingeschränkt*. Bei *Eingeschränkt* die IP der Homebridge eintragen und die Ports **2001** (Funk) und **2010** (HmIP) freigeben, bei Wired zusätzlich **2000**.
  - **Remote Homematic-Script API** für Kanalnamen, Systemvariablen und CUxD (Port **8181**). Ohne sie läuft das Plugin trotzdem, die Geräte heißen dann nach Typ und Adresse.
- Die CCU baut die Verbindung zurück zu Homebridge auf: TCP-Port `callbackPort` (Standard **9190**) muss von der CCU aus erreichbar sein. Bei Docker oder Firewall auf dem Homebridge-Host beachten.
- Eine aktivierte Authentifizierung an der CCU (Benutzer/Passwort für XML-RPC und ReGa) wird noch nicht unterstützt.

## Installation

### Per Konsole (herunterladen, bauen, installieren)

Auf dem Rechner, auf dem Homebridge läuft (Node.js 20.18+ und git nötig):

```bash
git clone https://github.com/chrkan/homebridge-homematic-ccu.git
cd homebridge-homematic-ccu
npm install
npm run build
npm pack
```

`npm pack` erzeugt das Paket `homebridge-homematic-ccu-<Version>.tgz`. Installiere es je nach Setup so:

```bash
# Homebridge-Image / hb-service (Raspberry Pi, Debian, Proxmox-LXC)
sudo hb-service add ./homebridge-homematic-ccu-*.tgz

# Homebridge per npm global installiert
sudo npm install -g ./homebridge-homematic-ccu-*.tgz
```

Ohne git lädst du stattdessen das Quellarchiv herunter und entpackst es:

```bash
curl -L -o homebridge-homematic-ccu.tar.gz https://github.com/chrkan/homebridge-homematic-ccu/archive/refs/heads/main.tar.gz
tar xzf homebridge-homematic-ccu.tar.gz
cd homebridge-homematic-ccu-main
```
(Heißt der Standard-Branch `master`, ersetze `main` in beiden Zeilen.) Danach wie oben `npm install`, `npm run build` und `npm pack`.

Aktualisieren: im Ordner `git pull`, dann `npm install`, `npm run build`, `npm pack` und den Installationsbefehl wiederholen. Deinstallieren: `sudo npm uninstall -g homebridge-homematic-ccu` (oder das Plugin in der Config UI X entfernen).

### Aus einem Release-Paket (`.tgz`)

Wenn du die Paketdatei schon hast (zum Beispiel aus einem GitHub-Release):

```bash
# Homebridge-Image / hb-service
sudo hb-service add ./homebridge-homematic-ccu-0.1.0.tgz

# Homebridge per npm global installiert
sudo npm install -g ./homebridge-homematic-ccu-0.1.0.tgz
```

Docker (`homebridge/homebridge`): Paket in das `/homebridge`-Volume legen und im Container `cd /homebridge && npm install ./homebridge-homematic-ccu-0.1.0.tgz` ausführen.

### Direkt von GitHub

```bash
sudo npm install -g github:chrkan/homebridge-homematic-ccu
```

Danach Homebridge neu starten und das Plugin in der Config UI X unter *Plugins* konfigurieren.

## Konfiguration

Minimalbeispiel für die `config.json`:

```json
{
  "platform": "HomematicCCU",
  "name": "Homematic CCU",
  "ccuHost": "192.168.0.100"
}
```

Ausführlicheres Beispiel:

```json
{
  "platform": "HomematicCCU",
  "name": "Homematic CCU",
  "ccuHost": "192.168.0.100",
  "bidcosRf": true,
  "hmipRf": true,
  "outlets": ["BidCos-RF.NEQ0123456:1", "HmIP-RF.000213C99095C3:3"],
  "windows": ["BidCos-RF.NEQ0654321:1"],
  "exclude": ["NEQ0999999"],
  "variables": ["Anwesenheit_HomeKit"],
  "cuxdSwitches": ["CUxD.CUX0200001:1"],
  "serviceOverrides": [{ "type": "HM-LC-Sw4-SM:SWITCH", "kind": "blind" }]
}
```

| Option | Typ | Standard | Beschreibung |
|---|---|---|---|
| `ccuHost` | String | – | IP-Adresse oder Hostname der CCU (**erforderlich**) |
| `bidcosRf` | Boolean | `true` | Funkgeräte (Port 2001) |
| `hmipRf` | Boolean | `true` | HomeMatic IP (Port 2010) |
| `bidcosWired` | Boolean | `false` | Wired-Geräte (Port 2000) |
| `useReGaNames` | Boolean | `true` | Kanalnamen aus der CCU übernehmen (Port 8181) |
| `functions` | Liste | leer | Nur Kanäle einbinden, die diesen Gewerken in der CCU zugeordnet sind; leer = kein Gewerke-Filter (benötigt Port 8181) |
| `include` | Liste | leer | Diese Geräte/Kanäle einbinden. Ohne `functions`: nur diese (leer = alle unterstützten). Mit `functions`: zusätzlich zu den Gewerken |
| `exclude` | Liste | leer | Diese Geräte/Kanäle ausschließen |
| `outlets` | Liste | leer | Schaltkanäle, die als Steckdose erscheinen |
| `lights` | Liste | leer | Schaltkanäle, die als Licht erscheinen |
| `windows` | Liste | leer | Rollladenkanäle, die als HomeKit-Fenster erscheinen |
| `variables` | Liste | leer | Systemvariablen (Logikwert) als Schalter |
| `cuxdSwitches` | Liste | leer | CUxD-Schaltkanäle (Zugriff über ReGa) |
| `pollInterval` | Zahl (s) | `10` | Abfrageintervall für Variablen und CUxD (mindestens 5) |
| `serviceOverrides` | Liste | leer | Zuordnung überschreiben: `type` = `Gerätetyp:Kanaltyp`, `kind` = `switch`, `dimmer`, `blind`, `contact` oder `thermostat` |
| `localIp` | String | automatisch | IP der Homebridge, nur setzen, wenn die Erkennung falsch liegt |
| `callbackPort` | Zahl | `9190` | Port für die Events der CCU |

Adressen in den Listen gelten für Gerät (`NEQ0123456`) oder Kanal (`NEQ0123456:1`). Ein Interface-Präfix wie `BidCos-RF.`, `HmIP-RF.` oder `CUxD.` darf davorstehen und wird ignoriert.

Mehrere virtuelle Empfängerkanäle eines HmIP-Geräts: automatisch wird nur der erste eingebunden, weitere über `include`.

### Geräte nach Gewerk auswählen

Mit `functions` werden nur die Kanäle eingebunden, die in der CCU bestimmten **Gewerken** zugeordnet sind. Alle anderen Geräte werden ignoriert.

```json
{
  "platform": "HomematicCCU",
  "name": "Homematic CCU",
  "ccuHost": "192.168.0.100",
  "functions": ["Licht", "Heizung", "Rollläden"]
}
```

- Ordne die Kanäle in der WebUI der CCU den Gewerken zu (*Einstellungen > Gewerke*). Das Plugin bindet dann nur Kanäle der in `functions` genannten Gewerke ein. Die Namen werden ohne Beachtung von Groß-/Kleinschreibung verglichen und müssen so geschrieben sein wie in der CCU.
- Ohne `functions` (leer oder nicht gesetzt) gibt es keinen Gewerke-Filter, dann werden alle unterstützten Geräte eingebunden.
- `include` fügt einzelne Geräte/Kanäle zusätzlich zu den gewählten Gewerken hinzu, `exclude` hat immer Vorrang.
- Systemvariablen (`variables`) und CUxD-Kanäle (`cuxdSwitches`) werden einzeln aufgelistet und sind vom Gewerke-Filter nicht betroffen.
- Wird ein Gewerk nicht gefunden, listet das Log die in der CCU vorhandenen Gewerke auf.
- Zum Lesen der Gewerke wird die *Remote Homematic-Script API* (Port 8181) gebraucht. Lassen sie sich nicht lesen, wird nach Gewerk nichts eingebunden, vorhandene Accessories bleiben erhalten und das Plugin versucht es nach 60 Sekunden erneut.
- Eine geänderte Gewerke-Zuordnung an der CCU löst kein Event aus: Homebridge neu starten, damit sie übernommen wird.

## Umstieg von homebridge-homematic

Die Datei `homematic_config.json` wird nicht gelesen, die Einstellungen stehen in der Plugin-Config.

| alte `homematic_config.json` | neu |
|---|---|
| `filter_device`, `filter_channel` | `exclude` |
| `outlets` | `outlets` (optional `lights`) |
| `windows` | `windows` |
| `variables` | `variables` (nur Logikwerte, per ReGa) |
| `services` (`"HM-LC-Sw4-SM:BLIND"` + Service-Klasse) | `serviceOverrides` mit `type` und `kind` |
| CUxD-Kanäle in `outlets` | `cuxdSwitches` (zusätzlich in `outlets` für die Darstellung als Steckdose) |
| `programs` | nicht unterstützt |

Außerdem:

- Das alte Plugin deinstallieren und seine gecachten Accessories in der Config UI X entfernen, sonst erscheinen Geräte doppelt.
- Die Accessories haben neue IDs. Räume, Szenen und Automationen in der Home-App müssen neu zugeordnet werden.
- Nicht übernommen: Programme, Garagentor, Keymatic, Rauchmelder, Bewegungsmelder, RGBW, Batteriestatus, Variablen außer Logikwerten.

## Funktionsweise

1. Beim Start öffnet das Plugin einen XML-RPC-Server auf `callbackPort` und meldet ihn per `init` an den Schnittstellen der CCU an.
2. Über `listDevices` und `getParamsetDescription` werden die Kanäle gelesen und anhand ihres Typs und der schreibbaren Datenpunkte einem HomeKit-Service zugeordnet. Für jeden Kanal gibt es ein Accessory.
3. Die CCU sendet Änderungen per `event`/`system.multicall` an das Plugin, das die HomeKit-Werte aktualisiert. Schreibzugriffe gehen als `setValue` zur CCU.
4. Ein Watchdog sendet regelmäßig `ping`. Kommen mehrere Minuten keine Events, meldet sich das Plugin neu an.
5. Ändern sich Geräte an der CCU (`newDevices`, `deleteDevices` usw.), wird die Erkennung nach kurzer Wartezeit wiederholt.
6. Systemvariablen und CUxD-Kanäle werden per ReGa-Script gelesen und geschrieben, weil CUxD-Geräte sich nicht per XML-RPC steuern lassen.

## Fehlersuche

| Symptom | Mögliche Ursache |
|---|---|
| Im Log `Anmeldung an der CCU fehlgeschlagen` | XML-RPC-Firewall der CCU, falsche IP oder Port nicht freigegeben |
| Geräte erscheinen, aber Statusänderungen kommen nicht an | Die CCU erreicht `callbackPort` nicht (Firewall, Docker-Netzwerk, falsche `localIp`) |
| Im Log `seit … min keine Events` | Callback blockiert oder CCU neu gestartet; das Plugin versucht die Neuanmeldung |
| Geräte heißen `HmIP-… 00ABC:3` statt nach dem CCU-Namen | *Remote Homematic-Script API* nicht freigegeben oder `useReGaNames` aus |
| Ein Gerät fehlt | Kanaltyp nicht unterstützt, durch `include`/`exclude` gefiltert oder kein schreibbarer Datenpunkt; mit Debug-Log (`homebridge -D`) prüfen |
| Mit `functions` erscheint nichts (oder zu wenig) | Gewerk-Name stimmt nicht (das Log listet die vorhandenen Gewerke), Kanäle sind in der CCU nicht dem Gewerk zugeordnet oder die Remote Homematic-Script API (Port 8181) ist nicht freigegeben |
| Ein HmIP-Gerät erscheint nur einmal, obwohl es mehrere Kanäle hat | Nur der erste virtuelle Empfängerkanal wird automatisch eingebunden, weitere über `include` |
| Variable oder CUxD reagiert verzögert | Abfrage per Polling, `pollInterval` verkleinern |

Für Fehlerberichte bitte ein [Issue](https://github.com/chrkan/homebridge-homematic-ccu/issues) öffnen und ein Log mit `homebridge -D` (Debug) vom Start bis zum Problem anhängen. Gerätetyp und Kanaltyp stehen dort bei den neu angelegten Accessories.

## Grenzen

- Keine Unterstützung für aktivierte Authentifizierung an der CCU
- Keine Programme, keine Systemvariablen außer Logikwerten, kein Keymatic/Garagentor, keine Rauch- und Bewegungsmelder, kein RGBW, kein Batteriestatus
- Ein Accessory je Kanal; Homebridge begrenzt eine Bridge auf 150 Accessories (bei großen Installationen Child Bridge nutzen oder per `include` filtern)
- Noch keine Erfahrung mit sehr großen Installationen und mit allen Gerätetypen an echter Hardware

## Entwicklung und Tests

```bash
npm install
npm install --no-save --ignore-scripts --omit=optional hap-controller   # nur für die Tests nötig
npm run build
npm test
```

`npm test` startet eine echte Homebridge 2.x zusammen mit einer simulierten CCU (XML-RPC auf den Ports 2001 und 2010, ReGa auf 8181) und koppelt einen HAP-Controller. Geprüft werden unter anderem Geräteauswahl, Namen, Schreibzugriffe mit korrekten Datentypen, Events (auch per `system.multicall`), Thermostat-Modi, `windows`, `serviceOverrides`, Interface-Präfixe sowie Systemvariablen und CUxD über die ReGa. Die ReGa-Scripts sind nur gegen die Simulation geprüft, nicht gegen eine echte CCU.

Der Code ist TypeScript, die Struktur ist klein gehalten: `src/rpc.ts` (XML-RPC und ReGa), `src/platform.ts` (Erkennung, Zuordnung, Polling) und je ein Handler pro Gerätetyp in `src/handlers/`.

## Credits

- **Code:** geschrieben und getestet von **Claude** (KI-Assistent von [Anthropic](https://www.anthropic.com)), im Auftrag und unter Anleitung des Repository-Inhabers, der das Ergebnis prüft, veröffentlicht und verantwortet.
- **Ursprungsidee:** [thkl/homebridge-homematic](https://github.com/thkl/homebridge-homematic). Das Originalprojekt hat Homematic für viele Jahre in HomeKit gebracht und ist inzwischen archiviert. Dieses Plugin knüpft an seine Idee an (CCU-Geräte automatisch in HomeKit, Konfiguration über Listen wie `outlets` und `windows`), ist aber komplett neu geschrieben und kein Fork.
- Genutzt wird die Bibliothek [`homematic-xmlrpc`](https://www.npmjs.com/package/homematic-xmlrpc) für den XML-RPC-Transport. Homebridge und HAP-NodeJS gehören zu ihren jeweiligen Projekten.
- Homematic und Homematic IP sind Marken der eQ-3 AG. Dieses Projekt steht in keiner Verbindung zu eQ-3, ELV oder Anthropic.

## Lizenz

[MIT](LICENSE)
