import palmbus from 'palmbus';

import { readFileSync } from 'fs';
import { join } from 'path';

import { AsyncSink } from '@kitsuned/async-utils';

import { Message } from './message';
import { IdleTimer } from './idle-timer';

export type Executor<B, R> = (body: B) => AsyncGenerator<unknown, R> | Promise<R>;

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
	private readonly handle: palmbus.Handle;
	private readonly serviceId: string;
	private readonly idleTimer: IdleTimer;

	private readonly methods = new Map<string, Executor<any, any>>();

	public constructor(serviceId?: string, idleTimeout: number | null = null) {
		this.idleTimer = new IdleTimer(idleTimeout, this.handleQuit.bind(this));

		this.serviceId = serviceId ?? readServiceIdFromConfig();

		this.handle = new palmbus.Handle(this.serviceId);

		this.handle.addListener('request', this.handleRequest.bind(this));
	}

	public register<T, N extends Record<string, any> = Record<string, any>>(
		method: string,
		executor: Executor<T, N>,
	) {
		this.handle.registerMethod(...extractMethodPath(method));

		this.methods.set(method, executor);
	}

	public async* subscribe<T extends Record<string, any>>(
		uri: string,
		params: Record<string, any> = {},
	): AsyncGenerator<T, void> {
		const sink = new AsyncSink<T>();
		const subscription = this.handle.subscribe(uri, JSON.stringify(params));

		subscription.addListener('response', pMessage => {
			sink.push(Message.fromPalmMessage<T>(pMessage).payload);
		});

		this.idleTimer.acquire();

		try {
			yield* sink;
		} finally {
			subscription.cancel();
			this.idleTimer.release();
		}
	}

	public async oneshot<T extends Record<string, any>>(
		uri: string,
		params: Record<string, any> = {},
	): Promise<T> {
		const generator = this.subscribe<T>(uri, params);

		const { value } = await generator.next();

		await generator.return();

		return value!;
	}

	private handleRequest(pMessage: palmbus.Message): void {
		const message = Message.fromPalmMessage(pMessage);

		this.idleTimer.acquire();

		Promise.resolve(message.payload)
			.then(async body => {
				// Luna won't allow calls to unregistered methods
				const impl = this.methods.get(message.method)!;

				return this.drainExecutor(impl(body), message);
			})
			.catch(e => {
				console.error('Failed to handle message:', e);

				message.respond({
					returnValue: false,
					errorCode: -1,
					errorText: e instanceof Error ? e.message : String(e),
					errorStack: 'stack' in e.stack ? e.stack : null,
				});
			})
			.finally(() => this.idleTimer.release());
	}

	private async drainExecutor<B extends Record<string, any>, R>(executor: ReturnType<Executor<B, R>>, message: Message<B>) {
		if ('then' in executor) {
			message.respond({ returnValue: true, ...await executor });
		} else if (Symbol.asyncIterator in executor) {
			const isSubscription = message.payload.subscribe === true;

			let it: IteratorResult<any, R>;

			do {
				it = await executor.next();

				if (isSubscription || it.done) {
					message.respond({ returnValue: true, ...it.value });
				}
			} while (!it.done);
		} else {
			throw new Error(`Unknown handler signature for ${message.method}`);
		}
	}

	private handleQuit() {
		this.handle.unregister();

		process.nextTick(() => process.exit(0));
	}
}
