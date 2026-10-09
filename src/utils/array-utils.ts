// Array helpers for the operations the language has no one-liner for. Pure, so importable from
// webviews.
export class ArrayUtils {
	// "value" as an array: itself if it already is one, wrapped in one if it isn't, or empty if absent.
	static toArray<T>(value: T | T[] | null | undefined): T[] {
		if(value == null) {
			return [];
		}

		return Array.isArray(value) ? value : [value];
	}

	// Groups "array" by "keyMapper", keeping every element (or "valueMapper"'s result for it) that
	// shares a key, in order.
	static toMapOfArrays<T, K, V = T>(array: T[], keyMapper: (element: T) => K, valueMapper?: (element: T) => V): Map<K, V[]> {
		let map = new Map<K, V[]>();

		for(let element of array) {
			let key = keyMapper(element);
			let entries = map.get(key);

			if(!entries) {
				entries = [];
				map.set(key, entries);
			}

			entries.push(valueMapper ? valueMapper(element) : <V><unknown>element);
		}

		return map;
	}

	// Removes, in place, every element "condition" holds for, and returns the removed elements.
	static removeIf<T>(array: T[], condition: (element: T) => boolean): T[] {
		let removed: T[] = [];
		let kept: T[] = [];

		for(let element of array) {
			(condition(element) ? removed : kept).push(element);
		}

		array.splice(0, array.length, ...kept);
		return removed;
	}
}
