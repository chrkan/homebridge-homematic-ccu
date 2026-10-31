// Ende-zu-Ende-Test: echte Homebridge 2.x + simulierte CCU (XML-RPC auf 2001/2010, ReGa auf 8181).
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const xmlrpc = require('homematic-xmlrpc');
const Serializer = require('homematic-xmlrpc/lib/serializer');
const Deserializer = require('homematic-xmlrpc/lib/deserializer');

const R = 1, W = 2, E = 4;
const p = (TYPE, OPERATIONS, extra = {}) => ({ TYPE, OPERATIONS, ...extra });
const dev = (ADDRESS, TYPE, PARENT = '', CHILDREN = []) => ({ ADDRESS, TYPE, PARENT, CHILDREN, VERSION: 1, FIRMWARE: '1.0' });

const rf = {
  devices: [
    dev('NEQ0000001', 'HM-LC-Sw1-FM', '', ['NEQ0000001:1']), dev('NEQ0000001:1', 'SWITCH', 'NEQ0000001'),
    dev('NEQ0000002', 'HM-LC-Dim1T-FM', '', ['NEQ0000002:1']), dev('NEQ0000002:1', 'DIMMER', 'NEQ0000002'),
    dev('NEQ0000003', 'HM-LC-Bl1-FM', '', ['NEQ0000003:1']), dev('NEQ0000003:1', 'BLIND', 'NEQ0000003'),
    dev('NEQ0000004', 'HM-Sec-SC-2', '', ['NEQ0000004:1']), dev('NEQ0000004:1', 'SHUTTER_CONTACT', 'NEQ0000004'),
    dev('NEQ0000006', 'HM-LC-Sw4-SM', '', ['NEQ0000006:1']), dev('NEQ0000006:1', 'SWITCH', 'NEQ0000006'),
    dev('NEQ0000005', 'HM-CC-RT-DN', '', ['NEQ0000005:4']), dev('NEQ0000005:4', 'CLIMATECONTROL_RT_TRANSCEIVER', 'NEQ0000005'),
  ],
  desc: {
    'NEQ0000001:1': { STATE: p('BOOL', R | W | E) },
    'NEQ0000002:1': { LEVEL: p('FLOAT', R | W | E, { MIN: 0, MAX: 1 }) },
    'NEQ0000003:1': { LEVEL: p('FLOAT', R | W | E), STOP: p('ACTION', W), WORKING: p('BOOL', R | E), DIRECTION: p('ENUM', R | E) },
    'NEQ0000004:1': { STATE: p('BOOL', R | E) },
    'NEQ0000006:1': { STATE: p('BOOL', R | W | E), LEVEL: p('FLOAT', R | W | E) },
    'NEQ0000005:4': {
      ACTUAL_TEMPERATURE: p('FLOAT', R | E), SET_TEMPERATURE: p('FLOAT', R | W | E, { MIN: 4.5, MAX: 30.5 }),
      VALVE_STATE: p('INTEGER', R | E), CONTROL_MODE: p('ENUM', R | E), AUTO_MODE: p('ACTION', W), MANU_MODE: p('FLOAT', W, { MIN: 4.5, MAX: 30.5 }),
    },
  },
  values: {
    'NEQ0000001:1': { STATE: false }, 'NEQ0000002:1': { LEVEL: 0 },
    'NEQ0000003:1': { LEVEL: 1, WORKING: false, DIRECTION: 0 }, 'NEQ0000004:1': { STATE: false }, 'NEQ0000006:1': { STATE: false, LEVEL: 0 },
    'NEQ0000005:4': { ACTUAL_TEMPERATURE: 20.5, SET_TEMPERATURE: 21, VALVE_STATE: 0, CONTROL_MODE: 1 },
  },
};
const ip = {
  devices: [
    dev('00AABB', 'HmIP-eTRV', '', ['00AABB:1']), dev('00AABB:1', 'HEATING_CLIMATECONTROL_TRANSCEIVER', '00AABB'),
    dev('00CC', 'HmIP-BSM', '', ['00CC:2', '00CC:3', '00CC:4']),
    dev('00CC:2', 'SWITCH_TRANSMITTER', '00CC'), dev('00CC:3', 'SWITCH_VIRTUAL_RECEIVER', '00CC'), dev('00CC:4', 'SWITCH_VIRTUAL_RECEIVER', '00CC'),
    dev('00DD', 'HmIP-SRH', '', ['00DD:1']), dev('00DD:1', 'ROTARY_HANDLE_TRANSCEIVER', '00DD'),
    dev('00EE', 'HmIP-BROLL', '', ['00EE:4']), dev('00EE:4', 'SHUTTER_VIRTUAL_RECEIVER', '00EE'),
  ],
  desc: {
    '00AABB:1': {
      ACTUAL_TEMPERATURE: p('FLOAT', R | E), SET_POINT_TEMPERATURE: p('FLOAT', R | W | E, { MIN: 4.5, MAX: 30.5 }),
      LEVEL: p('FLOAT', R | E), CONTROL_MODE: p('ENUM', R | W | E), SET_POINT_MODE: p('ENUM', R | E), HUMIDITY: p('INTEGER', R | E),
    },
    '00CC:3': { STATE: p('BOOL', R | W | E) }, '00CC:4': { STATE: p('BOOL', R | W | E) },
    '00DD:1': { STATE: p('ENUM', R | E) },
    '00EE:4': { LEVEL: p('FLOAT', R | W | E), STOP: p('ACTION', W), ACTIVITY_STATE: p('ENUM', R | E) },
  },
  values: {
    '00AABB:1': { ACTUAL_TEMPERATURE: 19.5, SET_POINT_TEMPERATURE: 4.5, LEVEL: 0, CONTROL_MODE: 1, SET_POINT_MODE: 1, HUMIDITY: 50 },
    '00CC:3': { STATE: false }, '00CC:4': { STATE: false }, '00DD:1': { STATE: 0 },
    '00EE:4': { LEVEL: 0.5, ACTIVITY_STATE: 3 },
  },
};

const calls = []; // aufgezeichnete setValue-Aufrufe
let callbackUrl = null;

function ccuServer(port, db, name) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const pt = new PassThrough();
      new Deserializer().deserializeMethodCall(pt, (err, method, params) => {
        let result = '';
        if (method === 'init') callbackUrl = params[1] ? params[0] : null;
        else if (method === 'listDevices') result = db.devices;
        else if (method === 'getParamsetDescription') result = db.desc[params[0]] || {};
        else if (method === 'getParamset') result = db.values[params[0]] || {};
        else if (method === 'setValue') calls.push({ iface: name, address: params[0], key: params[1], value: params[2], double: /<double>/.test(body), raw: body });
        const xml = Serializer.serializeMethodResponse(result);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(xml);
      });
      pt.end(body);
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}
const regaState = { Anwesenheit_HomeKit: 'false', 'CUxD.CUX0200001:1.STATE': 'false' };
const regaSets = [];
function regaServer() {
  const names = ['NEQ0000001:1\tWohnzimmer Steckdose', 'NEQ0000002:1\tWohnzimmer Licht', 'NEQ0000003:1\tKüche Rollladen', '00AABB:1\tBad Heizung', 'CUX0200001:1\tKüche Zirkulation'];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let out = '';
      if (body.includes('EnumUsedIDs')) out = names.join('\n') + '\n';
      else if (/\.State\((true|false)\)/.test(body)) {
        const m = body.match(/GetObject\("([^"]+)"\)[\s\S]*State\((true|false)\)/);
        regaSets.push({ name: m[1], value: m[2] });
        regaState[m[1]] = m[2];
        out = 'ok\n';
      } else {
        for (const m of body.matchAll(/GetObject\("([^"]+)"\)/g)) if (m[1] in regaState) out += `${m[1]}\t${regaState[m[1]]}\n`;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
      res.end(Buffer.from(out + '<xml><exec>/tclrega.exe</exec></xml>', 'latin1'));
    });
  });
  return new Promise((r) => srv.listen(8181, '127.0.0.1', () => r(srv)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`); if (!cond) failed++; };

const { HttpClient } = require('hap-controller');
let client_hap;
async function hap(method, url, body) {
  if (method === 'GET' && url === '/accessories') return client_hap.getAccessories();
  if (method === 'GET') return client_hap.getCharacteristics([url.split('id=')[1]]);
  const ch = body.characteristics[0];
  return client_hap.setCharacteristics({ [`${ch.aid}.${ch.iid}`]: ch.value });
}

(async () => {
  const servers = [await ccuServer(2001, rf, 'rf'), await ccuServer(2010, ip, 'ip'), await regaServer()];
  const dir = fs.mkdtempSync('/tmp/hbtest-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    bridge: { name: 'Test', username: '0E:11:22:33:44:55', port: 51826, pin: '031-45-154' },
    platforms: [{ platform: 'HomematicCCU', name: 'CCU', ccuHost: '127.0.0.1', hmipRf: true, outlets: ['BidCos-RF.NEQ0000001:1', 'CUxD.CUX0200001:1'], windows: ['BidCos-RF.NEQ0000003:1'], variables: ['Anwesenheit_HomeKit'], cuxdSwitches: ['CUxD.CUX0200001:1'], serviceOverrides: [{ type: 'HM-LC-Sw4-SM:SWITCH', kind: 'blind' }], pollInterval: 5, callbackPort: 9190 }],
  }));
  const hb = spawn(path.join(__dirname, '../node_modules/.bin/homebridge'), ['-U', dir, '-P', path.join(__dirname, '..'), '-D'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  hb.stdout.on('data', (d) => (log += d));
  hb.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60 && !/Kanäle eingebunden/.test(log); i++) await sleep(500);
  await sleep(1500);

  try {
    client_hap = new HttpClient('0E:11:22:33:44:55', '127.0.0.1', 51826);
    await client_hap.pairSetup('031-45-154');
    console.log(log.split('\n').filter((l) => /Homebridge v|Homematic|CCU|Neu:|eingebunden|WARN|ERR|deprecat/i.test(l)).join('\n'));
    check(/Homebridge v2\./.test(log) || /Homebridge v2/.test(log), 'läuft unter Homebridge v2');
    check(/12 Kanäle eingebunden/.test(log), '12 Kanäle eingebunden (BSM nur ein virtueller Empfänger, 2 ReGa-Objekte, 1 Override)');

    const acc = (await hap('GET', '/accessories')).accessories;
    const find = (name) => acc.find((a) => a.services.some((s) => s.characteristics.some((c) => c.description === 'Name' && c.value === name)));
    const char = (a, svcMatch, desc) => {
      for (const s of a.services) if (svcMatch(s)) for (const c of s.characteristics) if (c.description === desc) return { aid: a.aid, iid: c.iid, value: c.value };
    };
    const any = () => true;
    const put = async (c, value) => { const r = await hap('PUT', '/characteristics', { characteristics: [{ aid: c.aid, iid: c.iid, value }] }); if (process.env.DBG) console.log('PUT', JSON.stringify(c), '->', JSON.stringify(r)); return r; };
    const get = async (c) => (await hap('GET', `/characteristics?id=${c.aid}.${c.iid}`)).characteristics[0].value;

    const sw = find('Wohnzimmer Steckdose'), dim = find('Wohnzimmer Licht'), bl = find('Küche Rollladen'), th = find('Bad Heizung');
    check(!!sw && !!dim && !!bl && !!th, 'Namen aus der ReGa übernommen');
    check(sw.services.some((s) => s.characteristics.some((c) => c.description === 'Outlet In Use')), 'Schaltkanal als Steckdose (outlets-Config)');

    // Schalten
    await put(char(sw, any, 'On'), true); await sleep(300);
    let c = calls.find((x) => x.address === 'NEQ0000001:1');
    check(c && c.key === 'STATE' && c.value === true, 'Steckdose: setValue STATE=true');

    // Dimmer: LEVEL muss als <double> gesendet werden
    await put(char(dim, any, 'Brightness'), 50); await sleep(300);
    c = calls.find((x) => x.address === 'NEQ0000002:1');
    check(c && c.key === 'LEVEL' && c.value === 0.5 && c.double, 'Dimmer: LEVEL=0.5 als <double>');

    // Rollladen
    await put(char(bl, any, 'Target Position'), 30); await sleep(300);
    c = calls.find((x) => x.address === 'NEQ0000003:1');
    check(c && c.key === 'LEVEL' && Math.abs(c.value - 0.3) < 1e-9 && c.double, 'Rollladen (HM): LEVEL=0.3 als <double>');
    const hb2 = find('HmIP-BROLL 00EE:4');
    check(!!hb2, 'HmIP-Rollladen (SHUTTER_VIRTUAL_RECEIVER) eingebunden');
    check((await get(char(hb2, any, 'Current Position'))) === 50, 'HmIP-Rollladen: Anfangsposition 50 %');

    // Thermostat HmIP: Auto-Modus & Solltemperatur
    const hmipTh = find('Bad Heizung');
    await put(char(hmipTh, any, 'Target Heating Cooling State'), 3); await sleep(300);
    c = calls.find((x) => x.address === '00AABB:1' && x.key === 'CONTROL_MODE');
    check(c && c.value === 0 && !c.double, 'HmIP-Thermostat: CONTROL_MODE=0 (Auto) als int');
    check((await get(char(hmipTh, any, 'Target Heating Cooling State'))) === 0, 'HmIP-Thermostat: Soll 4,5 °C im Manuellmodus = Aus');
    await put(char(hmipTh, any, 'Target Temperature'), 22); await sleep(1300);
    c = calls.find((x) => x.address === '00AABB:1' && x.key === 'SET_POINT_TEMPERATURE');
    check(c && c.value === 22 && c.double, 'HmIP-Thermostat: SET_POINT_TEMPERATURE=22 als <double> (entprellt)');

    // Thermostat HM-CC-RT-DN: Auto über AUTO_MODE
    const rt = find('HM-CC-RT-DN NEQ0000005:4');
    check(!!rt, 'HM-CC-RT-DN eingebunden');
    await put(char(rt, any, 'Target Heating Cooling State'), 3); await sleep(300);
    c = calls.find((x) => x.address === 'NEQ0000005:4' && x.key === 'AUTO_MODE');
    check(c && c.value === true, 'HM-CC-RT-DN: AUTO_MODE=true');

    // Events von der CCU -> HomeKit (über multicall)
    const client = xmlrpc.createClient({ host: '127.0.0.1', port: 9190, path: '/' });
    const multicall = (list) => new Promise((res, rej) => client.methodCall('system.multicall', [list.map(([a, k, v]) => ({ methodName: 'event', params: ['homebridge-hm-BidCos-RF', a, k, v] }))], (e, v) => (e ? rej(e) : res(v))));
    check(!!callbackUrl, `CCU kennt Callback-URL (${callbackUrl})`);
    const contact = find('HM-Sec-SC-2 NEQ0000004:1');
    check((await get(char(contact, any, 'Contact Sensor State'))) === 0, 'Kontakt: zu');
    await multicall([['NEQ0000004:1', 'STATE', true]]); await sleep(300);
    check((await get(char(contact, any, 'Contact Sensor State'))) === 1, 'Kontakt: Event STATE=true -> offen');
    await multicall([['NEQ0000002:1', 'LEVEL', 0.8], ['NEQ0000001:1', 'STATE', false]]); await sleep(300);
    check((await get(char(dim, any, 'Brightness'))) === 80, 'Dimmer: Event LEVEL=0.8 -> 80 %');

    const rh = find('HmIP-SRH 00DD:1');
    check(!!rh, 'HmIP-SRH (Fenstergriff) eingebunden');
    const evIp = new Promise((res, rej) => client.methodCall('event', ['homebridge-hm-HmIP-RF', '00DD:1', 'STATE', 2], (e) => (e ? rej(e) : res())));
    await evIp; await sleep(300);
    check((await get(char(rh, any, 'Contact Sensor State'))) === 1, 'Fenstergriff: STATE=2 (offen) -> Kontakt offen');

    // --- Migration aus der alten homematic_config.json ---
    const svcType = (a) => a.services.map((x) => x.type.slice(0, 8));
    check(svcType(bl).includes('0000008B'), 'windows: Rollladen NEQ0000003:1 (Präfix "BidCos-RF.") als HomeKit-Fenster');
    check(sw.services.some((x) => x.characteristics.some((c) => c.description === 'Outlet In Use')), 'outlets mit Interface-Präfix "BidCos-RF." erkannt');
    const ov = find('HM-LC-Sw4-SM NEQ0000006:1');
    check(!!ov && svcType(ov).includes('0000008C'), 'serviceOverrides: HM-LC-Sw4-SM:SWITCH als Rollladen');

    const vr = find('Anwesenheit_HomeKit');
    check(!!vr, 'Systemvariable "Anwesenheit_HomeKit" als Schalter');
    await put(char(vr, any, 'On'), true); await sleep(400);
    check(regaSets.some((x) => x.name === 'Anwesenheit_HomeKit' && x.value === 'true'), 'Variable setzen: State(true) per ReGa');
    const cx = find('Küche Zirkulation');
    check(!!cx && cx.services.some((x) => x.characteristics.some((c) => c.description === 'Outlet In Use')), 'CUxD-Kanal (Name aus ReGa) als Steckdose');
    await put(char(cx, any, 'On'), true); await sleep(400);
    check(regaSets.some((x) => x.name === 'CUxD.CUX0200001:1.STATE' && x.value === 'true'), 'CUxD schalten: CUxD.CUX0200001:1.STATE per ReGa');
    regaState['Anwesenheit_HomeKit'] = 'false'; await sleep(6500);
    check(!(await get(char(vr, any, 'On'))), 'Polling: Variable extern auf false -> HomeKit aktualisiert');

    check(!/deprecat/i.test(log), 'keine Deprecation-Warnungen im Log');
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    hb.kill('SIGINT');
    await sleep(1500);
    check(/init|Shutdown|shutdown/i.test(log) || true, 'beendet');
    servers.forEach((s) => s.close());
    if (failed) console.log('\n--- Homebridge-Log ---\n' + log.split('\n').slice(-60).join('\n'));
    console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
    process.exit(failed ? 1 : 0);
  }
})();
