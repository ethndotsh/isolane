// What the app can use besides the web platform: the deployer's host API,
// as isolane:env's `env`.
declare module 'isolane:env' {
  export const env: import('../src/host-api.ts').HostApi;
}
