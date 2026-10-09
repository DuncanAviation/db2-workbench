import { Subscription } from 'rxjs';

// Holds rxjs subscriptions under an owner key, so the owner can drop all of its own at once.
export class SubscriptionManager {
	private readonly subscriptionsByKey = new Map<unknown, Subscription[]>();

	add(key: unknown, ...subscriptions: Subscription[]): void {
		let existing = this.subscriptionsByKey.get(key);

		if(existing) {
			existing.push(...subscriptions);
		} else {
			this.subscriptionsByKey.set(key, [...subscriptions]);
		}
	}

	unsubscribe(key: unknown): void {
		this.subscriptionsByKey.get(key)?.forEach(subscription => subscription.unsubscribe());
		this.subscriptionsByKey.delete(key);
	}
}
