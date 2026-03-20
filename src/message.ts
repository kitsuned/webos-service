export interface PalmMessage {
	category(): string;
	method(): string;
	isSubscription(): boolean;
	uniqueToken(): string;
	token(): string;
	payload(): string;
	respond(serialized: string): string;
}

function joinCategoryWithMethod(pMessage: PalmMessage): string {
	let category = pMessage.category();

	// keep / as is; normalize /example -> /example/
	if (!category.endsWith('/')) {
		category += '/';
	}

	return category + pMessage.method();
}

export class Message<T extends Record<string, any>> {
	public readonly method: string;
	public readonly payload: T;

	public cancelled: boolean = false;

	protected constructor(public readonly ls2Message: PalmMessage) {
		this.method = joinCategoryWithMethod(ls2Message);
		this.payload = JSON.parse(ls2Message.payload());
	}

	public respond(message: Record<string, any>) {
		this.ls2Message.respond(JSON.stringify(message));
	}

	public static fromPalmMessage<T extends Record<string, any> = Record<string, any>>(
		pMessage: PalmMessage,
	) {
		return new Message<T>(pMessage);
	}
}
