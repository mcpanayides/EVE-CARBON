#!/usr/bin/env node
'use strict';
//
// Re-attribute chat-room messages that were filed as broadcasts.
//
// Until the routing fix, a message was only treated as room chat if THIS app had
// explicitly joined the room. Any other MUC the account sat in — a server
// auto-join, a room joined from another client — fell through into the ping
// pipeline and was stored with room_jid = NULL, which is what the broadcast feed
// selects. The feed then filled up with room chatter.
//
// New messages route correctly. This repairs what is already on disk.
//
//   node scripts/repair-jabber-feed.js            # report only, changes nothing
//   node scripts/repair-jabber-feed.js --apply    # back up, then repair
//
// A row is moved only when it is UNAMBIGUOUSLY room chat:
//   • msg_type = 'groupchat'  (the protocol saying so outright), or
//   • from_jid carries a resource AND sits on a conference/muc/chat host
// and never when it parsed as a real broadcast (sig, gsol_member, fc_name or
// formup_location present). A broadcast wrongly hidden is worse than a room
// message left in the feed, so every ambiguous row is left alone.
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

function defaultDbPath() {
  if (process.env.EVE_CARBON_JABBER_DB) return process.env.EVE_CARBON_JABBER_DB;
  const appData = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config');
  return path.join(appData, 'EVE Carbon', 'jabber_data.db');
}

// Room-shaped, and not something that parsed as a broadcast.
const ROOM_SHAPED = `
  (msg_type = 'groupchat'
   OR (instr(from_jid, '/') > 0
       AND (from_jid LIKE '%@conference.%' OR from_jid LIKE '%@muc.%' OR from_jid LIKE '%@chat.%')))`;
const NOT_A_BROADCAST = `
  (sig IS NULL AND gsol_member IS NULL AND fc_name IS NULL AND formup_location IS NULL)`;
const MISFILED = `room_jid IS NULL AND ${ROOM_SHAPED} AND ${NOT_A_BROADCAST}`;

(async () => {
  const apply  = process.argv.includes('--apply');
  const dbPath = process.argv.find(a => a.endsWith('.db')) || defaultDbPath();

  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`);
    console.error('Pass a path, or set EVE_CARBON_JABBER_DB.');
    process.exit(1);
  }

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  const count = async (where) =>
    (await db.get(`SELECT COUNT(*) c FROM jabber_messages WHERE ${where}`)).c;

  const total    = (await db.get('SELECT COUNT(*) c FROM jabber_messages')).c;
  const inFeed   = await count('room_jid IS NULL');
  const misfiled = await count(MISFILED);
  // Room-shaped but structured like a broadcast: deliberately left alone.
  const ambiguous = await count(`room_jid IS NULL AND ${ROOM_SHAPED} AND NOT ${NOT_A_BROADCAST}`);

  console.log(`database    ${dbPath}`);
  console.log(`total rows  ${total}`);
  console.log(`in feed     ${inFeed}`);
  console.log(`misfiled    ${misfiled}   room chat sitting in the broadcast feed`);
  console.log(`ambiguous   ${ambiguous}   room-shaped but parsed as a broadcast — left alone`);

  if (misfiled) {
    const rooms = await db.all(
      `SELECT lower(substr(from_jid, 1, instr(from_jid, '/') - 1)) AS room, COUNT(*) c
         FROM jabber_messages WHERE ${MISFILED} AND instr(from_jid, '/') > 0
        GROUP BY room ORDER BY c DESC LIMIT 15`);
    if (rooms.length) {
      console.log('\nrooms it came from:');
      for (const r of rooms) console.log(`  ${String(r.c).padStart(6)}  ${r.room || '(no room in JID)'}`);
    }
  }

  if (!apply) {
    console.log(misfiled
      ? '\nReport only. Re-run with --apply to repair (a backup is written first).'
      : '\nNothing to repair.');
    await db.close();
    return;
  }
  if (!misfiled) { console.log('\nNothing to repair.'); await db.close(); return; }

  // Back up before touching anything. The app must not be running: SQLite will
  // happily write into a database another process has open and the two views
  // then disagree until both are reopened.
  const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(dbPath, backup);
  console.log(`\nbackup      ${backup}`);

  const res = await db.run(`
    UPDATE jabber_messages
       SET room_jid    = lower(CASE WHEN instr(from_jid, '/') > 0
                                    THEN substr(from_jid, 1, instr(from_jid, '/') - 1)
                                    ELSE from_jid END),
           sender_nick = CASE WHEN instr(from_jid, '/') > 0
                              THEN substr(from_jid, instr(from_jid, '/') + 1)
                              ELSE sender_nick END
     WHERE ${MISFILED}`);

  const left = await count('room_jid IS NULL');
  console.log(`repaired    ${res.changes} row(s) moved out of the broadcast feed`);
  console.log(`feed now    ${left} row(s)`);
  console.log('\nRestart EVE Carbon to see the result.');
  await db.close();
})().catch(e => { console.error('repair failed:', e.message); process.exit(1); });
