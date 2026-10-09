import { Nullable } from './nullable.js';

export class ObjectComparator<T extends object> {
	private _object1: T;
	private _object2: T;
	private _differences: Nullable<(keyof T)[]>;

	constructor(object1: T, object2: T) {
		this._object1 = object1;
		this._object2 = object2;
	}

	get object1(): T {
		return this._object1;
	}

	get object2(): T {
		return this._object2;
	}

	get differences(): (keyof T)[] {
		if(this._differences == null) {
			if(this.object1 == null && this.object2 == null) {
				return [];
			}
	
			if(this.object1 == null) {
				return <(keyof T)[]>Object.keys(this.object2);
			}
	
			if(this.object2 == null) {
				return <(keyof T)[]>Object.keys(this.object1);
			}
	
			let allKeys = <Array<keyof T>>Array.from(new Set([...Object.keys(this.object1), ...Object.keys(this.object2)]));

			this._differences = allKeys
				.filter(key => this.object1[key] !== this.object2[key]);
		}
		
		return this._differences;
	}

	get hasDifferences(): boolean {
		return this.differences.length > 0;
	}

	hasDifference(...keys: (keyof T)[]): boolean {
		if(keys.length === 0) {
			return false;
		}

		return this.differences.some(difference => keys.some(key => key === difference));
	}
}
