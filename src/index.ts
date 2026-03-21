import palmbus from 'palmbus';

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { AsyncSink } from '@kitsuned/async-utils';

import { Message } from './message';
import { IdleTimer } from './idle-timer';

type AnyRecord = Record<string, any>;

export type LunaErrorResponse = {
	returnValue: false;
	errorCode?: number;
	errorText: string;
};

export type LunaSuccessResponse<T> = { returnValue?: true } & T;

export type LunaResponse<T extends AnyRecord> = LunaSuccessResponse<T> | LunaErrorResponse;

export type Executor<TReq extends AnyRecord, TResp extends AnyRecord | void, TNext extends AnyRecord> =
	(payload: TReq, message: Message<TReq>) =>
		AsyncGenerator<TNext, TResp> | Promise<TResp> | TResp;

// it would be nice to export it as an external type-only package with isomorphic Luna client interface
export type Client = Pick<Service, 'oneshot' | 'subscribe' | 'stream'> & {
	// technically palmbus service id may be null as well,
	// but why would anyone want to register such a handle?
	id: string | null;
};

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

export const isLegacyBus = existsSync('/var/run/ls2/ls-hubd.private.pid');

export class Service {
	public readonly id: string;

	private readonly handleOutbound: palmbus.Handle;
	private readonly handlePublic: palmbus.Handle;
	private readonly handlePrivate: palmbus.Handle;

	private readonly idleTimer: IdleTimer;

	private readonly methods = new Map<string, Executor<any, any, any>>();
	private readonly pending = new Map<string, Message<any>>();

	public constructor(
		serviceId?: string,
		idleTimeout: number | null = null,
		publicBus: boolean = true,
	) {
		this.idleTimer = new IdleTimer(idleTimeout, this.handleQuit.bind(this));

		this.id = serviceId ?? readServiceIdFromConfig();

		if (isLegacyBus) {
			this.handlePublic = new palmbus.Handle(this.id, true);
			this.handlePublic.addListener('request', this.handleRequest.bind(this));
			this.handlePublic.addListener('cancel', this.handleCancel.bind(this));

			this.handlePrivate = new palmbus.Handle(this.id, false);
			this.handlePrivate.addListener('request', this.handleRequest.bind(this));
			this.handlePrivate.addListener('cancel', this.handleCancel.bind(this));
		} else {
			const handle = new palmbus.Handle(this.id);

			handle.addListener('request', this.handleRequest.bind(this));
			handle.addListener('cancel', this.handleCancel.bind(this));

			this.handlePublic = handle;
			this.handlePrivate = handle;
		}

		this.handleOutbound = publicBus ? this.handlePublic : this.handlePrivate;
	}

	public register<
		TReq extends AnyRecord,
		TResp extends AnyRecord | void = AnyRecord | void,
		TNext extends AnyRecord = AnyRecord,
	>(
		method: string,
		executor: Executor<TReq, TResp, TNext>,
		{ bus = 'both' }: { bus?: 'public' | 'private' | 'both' } = {},
	) {
		if (bus === 'public') {
			this.handlePublic.registerMethod(...extractMethodPath(method));
		} else if (bus === 'private') {
			this.handlePrivate.registerMethod(...extractMethodPath(method));
		} else if (bus === 'both') {
			if (this.handlePublic !== this.handlePrivate) {
				this.handlePublic.registerMethod(...extractMethodPath(method));
			}
			this.handlePrivate.registerMethod(...extractMethodPath(method));
		}

		this.methods.set(method, executor);
	}

	public subscribe<T extends AnyRecord>(
		uri: string,
		params: AnyRecord,
		callback: (response: LunaResponse<T>) => void,
	): () => void {
		const subscription = this.handleOutbound.subscribe(uri, JSON.stringify(params));

		subscription.addListener('response', pMessage => {
			const message = Message.fromPalmMessage<T>(pMessage);

			callback(message.payload);
		});

		return () => subscription.cancel();
	}

	public async* stream<T extends AnyRecord>(
		uri: string,
		params: AnyRecord = { subscribe: true },
	): AsyncGenerator<LunaResponse<T>, void> {
		const sink = new AsyncSink<LunaResponse<T>>();
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
	): Promise<LunaResponse<T>> {
		const generator = this.stream<T>(uri, params);

		const { value } = await generator.next();

		await generator.return();

		return value!;
	}

	public unregister() {
		this.pending.clear();
		this.handleOutbound.unregister();
	}

	private async drainExecutor<
		TReq extends AnyRecord,
		TResp extends AnyRecord,
		TNext extends AnyRecord,
	>(
		executor: ReturnType<Executor<TReq, TResp, TNext>>,
		message: Message<TReq>,
	) {
		if (typeof executor !== 'object') {
			executor = {} as TResp;
		}

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
				} else if (isSubscription && it.value) {
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
			this.handleOutbound.subscriptionAdd(pMessage.uniqueToken(), pMessage);

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
				console.error('webos-service: handleRequest:', e);

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
		this.handleOutbound.unregister();

		process.nextTick(() => process.exit(0));
	}
}
