import { Extension } from './extension.js';

import { Nullable } from './utils/nullable.js';

/**
 * Connection passwords, held in VS Code's SecretStorage (encrypted by the OS) so they survive a
 * restart. A password is removed only when a connect proves it wrong - see
 * DbConnections.establishConnection() - or replaced from the connection editor's Set Password.
 */
export class Secrets {
	constructor(private extension: Extension) {}

	private getKey(options: Secrets.StoreKey): string {
		if(options?.host == null || options.userName == null) {
			throw new Error('A secret needs a host and a user name');
		}

		return `${options.host}-${options.userName}`;
	}

	store(options: Secrets.StoreOptions): Promise<void> {
		if(options?.password == null) {
			throw new Error('A secret needs a password');
		}

		return Promise.resolve(this.extension.context.secrets.store(this.getKey(options), options.password));
	}

	async get(options: Secrets.StoreKey): Promise<Nullable<string>> {
		return Promise.resolve(this.extension.context.secrets.get(this.getKey(options)));
	}

	async delete(options: Secrets.StoreKey): Promise<void> {
		let key = this.getKey(options);
		await this.extension.context.secrets.delete(key);
	}
}

export namespace Secrets {
	export interface StoreKey {
		host: string;
		userName: string;
	}

	export interface StoreOptions extends StoreKey {
		password: string;
	}
}
