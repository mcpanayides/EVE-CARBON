'use strict';
//
// ─── pings.js — the demo's Jabber: broadcasts and chat rooms ──────────────────
//
// Modelled on real alliance broadcasts — their shape, cadence and voice — with
// every specific replaced. The SIG and target names are invented (a real feed's
// "guardbees → beehive" names a real alliance's home-defence channel), every FC
// is a CCP NPC agent or the demo cast, and every link points at
// vaelin.example, which can never resolve.
//
// Bodies are in the format the app's parser reads (src/jabber_data_db.js):
// free text, then the "FC Name: / Formup Location: / PAP Type: / Comms: /
// Doctrine:" block, then the closing "~~~ This was a <sig> broadcast from <who>
// to <target> at <time> EVE ~~~" line. Real broadcasts arrive in exactly that
// shape, so the real parser runs on these and fills the same columns.

const { DOMAIN, CAST, pilot } = require('./cast');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const COMMS = (op) => `Op ${op} https://comms.${DOMAIN}/op${op}`;
const handle = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

const FC = {
  kaska: CAST.main.name, tera: pilot(2).name, rako: pilot(5).name, ari: pilot(9).name,
  yan: pilot(13).name, rau: pilot(17).name, olk: pilot(21).name,
};

const DOCTRINE = {
  muninn:   'Muninn Fleet (Boosters > Scimitar > Muninn > Huginn > Support)',
  ferox:    'Ferox Fleet (Boosters > Basilisk > Ferox > Support)',
  harpy:    'Harpy Fleet (Boosters > Kirin > Harpy > Else)',
  crusader: 'Crusaders (CHECK YOUR POD > Crusader)',
  retri:    'Retribution Fleet (Booster > Deacon > Retribution > Support)',
  cover:    'Home Cover (FAX > Rorqual > Heavy Interdictor > Interdictor)',
  caps:     'Capitals (FAX > Dreadnought > Carrier > Support)',
  mining:   'Exhumers > Barges > Expedition Frigates > Mining Frigates > Porpoise > Rorqual',
  bombers:  'Bombers (Purifier / Nemesis / Manticore / Hound)',
};

// [hours ago, sig, target, who (FC key or name), body, fields?]
// Newest first in reading order; the last is ~6 minutes old so the dashboard's
// Latest Ping widget leads with a live op.
const BROADCASTS = [
  [0.1,  'opsbot',    'all',      'kaska', 'STRAT OP — form up 1DQ1-A, undock in 25.\n\nDoctrine Muninn with Scimitar support. Bring T2 light drones and a mobile depot. Cap chain on channel 2.\n\nIf you are not in a doctrine hull you are on standby.', { fc: 'kaska', formup: '1DQ1-A', pap: 'Strategic', comms: 3, doctrine: 'muninn' }],
  [1.4,  'homeguard', 'homeguard','tera',  'HOMEGUARD: GREEN\n\nCover fleet is up. Rorquals cleared to undock in 1DQ1-A and 319-3D. Join "Vaelin Home Cover" before you warp anywhere.\nShips: ' + DOCTRINE.cover + '\nComms: https://comms.' + DOMAIN + '/homeguard'],
  [3.2,  'roambot',   'all',      'rako',  'Turtle-speed weekend roam!\nNeed hunters and dictors — we are going looking for trouble in Catch.', { fc: 'rako', formup: '1DQ1-A', pap: 'Peacetime', comms: 9, doctrine: 'retri' }],
  [5.0,  'infra',     'miners',   'ari',   'Moon fracture at T5ZI-S VII - Moon 3 in 2 hours — R32 chunk. Orcas and Rorquals welcome, boosts on grid from 18:00.', { fc: 'ari', formup: 'T5ZI-S', comms: 'Mining 1', doctrine: 'mining' }],
  [7.5,  'capbot',    'caps',     'yan',   'HOSTILE DREADS TACKLED IN YZ9-F6\nCAPITAL RESPONSE — GET IN FLEET NOW\nHomeguard comms'],
  [8.1,  'capbot',    'opt-in',   'yan',   'Called in the capital umbrella to save a Ferox fleet. 3 dreads down, 21b destroyed for 1.4b lost.\n\nThanks for the fast undock everyone!'],
  [11.0, 'opsbot',    'all',      'rau',   'Ferox fleet for the structure timer in 319-3D. Armour timer comes out in 90 minutes.', { fc: 'rau', formup: '1DQ1-A', pap: 'Strategic', comms: 5, doctrine: 'ferox' }],
  [14.6, 'infra',     'all',      'olk',   'Starting maintenance on the comms server — downtime about 15 minutes, back before the op.'],
  [19.3, 'homeguard', 'homeguard','tera',  'HOMEGUARD: YELLOW — YELLOW — YELLOW\n\nHostile gang 2 jumps out, 30 pilots in Sabres and Muninns. Align to the citadel and be ready to dock.\nMORE COVER TO HOMEGUARD\nShips: ' + DOCTRINE.cover],
  [20.1, 'homeguard', 'homeguard','tera',  'HOMEGUARD: GREEN — the gang has left the region. Back to work.'],
  [26.0, 'roambot',   'all',      'rako',  'Late night gaming :P\nWe found a juicy wormhole to content — Crusaders, form up now.', { fc: 'rako', formup: '1DQ1-A', pap: 'Peacetime', comms: 10, doctrine: 'crusader' }],
  [31.4, 'scoutbot',  'scouts',   'ari',   'Hello scouts! Intel channel rules have been updated — please re-read them before your next shift:\nhttps://forum.' + DOMAIN + '/topic/2118-intel-channel-rules/\n\nQuestions go in the scouts room.'],
  [36.2, 'opsbot',    'all',      'kaska', 'Harpy fleet — trash to take out on the 5BTK-M gate.', { fc: 'kaska', formup: '1DQ1-A', pap: 'Strategic', comms: 12, doctrine: 'harpy' }],
  [42.0, 'relay',     'opt-in',   'olk',   'WE ARE LIVE!\n\nVaelin TV is streaming Alliance Tournament practice night. Drop by, say hi, and heckle the theorycrafters.\n\nWatch here: https://tv.' + DOMAIN + '/live'],
  [49.5, 'infra',     'miners',   'ari',   'Cool rocks fact: most commercially used zeolites are made synthetically — they come out more uniform and pure.\n\nAnyway, the belt fleet is up.', { fc: 'ari', formup: '1DQ1-A', comms: 'Mining 1', doctrine: 'mining' }],
  [55.0, 'opsbot',    'all',      'rau',   'CTA — structure defence in 1DQ1-A. Everyone in fleet, every doctrine welcome, no excuses.', { fc: 'rau', formup: '1DQ1-A', pap: 'Strategic', comms: 3, doctrine: 'muninn' }],
  [56.4, 'opsbot',    'all',      'rau',   'CTA debrief: 42b destroyed, 0 structures lost. Thank you to the 260 pilots who undocked.'],
  [63.0, 'roambot',   'all',      'yan',   'Bomber roam — sign up in the bombers room, form up on the titan in 30.', { fc: 'yan', formup: '1DQ1-A', pap: 'Peacetime', comms: 8, doctrine: 'bombers' }],
  [70.2, 'capbot',    'caps',     'yan',   'Capital move op tonight 21:00 — staging to 319-3D. Fuel up, check your jump fatigue.', { fc: 'yan', formup: '1DQ1-A', pap: 'Strategic', comms: 'Capital Ops', doctrine: 'caps' }],
  [77.8, 'homeguard', 'homeguard','tera',  'HOMEGUARD: GREEN\n\nKrabs: beacons can go up once the FC says go. Double-check fuel bays, ozone and strontium before leaving staging.\nFC: ' + FC.tera + '\nDoctrine: ' + DOCTRINE.cover],
  [86.0, 'opsbot',    'all',      'kaska', 'Muninn fleet for the sov timer in 23G-XC. Undock in 40.', { fc: 'kaska', formup: '1DQ1-A', pap: 'Strategic', comms: 4, doctrine: 'muninn' }],
  [94.3, 'infra',     'all',      'olk',   'Reminder: the forum calendar now has every op for the month — subscribe from the calendar page and EVE Carbon will pick it up.'],
  [101.0,'roambot',   'all',      'rako',  'Newbro fleet — free Retributions in the contracts, no experience needed!', { fc: 'rako', formup: '1DQ1-A', pap: 'Peacetime', comms: 11, doctrine: 'retri' }],
  [110.5,'scoutbot',  'scouts',   'ari',   'Scouts: we need eyes on the Fountain border this weekend. Sign up for a shift in the scouts room.'],
  [118.0,'opsbot',    'all',      'rau',   'Ferox fleet — hostile Ishtars ratting in our backyard. Let us go say hello.', { fc: 'rau', formup: '1DQ1-A', pap: 'Peacetime', comms: 6, doctrine: 'ferox' }],
  [126.4,'capbot',    'opt-in',   'yan',   'Dread bomb practice went perfectly. Next one is live. :)'],
  [133.0,'homeguard', 'homeguard','tera',  'HOMEGUARD: RED — DREADS ON THE BEACON, SIEGE DOWN AND GET SAFE NOW!'],
  [134.2,'homeguard', 'homeguard','tera',  'HOMEGUARD: GREEN — the drop has been cleaned up. 4 hostile dreads killed. Good work everyone.'],
  [148.0,'opsbot',    'all',      'kaska', 'Strategic op — staging move. Bring everything you can fly, we are not coming back for a while.', { fc: 'kaska', formup: '1DQ1-A', pap: 'Strategic', comms: 3, doctrine: 'muninn' }],
  [160.5,'infra',     'miners',   'ari',   'Moon fracture at 319-3D IV - Moon 1 — R64 chunk, the good stuff. Boosts on grid.', { fc: 'ari', formup: '319-3D', comms: 'Mining 2', doctrine: 'mining' }],
  [171.0,'relay',     'opt-in',   'olk',   'Vaelin TV live with Faction Warfare and giveaways — come hang out.\nhttps://tv.' + DOMAIN + '/live'],
  [184.0,'roambot',   'all',      'rako',  'Weekend roam! Hunters and interdictors wanted.', { fc: 'rako', formup: '1DQ1-A', pap: 'Peacetime', comms: 9, doctrine: 'retri' }],
  [196.0,'opsbot',    'all',      'rau',   'Harpy fleet for the Fountain border. Easy content, quick undock.', { fc: 'rau', formup: '1DQ1-A', pap: 'Peacetime', comms: 7, doctrine: 'harpy' }],
  [208.0,'capbot',    'caps',     'yan',   'Titans, supers and dreads on the field in YZ9-F6\nHOSTILE DREADS ON GRID\nCAPITAL COMMS NOW'],
];

const pad = (n, w = 2) => String(n).padStart(w, '0');
function eveTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}412`;
}

/** Broadcasts in insertJabberMessage's input shape, oldest first. */
function broadcasts(now = Date.now()) {
  return BROADCASTS.slice().reverse().map(([hoursAgo, sig, target, who, text, f]) => {
    const at = now - hoursAgo * HOUR;
    const name = FC[who] || who;
    const lines = [text, ''];
    if (f) {
      lines.push(`FC Name: ${FC[f.fc] || f.fc}`, `Formup Location: ${f.formup}`);
      if (f.pap) lines.push(`PAP Type: ${f.pap}`);
      lines.push(`Comms: ${typeof f.comms === 'number' ? COMMS(f.comms) : `${f.comms} https://comms.${DOMAIN}/${handle(String(f.comms))}`}`);
      lines.push(`Doctrine: ${DOCTRINE[f.doctrine] || f.doctrine}`, '');
    }
    lines.push(`~~~ This was a ${sig} broadcast from ${handle(name)} to ${target} at ${eveTime(at)} EVE ~~~`);
    return {
      from: `${sig}@${DOMAIN}`, type: 'chat', isDirector: true,
      body: lines.join('\n'), receivedAt: new Date(at).toISOString(),
    };
  });
}

// ── Chat rooms ───────────────────────────────────────────────────────────────
const CONF = `conference.${DOMAIN}`;
const ROOMS = [
  { jid: `vaelin-ops@${CONF}`,      name: 'Vaelin Ops',      subject: 'Strat op tonight 20:00 — Muninn / Scimitar. Read the doctrine post before you ask.' },
  { jid: `vaelin-industry@${CONF}`, name: 'Industry',        subject: 'Moon schedule is on the forum. Ore buyback: 92% Jita.' },
  { jid: `vaelin-newbros@${CONF}`,  name: 'Newbro Help',     subject: 'No question is stupid. Free Retributions in alliance contracts.' },
];

// [room index, minutes ago, speaker (FC key, 'me', or pool index), text]
const CHAT = [
  [0, 340, 'rau',  'timer in 319-3D is armour, not hull — 90 min from now'],
  [0, 336, 7,      'is it a fortizar or an astra?'],
  [0, 335, 'rau',  'astra. bring the ferox fit from the forum, not your own creation'],
  [0, 210, 'tera', 'cover fleet is up if anyone wants to rat while we wait'],
  [0, 95,  'me',   'Muninn fleet tonight, form up at 19:45 — doctrine only'],
  [0, 94,  12,     'logi slots open?'],
  [0, 93,  'me',   'two scimitar spots left, x up in fleet chat'],
  [0, 52,  31,     'x'],
  [0, 51,  44,     'x — scimitar'],
  [0, 40,  'kaska','anchor will be me, broadcasts for reps please'],
  [0, 12,  'rako', 'hostile sabre gang 3j out, nothing to worry about yet'],
  [0, 7,   'kaska','pinging now, undock in 25'],
  [1, 820, 'ari',  'fracture at T5ZI-S VII m3 is on the calendar for tonight'],
  [1, 812, 18,     'is the buyback still 92%?'],
  [1, 805, 'ari',  'yes, 92% Jita split for compressed'],
  [1, 300, 'indy', 'ran the numbers — Caracals are 31% margin at the current Jita sell'],
  [1, 296, 26,     'what are you building them with, ME10?'],
  [1, 294, 'indy', '10/20 BPO, Raitaru with T1 rigs. the cost index in 1DQ1 is low this week'],
  [1, 120, 33,     'anyone selling reactive metals? need 40k'],
  [1, 116, 'indy', 'I have 26k on the launchpad in 1DQ1-A I, contract incoming'],
  [2, 990, 50,     'how do I get into the strat op? I only have a frigate'],
  [2, 985, 'rako', 'grab a free Retribution from alliance contracts, fit is in the description'],
  [2, 980, 50,     'oh nice, thanks!'],
  [2, 400, 57,     'what does PAP mean on the pings?'],
  [2, 396, 'tera', 'participation link — strategic ops count towards your monthly requirement'],
  [2, 60,  64,     'is the newbro fleet still happening tomorrow?'],
  [2, 55,  'rako', 'yep, 19:00, same as always'],
];

function _nick(who) {
  if (who === 'me') return handle(CAST.main.name);
  if (who === 'indy') return handle(CAST.indy.name);
  if (typeof who === 'number') return handle(pilot(who).name);
  return handle(FC[who] || who);
}

/** Room messages in insertJabberMessage's input shape, oldest first. */
function roomMessages(now = Date.now()) {
  return CHAT.slice().sort((a, b) => b[1] - a[1]).map(([room, minsAgo, who, body], i) => ({
    from: `${ROOMS[room].jid}/${_nick(who)}`, type: 'groupchat', isDirector: false,
    roomJid: ROOMS[room].jid, senderNick: _nick(who), stanzaId: `demo-${room}-${1000 + i}`,
    body, receivedAt: new Date(now - minsAgo * MIN).toISOString(),
  }));
}

/** Who is in each room right now, for the occupant list. */
function occupants(jid) {
  const room = ROOMS.findIndex(r => r.jid === jid);
  if (room < 0) return [];
  const nicks = new Set(CHAT.filter(c => c[0] === room).map(c => _nick(c[2])));
  nicks.add(_nick('me'));
  return [...nicks].map((nick, i) => ({ nick, role: i === 0 ? 'moderator' : 'participant', affiliation: i === 0 ? 'admin' : 'member' }));
}

module.exports = { DOMAIN, CONF, ROOMS, broadcasts, roomMessages, occupants, handle };
