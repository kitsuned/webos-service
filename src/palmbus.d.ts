declare module 'palmbus' {
	export class Handle {
		constructor(busId: string, preAcgPublicBus?: boolean);

		call(uri: string, serialized: string): Call;
		subscribe(uri: string, serialized: string): Call;
		registerMethod(category: string, method: string): void;
		addListener(event: 'request', listener: (message: Message) => void): this;
		addListener(event: 'cancel', listener: (message: Message) => void): this;
		subscriptionAdd(uniqueToken: string, message: Message): void;
		unregister(): void;
	}

	export class Message {
		constructor(serialized: string, handle: Handle);

		category(): string;
		method(): string;
		isSubscription(): boolean;
		uniqueToken(): string;
		token(): string;
		payload(): string;
		respond(serialized: string): string;
	}

	export class Call {
		addListener(event: 'response', listener: (message: Message) => void): this;
		cancel(): void;
	}
}
