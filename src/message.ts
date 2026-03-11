import type palmbus from 'palmbus';

function joinCategoryWithMethod(pMessage: palmbus.Message): string {
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

	protected constructor(public readonly ls2Message: palmbus.Message) {
		this.method = joinCategoryWithMethod(ls2Message);
		this.payload = JSON.parse(ls2Message.payload());
	}

	public respond(message: Record<string, any>) {
		this.ls2Message.respond(JSON.stringify(message));
	}

	public static fromPalmMessage<T extends Record<string, any> = Record<string, any>>(
		pMessage: palmbus.Message,
	) {
		return new Message<T>(pMessage);
	}
}
