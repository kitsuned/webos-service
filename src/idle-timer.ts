export class IdleTimer {
	private counter: number = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	public constructor(
		private readonly idleTimeout: number | null = null,
		private readonly onQuit: (() => void) | null = null,
	) {
		if (idleTimeout) {
			this.timer = setTimeout(this.tick.bind(this), idleTimeout * 1000);
		} else {
			// keep process alive by resuming stdin stream
			process.stdin.resume();
		}
	}

	public acquire() {
		this.counter++;

		if (this.timer !== null) {
			clearTimeout(this.timer);
		}
	}

	public release() {
		this.counter--;

		if (this.idleTimeout && this.counter === 0) {
			this.timer = setTimeout(this.tick.bind(this), this.idleTimeout * 1000);
		}
	}

	private tick() {
		this.onQuit?.();
	}
}
