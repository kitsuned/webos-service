import palmbus from 'palmbus';

import { readFileSync } from 'fs';
import { join } from 'path';

import { AsyncSink } from '@kitsuned/async-utils';

import { Message } from './message';
import { IdleTimer } from './idle-timer';

type AnyRecord = Record<string, any>;

export type Executor<TReq extends AnyRecord, TResp extends AnyRecord, TNext extends AnyRecord> =
	(payload: TReq, message: Message<TReq>) =>
		AsyncGenerator<TNext, TResp> | Promise<TResp> | TResp;

function extractMethodPath(path: string): [string, string] {
	const lastSlashIndex = path.lastIndexOf('/');

	if (lastSlashIndex <= 0) {
		return ['/', path.slice(1)];
	}

	return [path.slice(0, lastSlashIndex), path.slice(lastSlashIndex + 1)];
}

function readServiceIdFromConfig(): string {
	const path = join(process.cwd(), './services.json');

	let config: { id?: string };

	try {
		config = JSON.parse(
			readFileSync(path, 'utf8'),
		);
	} catch {
		throw new Error('Failed to read "services.json" to get Service ID');
	}

	if (!config.id) {
		throw new Error('Service ID is missing in "services.json"');
	}

	return config.id;
}

export class Service {
	public readonly id: string;

	private readonly handle: palmbus.Handle;
	private readonly idleTimer: IdleTimer;

	private readonly methods = new Map<string, Executor<any, any, any>>();
	private readonly pending = new Map<string, Message<any>>();

	public constructor(
		serviceId?: string,
		idleTimeout: number | null = null,
		publicBus: boolean = false,
	) {
		this.idleTimer = new IdleTimer(idleTimeout, this.handleQuit.bind(this));

		this.id = serviceId ?? readServiceIdFromConfig();

		this.handle = new palmbus.Handle(this.id, publicBus);

		this.handle.addListener('request', this.handleRequest.bind(this));
		this.handle.addListener('cancel', this.handleCancel.bind(this));
	}

	public register<
		TReq extends AnyRecord,
		TResp extends AnyRecord = AnyRecord,
		TNext extends AnyRecord = AnyRecord,
	>(
		method: string,
		executor: Executor<TReq, TResp, TNext>,
	) {
		this.handle.registerMethod(...extractMethodPath(method));

		this.methods.set(method, executor);
	}

	public subscribe<T extends AnyRecord>(
		uri: string,
		params: AnyRecord,
		callback: (response: T) => void,
	): () => void {
		const subscription = this.handle.subscribe(uri, JSON.stringify(params));

		subscription.addListener('response', pMessage => {
			const message = Message.fromPalmMessage<T>(pMessage);

			callback(message.payload);
		});

		return () => subscription.cancel();
	}

	public async* stream<T extends AnyRecord>(
		uri: string,
		params: AnyRecord = { subscribe: true },
	): AsyncGenerator<T, void> {
		const sink = new AsyncSink<T>();
		const cancel = this.subscribe<T>(uri, params, payload => sink.push(payload));

		try {
			yield* sink;
		} finally {
			cancel();
		}
	}

	public async oneshot<T extends AnyRecord>(
		uri: string,
		params: AnyRecord = {},
	): Promise<T> {
		const generator = this.stream<T>(uri, params);

		const { value } = await generator.next();

		await generator.return();

		return value!.payload;
	}

	public unregister() {
		this.pending.clear();
		this.handle.unregister();
	}

	private async drainExecutor<
		TReq extends AnyRecord,
		TResp extends AnyRecord,
		TNext extends AnyRecord,
	>(
		executor: ReturnType<Executor<TReq, TResp, TNext>>,
		message: Message<TReq>,
	) {
		if (Symbol.asyncIterator in executor) {
			const isSubscription = message.payload.subscribe === true;

			let it: IteratorResult<TNext, TResp>;

			do {
				if (message.cancelled) {
					await executor.throw(new Error('Subscription cancelled'));
					break;
				}

				it = await executor.next();

				if (it.done) {
					message.respond({ returnValue: true, ...it.value });
				} else if (isSubscription) {
					message.respond(it.value);
				}
			} while (!it.done);

			return;
		}

		if ('then' in executor) {
			message.respond({ returnValue: true, ...await executor });

			return;
		}

		message.respond({ returnValue: true, ...executor });
	}

	private handleRequest(pMessage: palmbus.Message): void {
		const message = Message.fromPalmMessage(pMessage);

		// essential to receive 'cancel' event
		if (pMessage.isSubscription()) {
			this.handle.subscriptionAdd(pMessage.uniqueToken(), pMessage);

			this.pending.set(pMessage.uniqueToken(), message);
		}

		Promise.resolve(message)
			.then(async message => {
				// Luna won't allow calls to unregistered methods
				const impl = this.methods.get(message.method)!;

				this.idleTimer.acquire();

				return this.drainExecutor(impl(message.payload, message), message);
			})
			.catch(e => {
				message.respond({
					returnValue: false,
					errorCode: -1,
					errorText: e instanceof Error ? e.message : String(e),
					errorStack: 'stack' in e.stack ? String(e.stack) : null,
				});
			})
			.finally(() => {
				this.pending.delete(pMessage.uniqueToken());

				this.idleTimer.release();
			});
	}

	private handleCancel(pMessage: palmbus.Message): void {
		const token = pMessage.uniqueToken();

		const message = this.pending.get(token);

		if (message) {
			message.cancelled = true;
		}
	}

	private handleQuit() {
		this.handle.unregister();

		process.nextTick(() => process.exit(0));
	}
}
