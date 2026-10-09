import { Disposable } from 'vscode';

export class DisposableManager {
	private readonly disposablesByKey = new Map<unknown, Disposable[]>();

	add(key: unknown, ...disposables: Disposable[]) {
		let existing = this.disposablesByKey.get(key);

		if(existing) {
			existing.push(...disposables);
		} else {
			this.disposablesByKey.set(key, [...disposables]);
		}
	}

	dispose(key: unknown) {
		this.disposablesByKey.get(key)?.forEach(disposable => disposable.dispose());
		this.disposablesByKey.delete(key);
	}
}
