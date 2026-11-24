import type net from 'node:net';
import { type Config } from './config.ts';
import type { Request } from './request.ts';
import { ResponseWriter } from './response.ts';
import { serve } from './conn.ts';

export type Handler = (request: Request, response: ResponseWriter) => Promise<void>;

export class Shared {
  readonly config: Config;
  readonly handler: Handler;
  stopping = false;
  active = 0;
  private stopWaiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(handler: Handler, config: Config) {
    this.handler = handler;
    this.config = config;
  }

  trackConnection(): () => void {
    this.active += 1;
    let dropped = false;
    return () => {
      if (dropped) {
        return;
      }
      dropped = true;
      this.active -= 1;
      if (this.active === 0) {
        for (const wake of this.idleWaiters) {
          wake();
        }
        this.idleWaiters = [];
      }
    };
  }

  stopAccepting(): void {
    this.stopping = true;
    for (const wake of this.stopWaiters) {
      wake();
    }
    this.stopWaiters = [];
  }

  async stopped(): Promise<void> {
    if (this.stopping) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.stopWaiters.push(resolve);
    });
  }

  async waitIdle(graceMs: number): Promise<boolean> {
    const started = Date.now();
    while (this.active > 0) {
      if (Date.now() - started >= graceMs) {
        return false;
      }
      await Promise.race([
        new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, graceMs - (Date.now() - started)))),
      ]);
    }
    return true;
  }
}

export class Server {
  private readonly shared: Shared;

  constructor(handler: Handler, config: Config) {
    this.shared = new Shared(handler, config);
  }

  config(): Config {
    return this.shared.config;
  }

  async serveStd(servers: net.Server[]): Promise<void> {
    const errors: Error[] = [];
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.on('connection', (socket) => {
              socket.setNoDelay(true);
              const release = this.shared.trackConnection();
              void serve(this.shared, socket, release).catch((error: Error) => {
                errors.push(error);
                this.shared.stopAccepting();
              });
            });
            server.on('error', (error) => {
              errors.push(error);
              this.shared.stopAccepting();
            });
            resolve();
          }),
      ),
    );
    await this.shared.stopped();
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  async shutdown(graceMs: number): Promise<boolean> {
    this.shared.stopAccepting();
    return this.shared.waitIdle(graceMs);
  }
}

export function shutdownSignal(): Promise<void> {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT'];
  return new Promise((resolve) => {
  const onSignal = () => {
      for (const signal of signals) {
        process.off(signal, onSignal);
      }
      resolve();
    };
    for (const signal of signals) {
      process.once(signal, onSignal);
    }
  });
}
