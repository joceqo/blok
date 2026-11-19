// Dev front against a deployed backend. Kept out of vite.config.mjs so the
// normal local-backend setup is untouched: there the proxy talks to
// 127.0.0.1:8080, where forwarding the browser's own Host and Origin is right.
//
// A deployed backend needs three rewrites the local one never does:
//  - Host and SNI must name the TLS host, or the certificate check fails.
//  - Origin must name it too: the server refuses any other one (403), and the
//    browser cannot send it. This stands in for adding the dev origin to the
//    server's ALLOWED_ORIGINS, and only ever runs on a developer's machine.
//  - Session cookies come back scoped to the deployed host; without rewriting
//    that scope the browser drops them and every call stays signed out.
import base from './vite.config.mjs';

const target = process.env.BLOK_API_URL || 'https://blok.tousamba.cloud';
const origin = new URL(target).origin;
const sendOrigin = (proxyReq) => proxyReq.setHeader('origin', origin);

export default {
  ...base,
  server: {
    ...base.server,
    host: '127.0.0.1',
    port: Number(process.env.PORT || 5176),
    proxy: Object.fromEntries(Object.entries(base.server.proxy).map(([path, rule]) => [
      path,
      {
        ...rule,
        target,
        changeOrigin: true,
        cookieDomainRewrite: '',
        configure: (proxy) => {
          proxy.on('proxyReq', sendOrigin);
          proxy.on('proxyReqWs', sendOrigin);
        },
      },
    ])),
  },
};
