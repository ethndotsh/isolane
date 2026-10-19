// One deployer's WebSocket connection: it deploys apps and serves their
// host functions, which the platform calls remotely.

import type { WebSocket } from 'ws';
import { z } from 'zod';
import { FromDeployer, type Deploy, type ToDeployer } from './protocol.ts';

/** How long a remote host function may take. */
const CALL_TIMEOUT_MS = 5_000;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class DeployerConnection {
  readonly #socket: WebSocket;
  readonly #calls = new Map<number, PendingCall>();
  #nextId = 1;

  constructor(socket: WebSocket, onDeploy: (deploy: Deploy, from: DeployerConnection) => void, onClose: () => void) {
    this.#socket = socket;
    socket.on('message', (data) => this.#receive(data.toString(), onDeploy));
    socket.on('close', () => {
      for (const call of this.#calls.values()) call.reject(new Error('the deployer disconnected'));
      this.#calls.clear();
      onClose();
    });
  }

  send(message: ToDeployer): void {
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  /**
   * Call one of the deployer's host functions. `signal` (the isolane call
   * context's) aborts when the guest stops waiting; the deployer is told
   * to cancel.
   */
  call(name: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const done = () => {
        this.#calls.delete(id);
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        done();
        this.send({ type: 'cancel', id });
        reject(new Error(`${name} was cancelled`));
      };
      const timer = setTimeout(() => {
        done();
        this.send({ type: 'cancel', id });
        reject(new Error(`${name} timed out after ${CALL_TIMEOUT_MS} ms`));
      }, CALL_TIMEOUT_MS);
      signal.addEventListener('abort', abort, { once: true });
      this.#calls.set(id, {
        resolve: (value) => (done(), resolve(value)),
        reject: (error) => (done(), reject(error)),
      });
      this.send({ type: 'call', id, name, args });
    });
  }

  #receive(text: string, onDeploy: (deploy: Deploy, from: DeployerConnection) => void): void {
    let parsed;
    try {
      parsed = FromDeployer.safeParse(JSON.parse(text));
    } catch {
      return this.send({ type: 'error', message: 'messages must be JSON' });
    }
    if (!parsed.success) return this.send({ type: 'error', message: z.prettifyError(parsed.error) });
    const message = parsed.data;
    if (message.type === 'deploy') return onDeploy(message, this);
    const call = this.#calls.get(message.id);
    if (!call) return; // late reply to a cancelled call
    if (message.ok) call.resolve(message.value);
    else call.reject(new Error(message.error));
  }
}
