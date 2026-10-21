// What the app can use besides the web platform: the deployer's host API,
// as `env` (also isolane:env's export), and the handler's `ctx`.
type Env = import('../src/host-api.ts').HostApi;

interface ExecutionContext {
  /** Keep `promise` running after the response is sent. */
  waitUntil(promise: Promise<unknown>): void;
}

declare module 'isolane:env' {
  export const env: Env;
}
