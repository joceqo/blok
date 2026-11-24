#!/usr/bin/env node
import { createHmac } from 'node:crypto';
import { signedRoomTickets, startJournalRoom } from '../dist/journal-room.mjs';

const usage = 'Usage: BLOK_ROOM_SECRET=... blok-journal-room <directory> <documentId> <allowed-origin> [port]\n       BLOK_ROOM_SECRET=... blok-journal-room --ticket <documentId> <actor> <read|write>';
const args = process.argv.slice(2);
try {
  if (args.length === 1 && ['--help','-h'].includes(args[0])) {
    console.log(usage);
  } else {
    const secret = process.env.BLOK_ROOM_SECRET ?? '';
    const authorize = signedRoomTickets(secret);
    if (args[0] === '--ticket' && args.length === 4 && ['read','write'].includes(args[3]) && args[1] && args[2]) {
      const json = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const jwt = json({alg:'HS256',typ:'JWT'}) + '.' + json({
        user:args[2], doc:args[1], write:args[3] === 'write', exp:Math.floor(Date.now()/1000)+300,
      });
      console.log(jwt + '.' + createHmac('sha256',secret).update(jwt).digest('base64url'));
    } else if ((args.length === 3 || args.length === 4) && !args[0].startsWith('-')) {
      const [directory,documentId,origin,rawPort='18102'] = args;
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid preview port');
      const room = await startJournalRoom({directory,documentId,allowedOrigins:new Set([origin]),port,authorize});
      console.log(room.url);
      const stop = () => { void room.close().catch(err => { console.error(err.message); process.exitCode=1; }); };
      process.once('SIGTERM',stop);
      process.once('SIGINT',stop);
    } else {
      console.error(usage);
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
