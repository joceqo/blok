#!/usr/bin/env node
import { createHmac } from 'node:crypto';
import { shellRoomTickets, signedRoomTickets, startAllRooms, startJournalRoom, startWorkspaceRooms } from '../dist/journal-room.mjs';

const usage = 'Usage: BLOK_ROOM_SECRET=... blok-journal-room <directory> <documentId|--workspace|--all> <allowed-origin> [port]\n       BLOK_ROOM_CLOUD_ORIGIN=http://127.0.0.1:8080 INTERNAL_SECRET=... blok-journal-room <directory> <documentId|--workspace|--all> <allowed-origin> [port]\n       BLOK_ROOM_SECRET=... blok-journal-room --ticket <documentId> <actor> <read|write>';
const args = process.argv.slice(2);
try {
  if (args.length === 1 && ['--help','-h'].includes(args[0])) {
    console.log(usage);
  } else {
    const secret = process.env.BLOK_ROOM_SECRET ?? '';
    const shellOrigin = process.env.BLOK_ROOM_CLOUD_ORIGIN;
    if (args[0] === '--ticket' && args.length === 4 && ['read','write'].includes(args[3]) && args[1] && args[2]) {
      if (shellOrigin !== undefined) throw new Error('Use the cloud ticket endpoint in shell mode');
      signedRoomTickets(secret);
      const json = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const jwt = json({alg:'HS256',typ:'JWT'}) + '.' + json({
        user:args[2], doc:args[1], write:args[3] === 'write', exp:Math.floor(Date.now()/1000)+300,
      });
      console.log(jwt + '.' + createHmac('sha256',secret).update(jwt).digest('base64url'));
    } else if ((args.length === 3 || args.length === 4) && !args[0].startsWith('-')) {
      const [directory,documentId,origin,rawPort='18102'] = args;
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid preview port');
      const workspace = documentId === '--workspace';
      const all = documentId === '--all';
      if (all && (!shellOrigin || process.env.BLOK_NODE_ROOM_PAGE || process.env.BLOK_NODE_ROOM_WORKSPACE)) throw new Error('All-workspace mode requires the shell access service and no page or workspace selection');
      const workspaceId = process.env.BLOK_NODE_ROOM_WORKSPACE;
      if (workspace && (!workspaceId || !shellOrigin || process.env.BLOK_NODE_ROOM_PAGE)) throw new Error('Workspace mode requires one workspace and the shell access service');
      if (!workspace && workspaceId) throw new Error('Select --workspace to use workspace ownership');
      const authorize = shellOrigin === undefined ? signedRoomTickets(secret) : shellRoomTickets(shellOrigin, process.env.INTERNAL_SECRET ?? '', workspace ? workspaceId : undefined);
      const projectionOrigin = process.env.BLOK_ROOM_PROJECTION_ORIGIN;
      if (projectionOrigin && !shellOrigin) throw new Error('Canonical storage requires cloud authorization');
      const projection = projectionOrigin ? { origin:projectionOrigin, secret:process.env.INTERNAL_SECRET ?? '' } : undefined;
      const additional = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s=>s.trim()).filter(Boolean);
      const listenHost = process.env.BLOK_ROOM_LISTEN_HOST ?? '127.0.0.1';
      if (!['127.0.0.1','0.0.0.0'].includes(listenHost) || listenHost==='0.0.0.0' && !shellOrigin) throw new Error('Invalid room listen address');
      const options = { directory, allowedOrigins:new Set([origin,...additional]), port, authorize, listenHost,
        recheckSecret:shellOrigin ? process.env.INTERNAL_SECRET : undefined };
      const room = all ? await startAllRooms({...options,projection}) : workspace
        ? await startWorkspaceRooms({...options,workspaceId,projection})
        : await startJournalRoom({...options,documentId,projection});
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
