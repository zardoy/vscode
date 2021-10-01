/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line code-import-patterns
import * as parcelWatcher from '@parcel/watcher';
import { existsSync } from 'fs';
import { RunOnceScheduler } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Emitter } from 'vs/base/common/event';
import { parse, ParsedPattern } from 'vs/base/common/glob';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { TernarySearchTree } from 'vs/base/common/map';
import { normalizeNFC } from 'vs/base/common/normalization';
import { dirname } from 'vs/base/common/path';
import { isLinux, isMacintosh, isWindows } from 'vs/base/common/platform';
import { realcaseSync, realpathSync } from 'vs/base/node/extpath';
import { FileChangeType } from 'vs/platform/files/common/files';
import { IWatcherService } from 'vs/platform/files/node/watcher/nsfw/watcher';
import { IDiskFileChange, ILogMessage, normalizeFileChanges, IWatchRequest } from 'vs/platform/files/node/watcher/watcher';
import { watchFolder } from 'vs/base/node/watcher';

interface IWatcher extends IDisposable {

	/**
	 * The Parcel watcher instance is resolved when the watching has started.
	 */
	readonly instance: Promise<parcelWatcher.AsyncSubscription | undefined>;

	/**
	 * The watch request associated to the watcher.
	 */
	request: IWatchRequest;

	/**
	 * Associated ignored patterns for the watcher that can be updated.
	 */
	ignored: ParsedPattern[];

	/**
	 * How often this watcher has been restarted in case of an unexpected
	 * shutdown.
	 */
	restarts: number;

	/**
	 * The cancellation token associated with the lifecycle of the watcher.
	 */
	token: CancellationToken;
}

export class ParcelWatcherService extends Disposable implements IWatcherService {

	private static readonly MAX_RESTARTS = 5; // number of restarts we allow before giving up in case of unexpected shutdown

	private static readonly MAP_PARCEL_WATCHER_ACTION_TO_FILE_CHANGE = new Map<parcelWatcher.EventType, number>(
		[
			['create', FileChangeType.ADDED],
			['update', FileChangeType.UPDATED],
			['delete', FileChangeType.DELETED],
		]
	);

	private static readonly PARCEL_WATCHER_BACKEND = isWindows ? 'windows' : isLinux ? 'inotify' : 'fs-events';

	private readonly _onDidChangeFile = this._register(new Emitter<IDiskFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _onDidLogMessage = this._register(new Emitter<ILogMessage>());
	readonly onDidLogMessage = this._onDidLogMessage.event;

	protected readonly watchers = new Map<string, IWatcher>();

	private verboseLogging = false;
	private enospcErrorLogged = false;

	constructor() {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {

		// Error handling on process
		process.on('uncaughtException', error => this.onError(error));
		process.on('unhandledRejection', error => this.onError(error));
	}

	async watch(requests: IWatchRequest[]): Promise<void> {

		// Figure out duplicates to remove from the requests
		const normalizedRequests = this.normalizeRequests(requests);

		// Gather paths that we should start watching
		const requestsToStartWatching = normalizedRequests.filter(request => {
			return !this.watchers.has(request.path);
		});

		// Gather paths that we should stop watching
		const pathsToStopWatching = Array.from(this.watchers.keys()).filter(watchedPath => {
			return !normalizedRequests.find(normalizedRequest => normalizedRequest.path === watchedPath);
		});

		// Logging
		this.debug(`Request to start watching: ${requestsToStartWatching.map(request => `${request.path} (excludes: ${request.excludes})`).join(',')}`);
		this.debug(`Request to stop watching: ${pathsToStopWatching.join(',')}`);

		// Stop watching as instructed
		for (const pathToStopWatching of pathsToStopWatching) {
			this.stopWatching(pathToStopWatching);
		}

		// Start watching as instructed
		for (const request of requestsToStartWatching) {
			this.startWatching(request);
		}

		// Update ignore rules for all watchers
		for (const request of normalizedRequests) {
			const watcher = this.watchers.get(request.path);
			if (watcher) {
				watcher.request = request;
				watcher.ignored = this.toExcludePatterns(request.excludes);
			}
		}
	}

	private toExcludePatterns(excludes: string[] | undefined): ParsedPattern[] {
		return Array.isArray(excludes) ? excludes.map(exclude => parse(exclude)) : [];
	}

	private startWatching(request: IWatchRequest, restarts = 0): void {
		const cts = new CancellationTokenSource();

		let parcelWatcherPromiseResolve: (watcher: parcelWatcher.AsyncSubscription | undefined) => void;
		const instance = new Promise<parcelWatcher.AsyncSubscription | undefined>(resolve => parcelWatcherPromiseResolve = resolve);

		// Remember as watcher instance
		const watcher: IWatcher = {
			request,
			instance,
			ignored: this.toExcludePatterns(request.excludes),
			restarts,
			token: cts.token,
			dispose: () => {
				cts.dispose(true);
				instance.then(instance => instance?.unsubscribe());
			}
		};
		this.watchers.set(request.path, watcher);

		// Path checks for symbolic links / wrong casing
		const { realBasePathDiffers, realBasePathLength } = this.checkRequest(request);

		let undeliveredFileEvents: IDiskFileChange[] = [];

		const onRawFileEvent = (path: string, type: FileChangeType) => {
			if (!this.isPathIgnored(path, watcher.ignored)) {
				undeliveredFileEvents.push({ type, path });
			} else if (this.verboseLogging) {
				this.log(` >> ignored ${path}`);
			}
		};

		parcelWatcher.subscribe(request.path, (error, events) => {
			if (watcher.token.isCancellationRequested) {
				return; // return early when disposed
			}

			if (error) {
				// TODO@watcher what error can this be?
				this.error(`Unexpected error in event callback: ${toErrorMessage(error)}`, watcher);
			}

			if (events.length === 0) {
				return; // this can happen if we had an error before
			}

			for (const event of events) {

				// Log the raw event before normalization or checking for ignore patterns
				if (this.verboseLogging) {
					this.log(`${event.type === 'create' ? '[CREATED]' : event.type === 'delete' ? '[DELETED]' : '[CHANGED]'} ${event.path}`);
				}

				onRawFileEvent(event.path, ParcelWatcherService.MAP_PARCEL_WATCHER_ACTION_TO_FILE_CHANGE.get(event.type)!);
			}

			// Reset undelivered events array
			const undeliveredFileEventsToEmit = undeliveredFileEvents;
			undeliveredFileEvents = [];

			// Broadcast to clients normalized
			const normalizedEvents = normalizeFileChanges(this.normalizeEvents(undeliveredFileEventsToEmit, request, realBasePathDiffers, realBasePathLength));
			this.emitEvents(normalizedEvents);
		}, {
			backend: ParcelWatcherService.PARCEL_WATCHER_BACKEND,
			ignore: watcher.request.excludes // TODO@watcher this cannot be updated dynamically it seems
		}).then(async parcelWatcher => {
			this.debug(`Started watching: ${request.path}`);

			parcelWatcherPromiseResolve(parcelWatcher);
		}).catch(error => {
			this.onError(error);

			parcelWatcherPromiseResolve(undefined);
		});
	}

	private emitEvents(events: IDiskFileChange[]): void {

		// Send outside
		this._onDidChangeFile.fire(events);

		// Logging
		if (this.verboseLogging) {
			for (const event of events) {
				this.log(` >> normalized ${event.type === FileChangeType.ADDED ? '[ADDED]' : event.type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${event.path}`);
			}
		}
	}

	private checkRequest(request: IWatchRequest): { realBasePathDiffers: boolean, realBasePathLength: number } {
		let realBasePathDiffers = false;
		let realBasePathLength = request.path.length;

		// macOS: Parcel will report paths in their dereferenced and real casing
		// form, so we need to detect this early on to be able to rewrite the
		// file events to the original requested form.
		// Note: Other platforms do not seem to have these path issues.
		// TODO@watcher test this on all platforms to validate it still holds true
		if (isMacintosh) {
			try {

				// First check for symbolic link
				let realBasePath = realpathSync(request.path);

				// Second check for casing difference
				if (request.path === realBasePath) {
					realBasePath = (realcaseSync(request.path) || request.path);
				}

				if (request.path !== realBasePath) {
					realBasePathLength = realBasePath.length;
					realBasePathDiffers = true;

					this.warn(`correcting a path to watch that seems to be a symbolic link (original: ${request.path}, real: ${realBasePath})`);
				}
			} catch (error) {
				// ignore
			}
		}

		return { realBasePathDiffers, realBasePathLength };
	}

	private normalizeEvents(events: IDiskFileChange[], request: IWatchRequest, realBasePathDiffers: boolean, realBasePathLength: number): IDiskFileChange[] {
		if (isMacintosh) {
			for (const event of events) {

				// Mac uses NFD unicode form on disk, but we want NFC
				event.path = normalizeNFC(event.path);

				// Convert paths back to original form in case it differs
				if (realBasePathDiffers) {
					event.path = request.path + event.path.substr(realBasePathLength);
				}
			}
		}

		return events;
	}

	private onError(error: unknown, watcher?: IWatcher): void {
		const msg = toErrorMessage(error);

		// Specially handle ENOSPC errors that can happen when
		// the watcher consumes so many file descriptors that
		// we are running into a limit. We only want to warn
		// once in this case to avoid log spam.
		// See https://github.com/microsoft/vscode/issues/7950
		if (msg.indexOf('No space left on device') !== -1) {
			if (!this.enospcErrorLogged) {
				this.error('Inotify limit reached (ENOSPC)', watcher);

				this.enospcErrorLogged = true;
			}
		}

		// Any other error is unexpected and we should try to
		// restart the watcher as a result to get into healthy
		// state again.
		else {
			const handled = this.onUnexpectedError(msg, watcher);
			if (!handled) {
				this.error(`Unexpected error: ${msg} (ESHUTDOWN)`, watcher);
			}
		}
	}

	private onUnexpectedError(error: string, watcher?: IWatcher): boolean {
		if (!watcher || watcher.restarts >= ParcelWatcherService.MAX_RESTARTS) {
			return false; // we need a watcher that has not been restarted MAX_RESTARTS times already
		}

		let handled = false;

		// Just try to restart watcher now if the path still exists
		if (existsSync(watcher.request.path)) {
			this.warn(`Watcher will be restarted due to unexpected error: ${error}`, watcher);
			this.restartWatching(watcher);

			handled = true;
		}

		// Otherwise try to monitor the path coming back before
		// restarting the watcher
		else {
			handled = this.onWatchedPathDeleted(watcher);
		}

		return handled;
	}

	private onWatchedPathDeleted(watcher: IWatcher): boolean {
		this.warn('Watcher shutdown because watched path got deleted', watcher);

		// Send a manual event given we know the root got deleted
		this.emitEvents([{ path: watcher.request.path, type: FileChangeType.DELETED }]);

		const parentPath = dirname(watcher.request.path);
		if (existsSync(parentPath)) {
			const disposable = watchFolder(parentPath, (type, path) => {
				if (watcher.token.isCancellationRequested) {
					return; // return early when disposed
				}

				// Watcher path came back! Restart watching...
				if (path === watcher.request.path && (type === 'added' || type === 'changed')) {
					this.warn('Watcher restarts because watched path got created again', watcher);

					// Stop watching that parent folder
					disposable.dispose();

					// Send a manual event given we know the root got added again
					this.emitEvents([{ path: watcher.request.path, type: FileChangeType.ADDED }]);

					// Restart the file watching delayed
					this.restartWatching(watcher);
				}
			}, error => {
				// Ignore
			});

			// Make sure to stop watching when the watcher is disposed
			watcher.token.onCancellationRequested(() => disposable.dispose());

			return true; // handled
		}

		return false; // not handled
	}

	async stop(): Promise<void> {
		for (const [path] of this.watchers) {
			this.stopWatching(path);
		}

		this.watchers.clear();
	}

	private restartWatching(watcher: IWatcher, delay = 800): void {

		// Restart watcher delayed to accomodate for
		// changes on disk that have triggered the
		// need for a restart in the first place.
		const scheduler = new RunOnceScheduler(() => {
			if (watcher.token.isCancellationRequested) {
				return; // return early when disposed
			}

			// Stop/start watcher counting the restarts
			this.stopWatching(watcher.request.path);
			this.startWatching(watcher.request, watcher.restarts + 1);
		}, delay);
		scheduler.schedule();
		watcher.token.onCancellationRequested(() => scheduler.dispose());
	}

	private stopWatching(path: string): void {
		const watcher = this.watchers.get(path);
		if (watcher) {
			watcher.dispose();
			this.watchers.delete(path);
		}
	}

	protected normalizeRequests(requests: IWatchRequest[]): IWatchRequest[] {
		const requestTrie = TernarySearchTree.forPaths<IWatchRequest>();

		// Sort requests by path length to have shortest first
		// to have a way to prevent children to be watched if
		// parents exist.
		requests.sort((requestA, requestB) => requestA.path.length - requestB.path.length);

		// Only consider requests for watching that are not
		// a child of an existing request path to prevent
		// duplication.
		//
		// However, allow explicit requests to watch folders
		// that are symbolic links because the Parcel watcher
		// does not allow to recursively watch symbolic links.
		for (const request of requests) {
			if (requestTrie.findSubstr(request.path)) {
				try {
					const realpath = realpathSync(request.path);
					if (realpath === request.path) {
						this.warn(`ignoring a path for watching who's parent is already watched: ${request.path}`);

						continue; // path is not a symbolic link or similar
					}
				} catch (error) {
					continue; // invalid path - ignore from watching
				}
			}

			requestTrie.set(request.path, request);
		}

		return Array.from(requestTrie).map(([, request]) => request);
	}

	private isPathIgnored(absolutePath: string, ignored: ParsedPattern[]): boolean {
		return ignored.some(ignore => ignore(absolutePath));
	}

	async setVerboseLogging(enabled: boolean): Promise<void> {
		this.verboseLogging = enabled;
	}

	private log(message: string) {
		this._onDidLogMessage.fire({ type: 'trace', message: this.toMessage(message) });
	}

	private warn(message: string, watcher?: IWatcher) {
		this._onDidLogMessage.fire({ type: 'warn', message: this.toMessage(message, watcher) });
	}

	private error(message: string, watcher: IWatcher | undefined) {
		this._onDidLogMessage.fire({ type: 'error', message: this.toMessage(message, watcher) });
	}

	private debug(message: string): void {
		this._onDidLogMessage.fire({ type: 'debug', message: this.toMessage(message) });
	}

	private toMessage(message: string, watcher?: IWatcher): string {
		return watcher ? `[File Watcher (parcel)] ${message} (path: ${watcher.request.path})` : `[File Watcher (parcel)] ${message}`;
	}
}
