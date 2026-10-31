declare module 'homematic-xmlrpc' {
  interface Client {
    methodCall(method: string, params: unknown[], cb: (err: Error | null, value: unknown) => void): void;
  }
  interface Server {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): Server;
    httpServer: { close(cb?: () => void): void };
  }
  const xmlrpc: {
    createClient(opts: { host: string; port: number; path?: string }): Client;
    createServer(opts: { host?: string; port: number }, cb?: () => void): Server;
  };
  export = xmlrpc;
}
