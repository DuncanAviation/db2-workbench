// Runs async work whose failure must be handled rather than thrown -- fire-and-forget work above
// all, where nothing awaits the promise to catch its rejection.
export class TryUtils {
	// Runs "options.try", handing any error to "options.onError" (or logging it when there isn't
	// one) instead of rejecting. The error passed on carries "options.context" in its message and the
	// original error as its cause. Resolves to try's result, or undefined when it failed.
	static async tryAsync<T>(options: TryUtils.TryAsyncOptions<T>): Promise<T | undefined> {
		try {
			return await options.try();
		} catch(error) {
			let wrapped = new Error(`There was an error with a promise, ${options.context}:`, {cause: error});

			try {
				if(options.onError) {
					await options.onError(wrapped);
				} else {
					console.error(wrapped);
				}
			} catch(handlerError) {
				console.error(handlerError);
			}

			return undefined;
		}
	}

	// Starts "options.promise" without waiting for it, handling its failure as tryAsync does.
	static forgetPromise<T>(options: TryUtils.ForgetPromiseOptions<T>): void {
		void TryUtils.tryAsync({try: options.promise, context: options.context, onError: options.onError});
	}
}

export namespace TryUtils {
	export interface TryAsyncOptions<T> {
		try: () => Promise<T>;
		// What was being attempted, for the error message.
		context: string;
		onError?: (error: Error) => unknown;
	}

	export interface ForgetPromiseOptions<T> {
		promise: () => Promise<T>;
		// What was being attempted, for the error message.
		context: string;
		onError?: (error: Error) => unknown;
	}
}
