// The host API this example's deployer offers its app: the one place it's
// defined. The deployer implements it (src/deployer.ts), and the app is
// type-checked against it (app/env.d.ts).

export interface User {
  name: string;
  plan: 'free' | 'pro';
}

export interface HostApi {
  getUser(id: number): Promise<User | null>;
  track(event: string, id: number): Promise<void>;
}
