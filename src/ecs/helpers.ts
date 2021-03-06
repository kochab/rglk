import * as EventEmitter from "eventemitter3";
import { EventQueue, RNG } from "rot-js";
import { Actor, EntityAction, Periodic } from "./entities";

/**
 * forEach callback for a set of AbortControllers. Triggers cancellation for all callbacks
 */
function cancelAll(controller: AbortController, _ignore: AbortController, set: Set<AbortController>) {
    controller.abort();
    set.delete(controller);
}

/**
 * Action executor
 */
export class ActionQueue implements Actor {
    /**
     * Action stack
     */
    protected readonly actions: EntityAction[] = [];

    /**
     * Wakeup notifier
     */
    protected readonly wakeup = new EventEmitter<'added'>();

    /**
     * Cancellation controllers to trigger before moving to next action
     */
    cancellation = new Set<AbortController>();

    /**
     * Action cap
     */
    cap = 1;

    async action(signal?: AbortSignal) {
        if (signal?.aborted) {
            this.cancel();
            return;
        }
        signal?.addEventListener('abort', () => this.cancel());
        // Pop the newest action, or block/wait until an action is available
        const action = this.actions.pop() ?? await new Promise(resolve => {
            this.wakeup.once('added', a => resolve(this.actions.pop() ?? a));
            signal?.addEventListener('abort', () => resolve(undefined));
        });
        if (action) {
            // stop older / less recent tasks which may already be running
            this.cancel();
            // create new cancellation token
            const controller = new AbortController;
            this.cancellation.add(controller);
            controller.signal.addEventListener('abort', () => this.cancellation.delete(controller));
            // do action
            await action(controller.signal).finally(() => this.cancellation.delete(controller));
        }
    }

    /**
     * Adds a turn action to the action stack
     * @param action action to add
     * @returns true if the action was added, false otherwise
     */
    push(action: EntityAction) {
        if (this.actions.length < this.cap) {
            this.actions.push(action);
            this.wakeup.emit('added');
            return true;
        }
        return false;
    }

    /**
     * Stop all running actions
     */
    cancel() {
        this.cancellation.forEach(cancelAll);
    }
}

/**
 * Closure alias
 */
interface Runnable {
    (): void;
}

/**
 * Timed callback executor
 */
export class Timer implements Periodic {
    protected readonly queue = new EventQueue<Runnable>();
    protected current: Runnable | null = null;
    protected elapsed: number = 0;

    tick(dt: number) {
        if (this.current ??= this.queue.get()) {
            this.elapsed += dt;
            if (this.elapsed >= this.queue.getTime()) {
                this.current();
                this.current = this.queue.get();
            }
        }
        return true;
    }

    /**
     * Returns a Promise that resolves after t seconds
     * @param t time in seconds
     */
    sleep(t: number) {
        return new Promise<void>(resolve => this.queue.add(resolve, t));
    }

    /**
     * Adds a task to the event queue
     * @param callback callback to execute
     * @param delay optional delay, delay is immediate execution
     */
    defer(callback: (signal: AbortSignal) => unknown, delay: number = 0) {
        const controller = new AbortController;
        const event = () => controller.signal.aborted || callback(controller.signal);
        this.queue.add(event, delay);
        controller.signal.addEventListener('abort', () => this.queue.remove(event));
        return controller;
    }
}

/**
 * Probabalistic action dispatcher events
 */
export type ProbabalisticActionEvent = 'thrown' | 'encored';

/**
 * Triggers N actions according to the cumulative product
 * of an N dimensional array of action probabilities
 */
export class ProbabalisticActionDispatcher implements Actor {
    /**
     * Events fired by this object
     */
    public readonly events = new EventEmitter<ProbabalisticActionEvent>();

    /**
     * Factory for probabilistic action dispatchers
     * @param actor actor to dispatch actions to
     * @param proba array of action probabilites
     */
    constructor(public actor: Actor, public proba: number[]) { }

    async action(signal?: AbortSignal) {
        let cumprod = 1;
        for (let i = 0, n = this.proba.length; i < n && !signal?.aborted; i++) {
            cumprod *= this.proba[i]!;
            if (RNG.getUniform() < cumprod) {
                this.events.emit('encored', i + 1);
                if (signal?.aborted) {
                    break;
                }
                try {
                    await this.actor.action(signal);
                } catch (e) {
                    this.events.emit('thrown', i + 1, e);
                }
            }
        }
    }
}