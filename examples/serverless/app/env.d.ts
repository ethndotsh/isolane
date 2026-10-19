// What the app can call besides the web platform: the deployer's host API.
type HostApi = import('../src/host-api.ts').HostApi;
declare const getUser: HostApi['getUser'];
declare const track: HostApi['track'];
