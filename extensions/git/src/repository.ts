/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as picomatch from 'picomatch';
import { CancellationToken, Command, Disposable, Event, EventEmitter, Memento, ProgressLocation, ProgressOptions, scm, SourceControl, SourceControlInputBox, SourceControlInputBoxValidation, SourceControlInputBoxValidationType, SourceControlResourceDecorations, SourceControlResourceGroup, SourceControlResourceState, ThemeColor, Uri, window, workspace, WorkspaceEdit, FileDecoration, commands, Tab, TabInputTextDiff, TabInputNotebookDiff, RelativePattern, CancellationTokenSource, LogOutputChannel, LogLevel, CancellationError, l10n } from 'vscode';
import TelemetryReporter from '@vscode/extension-telemetry';
import { Branch, Change, ForcePushMode, GitErrorCodes, LogOptions, Ref, RefType, Remote, Status, CommitOptions, BranchQuery, FetchOptions } from './api/git';
import { AutoFetcher } from './autofetch';
import { debounce, memoize, throttle } from './decorators';
import { Commit, GitError, Repository as BaseRepository, Stash, Submodule, LogFileOptions, PullOptions } from './git';
import { StatusBarCommands } from './statusbar';
import { toGitUri } from './uri';
import { anyEvent, combinedDisposable, debounceEvent, dispose, EmptyDisposable, eventToPromise, filterEvent, find, IDisposable, isDescendant, onceEvent, pathEquals, relativePath } from './util';
import { IFileWatcher, watch } from './watch';
import { IPushErrorHandlerRegistry } from './pushError';
import { ApiRepository } from './api/api1';
import { IRemoteSourcePublisherRegistry } from './remotePublisher';
import { ActionButtonCommand } from './actionButton';
import { IPostCommitCommandsProviderRegistry, CommitCommandsCenter } from './postCommitCommands';

const timeout = (millis: number) => new Promise(c => setTimeout(c, millis));

const iconsRootPath = path.join(path.dirname(__dirname), 'resources', 'icons');

function getIconUri(iconName: string, theme: string): Uri {
	return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}

export const enum RepositoryState {
	Idle,
	Disposed
}

export const enum ResourceGroupType {
	Merge,
	Index,
	WorkingTree,
	Untracked
}

export class Resource implements SourceControlResourceState {

	static getStatusText(type: Status) {
		switch (type) {
			case Status.INDEX_MODIFIED: return l10n.t('Index Modified');
			case Status.MODIFIED: return l10n.t('Modified');
			case Status.INDEX_ADDED: return l10n.t('Index Added');
			case Status.INDEX_DELETED: return l10n.t('Index Deleted');
			case Status.DELETED: return l10n.t('Deleted');
			case Status.INDEX_RENAMED: return l10n.t('Index Renamed');
			case Status.INDEX_COPIED: return l10n.t('Index Copied');
			case Status.UNTRACKED: return l10n.t('Untracked');
			case Status.IGNORED: return l10n.t('Ignored');
			case Status.INTENT_TO_ADD: return l10n.t('Intent to Add');
			case Status.BOTH_DELETED: return l10n.t('Conflict: Both Deleted');
			case Status.ADDED_BY_US: return l10n.t('Conflict: Added By Us');
			case Status.DELETED_BY_THEM: return l10n.t('Conflict: Deleted By Them');
			case Status.ADDED_BY_THEM: return l10n.t('Conflict: Added By Them');
			case Status.DELETED_BY_US: return l10n.t('Conflict: Deleted By Us');
			case Status.BOTH_ADDED: return l10n.t('Conflict: Both Added');
			case Status.BOTH_MODIFIED: return l10n.t('Conflict: Both Modified');
			default: return '';
		}
	}

	@memoize
	get resourceUri(): Uri {
		if (this.renameResourceUri && (this._type === Status.MODIFIED || this._type === Status.DELETED || this._type === Status.INDEX_RENAMED || this._type === Status.INDEX_COPIED)) {
			return this.renameResourceUri;
		}

		return this._resourceUri;
	}

	get leftUri(): Uri | undefined {
		return this.resources[0];
	}

	get rightUri(): Uri | undefined {
		return this.resources[1];
	}

	@memoize
	get command(): Command {
		return this._commandResolver.resolveDefaultCommand(this);
	}

	@memoize
	private get resources(): [Uri | undefined, Uri | undefined] {
		return this._commandResolver.getResources(this);
	}

	get resourceGroupType(): ResourceGroupType { return this._resourceGroupType; }
	get type(): Status { return this._type; }
	get original(): Uri { return this._resourceUri; }
	get renameResourceUri(): Uri | undefined { return this._renameResourceUri; }

	private static Icons: any = {
		light: {
			Modified: getIconUri('status-modified', 'light'),
			Added: getIconUri('status-added', 'light'),
			Deleted: getIconUri('status-deleted', 'light'),
			Renamed: getIconUri('status-renamed', 'light'),
			Copied: getIconUri('status-copied', 'light'),
			Untracked: getIconUri('status-untracked', 'light'),
			Ignored: getIconUri('status-ignored', 'light'),
			Conflict: getIconUri('status-conflict', 'light'),
		},
		dark: {
			Modified: getIconUri('status-modified', 'dark'),
			Added: getIconUri('status-added', 'dark'),
			Deleted: getIconUri('status-deleted', 'dark'),
			Renamed: getIconUri('status-renamed', 'dark'),
			Copied: getIconUri('status-copied', 'dark'),
			Untracked: getIconUri('status-untracked', 'dark'),
			Ignored: getIconUri('status-ignored', 'dark'),
			Conflict: getIconUri('status-conflict', 'dark')
		}
	};

	private getIconPath(theme: string): Uri {
		switch (this.type) {
			case Status.INDEX_MODIFIED: return Resource.Icons[theme].Modified;
			case Status.MODIFIED: return Resource.Icons[theme].Modified;
			case Status.INDEX_ADDED: return Resource.Icons[theme].Added;
			case Status.INDEX_DELETED: return Resource.Icons[theme].Deleted;
			case Status.DELETED: return Resource.Icons[theme].Deleted;
			case Status.INDEX_RENAMED: return Resource.Icons[theme].Renamed;
			case Status.INDEX_COPIED: return Resource.Icons[theme].Copied;
			case Status.UNTRACKED: return Resource.Icons[theme].Untracked;
			case Status.IGNORED: return Resource.Icons[theme].Ignored;
			case Status.INTENT_TO_ADD: return Resource.Icons[theme].Added;
			case Status.BOTH_DELETED: return Resource.Icons[theme].Conflict;
			case Status.ADDED_BY_US: return Resource.Icons[theme].Conflict;
			case Status.DELETED_BY_THEM: return Resource.Icons[theme].Conflict;
			case Status.ADDED_BY_THEM: return Resource.Icons[theme].Conflict;
			case Status.DELETED_BY_US: return Resource.Icons[theme].Conflict;
			case Status.BOTH_ADDED: return Resource.Icons[theme].Conflict;
			case Status.BOTH_MODIFIED: return Resource.Icons[theme].Conflict;
			default: throw new Error('Unknown git status: ' + this.type);
		}
	}

	private get tooltip(): string {
		return Resource.getStatusText(this.type);
	}

	private get strikeThrough(): boolean {
		switch (this.type) {
			case Status.DELETED:
			case Status.BOTH_DELETED:
			case Status.DELETED_BY_THEM:
			case Status.DELETED_BY_US:
			case Status.INDEX_DELETED:
				return true;
			default:
				return false;
		}
	}

	@memoize
	private get faded(): boolean {
		// TODO@joao
		return false;
		// const workspaceRootPath = this.workspaceRoot.fsPath;
		// return this.resourceUri.fsPath.substr(0, workspaceRootPath.length) !== workspaceRootPath;
	}

	get decorations(): SourceControlResourceDecorations {
		const light = this._useIcons ? { iconPath: this.getIconPath('light') } : undefined;
		const dark = this._useIcons ? { iconPath: this.getIconPath('dark') } : undefined;
		const tooltip = this.tooltip;
		const strikeThrough = this.strikeThrough;
		const faded = this.faded;
		return { strikeThrough, faded, tooltip, light, dark };
	}

	get letter(): string {
		switch (this.type) {
			case Status.INDEX_MODIFIED:
			case Status.MODIFIED:
				return 'M';
			case Status.INDEX_ADDED:
			case Status.INTENT_TO_ADD:
				return 'A';
			case Status.INDEX_DELETED:
			case Status.DELETED:
				return 'D';
			case Status.INDEX_RENAMED:
				return 'R';
			case Status.UNTRACKED:
				return 'U';
			case Status.IGNORED:
				return 'I';
			case Status.DELETED_BY_THEM:
				return 'D';
			case Status.DELETED_BY_US:
				return 'D';
			case Status.INDEX_COPIED:
				return 'C';
			case Status.BOTH_DELETED:
			case Status.ADDED_BY_US:
			case Status.ADDED_BY_THEM:
			case Status.BOTH_ADDED:
			case Status.BOTH_MODIFIED:
				return '!'; // Using ! instead of ⚠, because the latter looks really bad on windows
			default:
				throw new Error('Unknown git status: ' + this.type);
		}
	}

	get color(): ThemeColor {
		switch (this.type) {
			case Status.INDEX_MODIFIED:
				return new ThemeColor('gitDecoration.stageModifiedResourceForeground');
			case Status.MODIFIED:
				return new ThemeColor('gitDecoration.modifiedResourceForeground');
			case Status.INDEX_DELETED:
				return new ThemeColor('gitDecoration.stageDeletedResourceForeground');
			case Status.DELETED:
				return new ThemeColor('gitDecoration.deletedResourceForeground');
			case Status.INDEX_ADDED:
			case Status.INTENT_TO_ADD:
				return new ThemeColor('gitDecoration.addedResourceForeground');
			case Status.INDEX_COPIED:
			case Status.INDEX_RENAMED:
				return new ThemeColor('gitDecoration.renamedResourceForeground');
			case Status.UNTRACKED:
				return new ThemeColor('gitDecoration.untrackedResourceForeground');
			case Status.IGNORED:
				return new ThemeColor('gitDecoration.ignoredResourceForeground');
			case Status.BOTH_DELETED:
			case Status.ADDED_BY_US:
			case Status.DELETED_BY_THEM:
			case Status.ADDED_BY_THEM:
			case Status.DELETED_BY_US:
			case Status.BOTH_ADDED:
			case Status.BOTH_MODIFIED:
				return new ThemeColor('gitDecoration.conflictingResourceForeground');
			default:
				throw new Error('Unknown git status: ' + this.type);
		}
	}

	get priority(): number {
		switch (this.type) {
			case Status.INDEX_MODIFIED:
			case Status.MODIFIED:
			case Status.INDEX_COPIED:
				return 2;
			case Status.IGNORED:
				return 3;
			case Status.BOTH_DELETED:
			case Status.ADDED_BY_US:
			case Status.DELETED_BY_THEM:
			case Status.ADDED_BY_THEM:
			case Status.DELETED_BY_US:
			case Status.BOTH_ADDED:
			case Status.BOTH_MODIFIED:
				return 4;
			default:
				return 1;
		}
	}

	get resourceDecoration(): FileDecoration {
		const res = new FileDecoration(this.letter, this.tooltip, this.color);
		res.propagate = this.type !== Status.DELETED && this.type !== Status.INDEX_DELETED;
		return res;
	}

	constructor(
		private _commandResolver: ResourceCommandResolver,
		private _resourceGroupType: ResourceGroupType,
		private _resourceUri: Uri,
		private _type: Status,
		private _useIcons: boolean,
		private _renameResourceUri?: Uri,
	) { }

	async open(): Promise<void> {
		const command = this.command;
		await commands.executeCommand<void>(command.command, ...(command.arguments || []));
	}

	async openFile(): Promise<void> {
		const command = this._commandResolver.resolveFileCommand(this);
		await commands.executeCommand<void>(command.command, ...(command.arguments || []));
	}

	async openChange(): Promise<void> {
		const command = this._commandResolver.resolveChangeCommand(this);
		await commands.executeCommand<void>(command.command, ...(command.arguments || []));
	}

	clone() {
		return new Resource(this._commandResolver, this._resourceGroupType, this._resourceUri, this._type, this._useIcons, this._renameResourceUri);
	}
}

export const enum Operation {
	Status = 'Status',
	Config = 'Config',
	Diff = 'Diff',
	MergeBase = 'MergeBase',
	Add = 'Add',
	AddNoProgress = 'AddNoProgress',
	Remove = 'Remove',
	RevertFiles = 'RevertFiles',
	RevertFilesNoProgress = 'RevertFilesNoProgress',
	Commit = 'Commit',
	PostCommitCommand = 'PostCommitCommand',
	Clean = 'Clean',
	CleanNoProgress = 'CleanNoProgress',
	Branch = 'Branch',
	GetBranch = 'GetBranch',
	GetBranches = 'GetBranches',
	SetBranchUpstream = 'SetBranchUpstream',
	HashObject = 'HashObject',
	Checkout = 'Checkout',
	CheckoutTracking = 'CheckoutTracking',
	Reset = 'Reset',
	Remote = 'Remote',
	Fetch = 'Fetch',
	FetchNoProgress = 'FetchNoProgress',
	Pull = 'Pull',
	Push = 'Push',
	CherryPick = 'CherryPick',
	Sync = 'Sync',
	Show = 'Show',
	Stage = 'Stage',
	GetCommitTemplate = 'GetCommitTemplate',
	DeleteBranch = 'DeleteBranch',
	RenameBranch = 'RenameBranch',
	DeleteRef = 'DeleteRef',
	Merge = 'Merge',
	MergeAbort = 'MergeAbort',
	Rebase = 'Rebase',
	Ignore = 'Ignore',
	Tag = 'Tag',
	DeleteTag = 'DeleteTag',
	Stash = 'Stash',
	CheckIgnore = 'CheckIgnore',
	GetObjectDetails = 'GetObjectDetails',
	SubmoduleUpdate = 'SubmoduleUpdate',
	RebaseAbort = 'RebaseAbort',
	RebaseContinue = 'RebaseContinue',
	FindTrackingBranches = 'GetTracking',
	Apply = 'Apply',
	Blame = 'Blame',
	Log = 'Log',
	LogFile = 'LogFile',

	Move = 'Move'
}

function isReadOnly(operation: Operation): boolean {
	switch (operation) {
		case Operation.Blame:
		case Operation.CheckIgnore:
		case Operation.Diff:
		case Operation.FindTrackingBranches:
		case Operation.GetBranch:
		case Operation.GetCommitTemplate:
		case Operation.GetObjectDetails:
		case Operation.Log:
		case Operation.LogFile:
		case Operation.MergeBase:
		case Operation.Show:
			return true;
		default:
			return false;
	}
}

function shouldShowProgress(operation: Operation): boolean {
	switch (operation) {
		case Operation.AddNoProgress:
		case Operation.CleanNoProgress:
		case Operation.FetchNoProgress:
		case Operation.RevertFilesNoProgress:
		case Operation.CheckIgnore:
		case Operation.GetObjectDetails:
		case Operation.Show:
			return false;
		default:
			return true;
	}
}

export interface Operations {
	isIdle(): boolean;
	shouldShowProgress(): boolean;
	isRunning(operation: Operation): boolean;
}

class OperationsImpl implements Operations {

	private operations = new Map<Operation, number>();

	constructor(private readonly logger: LogOutputChannel) { }

	start(operation: Operation): void {
		this.logger.trace(`Operation start: ${operation}`);
		this.operations.set(operation, (this.operations.get(operation) || 0) + 1);
	}

	end(operation: Operation): void {
		this.logger.trace(`Operation end: ${operation}`);
		const count = (this.operations.get(operation) || 0) - 1;

		if (count <= 0) {
			this.operations.delete(operation);
		} else {
			this.operations.set(operation, count);
		}
	}

	isRunning(operation: Operation): boolean {
		return this.operations.has(operation);
	}

	isIdle(): boolean {
		const operations = this.operations.keys();

		for (const operation of operations) {
			if (!isReadOnly(operation)) {
				return false;
			}
		}

		return true;
	}

	shouldShowProgress(): boolean {
		const operations = this.operations.keys();

		for (const operation of operations) {
			if (shouldShowProgress(operation)) {
				return true;
			}
		}

		return false;
	}
}

export interface GitResourceGroup extends SourceControlResourceGroup {
	resourceStates: Resource[];
}

interface GitResourceGroups {
	indexGroup?: Resource[];
	mergeGroup?: Resource[];
	untrackedGroup?: Resource[];
	workingTreeGroup?: Resource[];
}

export interface OperationResult {
	operation: Operation;
	error: any;
}

class ProgressManager {

	private enabled = false;
	private disposable: IDisposable = EmptyDisposable;

	constructor(private repository: Repository) {
		const onDidChange = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('git', Uri.file(this.repository.root)));
		onDidChange(_ => this.updateEnablement());
		this.updateEnablement();

		this.repository.onDidChangeOperations(() => {
			// Disable input box when the commit operation is running
			this.repository.sourceControl.inputBox.enabled = !this.repository.operations.isRunning(Operation.Commit);
		});
	}

	private updateEnablement(): void {
		const config = workspace.getConfiguration('git', Uri.file(this.repository.root));

		if (config.get<boolean>('showProgress')) {
			this.enable();
		} else {
			this.disable();
		}
	}

	private enable(): void {
		if (this.enabled) {
			return;
		}

		const start = onceEvent(filterEvent(this.repository.onDidChangeOperations, () => this.repository.operations.shouldShowProgress()));
		const end = onceEvent(filterEvent(debounceEvent(this.repository.onDidChangeOperations, 300), () => !this.repository.operations.shouldShowProgress()));

		const setup = () => {
			this.disposable = start(() => {
				const promise = eventToPromise(end).then(() => setup());
				window.withProgress({ location: ProgressLocation.SourceControl }, () => promise);
			});
		};

		setup();
		this.enabled = true;
	}

	private disable(): void {
		if (!this.enabled) {
			return;
		}

		this.disposable.dispose();
		this.disposable = EmptyDisposable;
		this.enabled = false;
	}

	dispose(): void {
		this.disable();
	}
}

class FileEventLogger {

	private eventDisposable: IDisposable = EmptyDisposable;
	private logLevelDisposable: IDisposable = EmptyDisposable;

	constructor(
		private onWorkspaceWorkingTreeFileChange: Event<Uri>,
		private onDotGitFileChange: Event<Uri>,
		private logger: LogOutputChannel
	) {
		this.logLevelDisposable = logger.onDidChangeLogLevel(this.onDidChangeLogLevel, this);
		this.onDidChangeLogLevel(logger.logLevel);
	}

	private onDidChangeLogLevel(logLevel: LogLevel): void {
		this.eventDisposable.dispose();

		if (logLevel > LogLevel.Debug) {
			return;
		}

		this.eventDisposable = combinedDisposable([
			this.onWorkspaceWorkingTreeFileChange(uri => this.logger.debug(`[wt] Change: ${uri.fsPath}`)),
			this.onDotGitFileChange(uri => this.logger.debug(`[.git] Change: ${uri.fsPath}`))
		]);
	}

	dispose(): void {
		this.eventDisposable.dispose();
		this.logLevelDisposable.dispose();
	}
}

class DotGitWatcher implements IFileWatcher {

	readonly event: Event<Uri>;

	private emitter = new EventEmitter<Uri>();
	private transientDisposables: IDisposable[] = [];
	private disposables: IDisposable[] = [];

	constructor(
		private repository: Repository,
		private logger: LogOutputChannel
	) {
		const rootWatcher = watch(repository.dotGit.path);
		this.disposables.push(rootWatcher);

		// Ignore changes to the "index.lock" file, and watchman fsmonitor hook (https://git-scm.com/docs/githooks#_fsmonitor_watchman) cookie files.
		// Watchman creates a cookie file inside the git directory whenever a query is run (https://facebook.github.io/watchman/docs/cookies.html).
		const filteredRootWatcher = filterEvent(rootWatcher.event, uri => uri.scheme === 'file' && !/\/\.git(\/index\.lock)?$|\/\.watchman-cookie-/.test(uri.path));
		this.event = anyEvent(filteredRootWatcher, this.emitter.event);

		repository.onDidRunGitStatus(this.updateTransientWatchers, this, this.disposables);
		this.updateTransientWatchers();
	}

	private updateTransientWatchers() {
		this.transientDisposables = dispose(this.transientDisposables);

		if (!this.repository.HEAD || !this.repository.HEAD.upstream) {
			return;
		}

		this.transientDisposables = dispose(this.transientDisposables);

		const { name, remote } = this.repository.HEAD.upstream;
		const upstreamPath = path.join(this.repository.dotGit.commonPath ?? this.repository.dotGit.path, 'refs', 'remotes', remote, name);

		try {
			const upstreamWatcher = watch(upstreamPath);
			this.transientDisposables.push(upstreamWatcher);
			upstreamWatcher.event(this.emitter.fire, this.emitter, this.transientDisposables);
		} catch (err) {
			this.logger.warn(`Failed to watch ref '${upstreamPath}', is most likely packed.`);
		}
	}

	dispose() {
		this.emitter.dispose();
		this.transientDisposables = dispose(this.transientDisposables);
		this.disposables = dispose(this.disposables);
	}
}

class ResourceCommandResolver {

	constructor(private repository: Repository) { }

	resolveDefaultCommand(resource: Resource): Command {
		const config = workspace.getConfiguration('git', Uri.file(this.repository.root));
		const openDiffOnClick = config.get<boolean>('openDiffOnClick', true);
		return openDiffOnClick ? this.resolveChangeCommand(resource) : this.resolveFileCommand(resource);
	}

	resolveFileCommand(resource: Resource): Command {
		return {
			command: 'vscode.open',
			title: l10n.t('Open'),
			arguments: [resource.resourceUri]
		};
	}

	resolveChangeCommand(resource: Resource): Command {
		const title = this.getTitle(resource);

		if (!resource.leftUri) {
			const bothModified = resource.type === Status.BOTH_MODIFIED;
			if (resource.rightUri && workspace.getConfiguration('git').get<boolean>('mergeEditor', false) && (bothModified || resource.type === Status.BOTH_ADDED)) {
				return {
					command: 'git.openMergeEditor',
					title: l10n.t('Open Merge'),
					arguments: [resource.rightUri]
				};
			} else {
				return {
					command: 'vscode.open',
					title: l10n.t('Open'),
					arguments: [resource.rightUri, { override: bothModified ? false : undefined }, title]
				};
			}
		} else {
			return {
				command: 'vscode.diff',
				title: l10n.t('Open'),
				arguments: [resource.leftUri, resource.rightUri, title]
			};
		}
	}

	getResources(resource: Resource): [Uri | undefined, Uri | undefined] {
		for (const submodule of this.repository.submodules) {
			if (path.join(this.repository.root, submodule.path) === resource.resourceUri.fsPath) {
				return [undefined, toGitUri(resource.resourceUri, resource.resourceGroupType === ResourceGroupType.Index ? 'index' : 'wt', { submoduleOf: this.repository.root })];
			}
		}

		return [this.getLeftResource(resource), this.getRightResource(resource)];
	}

	private getLeftResource(resource: Resource): Uri | undefined {
		switch (resource.type) {
			case Status.INDEX_MODIFIED:
			case Status.INDEX_RENAMED:
			case Status.INDEX_ADDED:
				return toGitUri(resource.original, 'HEAD');

			case Status.MODIFIED:
			case Status.UNTRACKED:
				return toGitUri(resource.resourceUri, '~');

			case Status.DELETED_BY_US:
			case Status.DELETED_BY_THEM:
				return toGitUri(resource.resourceUri, '~1');
		}
		return undefined;
	}

	private getRightResource(resource: Resource): Uri | undefined {
		switch (resource.type) {
			case Status.INDEX_MODIFIED:
			case Status.INDEX_ADDED:
			case Status.INDEX_COPIED:
			case Status.INDEX_RENAMED:
				return toGitUri(resource.resourceUri, '');

			case Status.INDEX_DELETED:
			case Status.DELETED:
				return toGitUri(resource.resourceUri, 'HEAD');

			case Status.DELETED_BY_US:
				return toGitUri(resource.resourceUri, '~3');

			case Status.DELETED_BY_THEM:
				return toGitUri(resource.resourceUri, '~2');

			case Status.MODIFIED:
			case Status.UNTRACKED:
			case Status.IGNORED:
			case Status.INTENT_TO_ADD: {
				const uriString = resource.resourceUri.toString();
				const [indexStatus] = this.repository.indexGroup.resourceStates.filter(r => r.resourceUri.toString() === uriString);

				if (indexStatus && indexStatus.renameResourceUri) {
					return indexStatus.renameResourceUri;
				}

				return resource.resourceUri;
			}
			case Status.BOTH_ADDED:
			case Status.BOTH_MODIFIED:
				return resource.resourceUri;
		}

		return undefined;
	}

	private getTitle(resource: Resource): string {
		const basename = path.basename(resource.resourceUri.fsPath);

		switch (resource.type) {
			case Status.INDEX_MODIFIED:
			case Status.INDEX_RENAMED:
			case Status.INDEX_ADDED:
				return l10n.t('{0} (Index)', basename);

			case Status.MODIFIED:
			case Status.BOTH_ADDED:
			case Status.BOTH_MODIFIED:
				return l10n.t('{0} (Working Tree)', basename);

			case Status.INDEX_DELETED:
			case Status.DELETED:
				return l10n.t('{0} (Deleted)', basename);

			case Status.DELETED_BY_US:
				return l10n.t('{0} (Theirs)', basename);

			case Status.DELETED_BY_THEM:
				return l10n.t('{0} (Ours)', basename);

			case Status.UNTRACKED:
				return l10n.t('{0} (Untracked)', basename);

			default:
				return '';
		}
	}
}

export class Repository implements Disposable {

	private _onDidChangeRepository = new EventEmitter<Uri>();
	readonly onDidChangeRepository: Event<Uri> = this._onDidChangeRepository.event;

	private _onDidChangeState = new EventEmitter<RepositoryState>();
	readonly onDidChangeState: Event<RepositoryState> = this._onDidChangeState.event;

	private _onDidChangeStatus = new EventEmitter<void>();
	readonly onDidRunGitStatus: Event<void> = this._onDidChangeStatus.event;

	private _onDidChangeOriginalResource = new EventEmitter<Uri>();
	readonly onDidChangeOriginalResource: Event<Uri> = this._onDidChangeOriginalResource.event;

	private _onRunOperation = new EventEmitter<Operation>();
	readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

	private _onDidRunOperation = new EventEmitter<OperationResult>();
	readonly onDidRunOperation: Event<OperationResult> = this._onDidRunOperation.event;

	@memoize
	get onDidChangeOperations(): Event<void> {
		return anyEvent(this.onRunOperation as Event<any>, this.onDidRunOperation as Event<any>);
	}

	private _sourceControl: SourceControl;
	get sourceControl(): SourceControl { return this._sourceControl; }

	get inputBox(): SourceControlInputBox { return this._sourceControl.inputBox; }

	private _mergeGroup: SourceControlResourceGroup;
	get mergeGroup(): GitResourceGroup { return this._mergeGroup as GitResourceGroup; }

	private _indexGroup: SourceControlResourceGroup;
	get indexGroup(): GitResourceGroup { return this._indexGroup as GitResourceGroup; }

	private _workingTreeGroup: SourceControlResourceGroup;
	get workingTreeGroup(): GitResourceGroup { return this._workingTreeGroup as GitResourceGroup; }

	private _untrackedGroup: SourceControlResourceGroup;
	get untrackedGroup(): GitResourceGroup { return this._untrackedGroup as GitResourceGroup; }

	private _HEAD: Branch | undefined;
	get HEAD(): Branch | undefined {
		return this._HEAD;
	}

	private _refs: Ref[] = [];
	get refs(): Ref[] {
		return this._refs;
	}

	get headShortName(): string | undefined {
		if (!this.HEAD) {
			return;
		}

		const HEAD = this.HEAD;

		if (HEAD.name) {
			return HEAD.name;
		}

		const tag = this.refs.filter(iref => iref.type === RefType.Tag && iref.commit === HEAD.commit)[0];
		const tagName = tag && tag.name;

		if (tagName) {
			return tagName;
		}

		return (HEAD.commit || '').substr(0, 8);
	}

	private _remotes: Remote[] = [];
	get remotes(): Remote[] {
		return this._remotes;
	}

	private _submodules: Submodule[] = [];
	get submodules(): Submodule[] {
		return this._submodules;
	}

	private _rebaseCommit: Commit | undefined = undefined;

	set rebaseCommit(rebaseCommit: Commit | undefined) {
		if (this._rebaseCommit && !rebaseCommit) {
			this.inputBox.value = '';
		} else if (rebaseCommit && (!this._rebaseCommit || this._rebaseCommit.hash !== rebaseCommit.hash)) {
			this.inputBox.value = rebaseCommit.message;
		}

		const shouldUpdateContext = !!this._rebaseCommit !== !!rebaseCommit;
		this._rebaseCommit = rebaseCommit;

		if (shouldUpdateContext) {
			commands.executeCommand('setContext', 'gitRebaseInProgress', !!this._rebaseCommit);
		}
	}

	get rebaseCommit(): Commit | undefined {
		return this._rebaseCommit;
	}

	private _mergeInProgress: boolean = false;

	set mergeInProgress(value: boolean) {
		if (this._mergeInProgress === value) {
			return;
		}

		this._mergeInProgress = value;
		commands.executeCommand('setContext', 'gitMergeInProgress', value);
	}

	get mergeInProgress() {
		return this._mergeInProgress;
	}

	private _operations = new OperationsImpl(this.logger);
	get operations(): Operations { return this._operations; }

	private _state = RepositoryState.Idle;
	get state(): RepositoryState { return this._state; }
	set state(state: RepositoryState) {
		this._state = state;
		this._onDidChangeState.fire(state);

		this._HEAD = undefined;
		this._refs = [];
		this._remotes = [];
		this.mergeGroup.resourceStates = [];
		this.indexGroup.resourceStates = [];
		this.workingTreeGroup.resourceStates = [];
		this.untrackedGroup.resourceStates = [];
		this._sourceControl.count = 0;
	}

	get root(): string {
		return this.repository.root;
	}

	get dotGit(): { path: string; commonPath?: string } {
		return this.repository.dotGit;
	}

	private isRepositoryHuge: false | { limit: number } = false;
	private didWarnAboutLimit = false;

	private isBranchProtectedMatcher: picomatch.Matcher | undefined;
	private commitCommandCenter: CommitCommandsCenter;
	private resourceCommandResolver = new ResourceCommandResolver(this);
	private updateModelStateCancellationTokenSource: CancellationTokenSource | undefined;
	private disposables: Disposable[] = [];

	constructor(
		private readonly repository: BaseRepository,
		private pushErrorHandlerRegistry: IPushErrorHandlerRegistry,
		remoteSourcePublisherRegistry: IRemoteSourcePublisherRegistry,
		postCommitCommandsProviderRegistry: IPostCommitCommandsProviderRegistry,
		globalState: Memento,
		private readonly logger: LogOutputChannel,
		private telemetryReporter: TelemetryReporter
	) {
		const repositoryWatcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.file(repository.root), '**'));
		this.disposables.push(repositoryWatcher);

		const onRepositoryFileChange = anyEvent(repositoryWatcher.onDidChange, repositoryWatcher.onDidCreate, repositoryWatcher.onDidDelete);
		const onRepositoryWorkingTreeFileChange = filterEvent(onRepositoryFileChange, uri => !/\.git($|\/)/.test(relativePath(repository.root, uri.fsPath)));

		let onRepositoryDotGitFileChange: Event<Uri>;

		try {
			const dotGitFileWatcher = new DotGitWatcher(this, logger);
			onRepositoryDotGitFileChange = dotGitFileWatcher.event;
			this.disposables.push(dotGitFileWatcher);
		} catch (err) {
			logger.error(`Failed to watch path:'${this.dotGit.path}' or commonPath:'${this.dotGit.commonPath}', reverting to legacy API file watched. Some events might be lost.\n${err.stack || err}`);

			onRepositoryDotGitFileChange = filterEvent(onRepositoryFileChange, uri => /\.git($|\/)/.test(uri.path));
		}

		// FS changes should trigger `git status`:
		// 	- any change inside the repository working tree
		//	- any change whithin the first level of the `.git` folder, except the folder itself and `index.lock`
		const onFileChange = anyEvent(onRepositoryWorkingTreeFileChange, onRepositoryDotGitFileChange);
		onFileChange(this.onFileChange, this, this.disposables);

		// Relevate repository changes should trigger virtual document change events
		onRepositoryDotGitFileChange(this._onDidChangeRepository.fire, this._onDidChangeRepository, this.disposables);

		this.disposables.push(new FileEventLogger(onRepositoryWorkingTreeFileChange, onRepositoryDotGitFileChange, logger));

		const root = Uri.file(repository.root);
		this._sourceControl = scm.createSourceControl('git', 'Git', root);

		this._sourceControl.acceptInputCommand = { command: 'git.commit', title: l10n.t('Commit'), arguments: [this._sourceControl] };
		this._sourceControl.quickDiffProvider = this;
		this._sourceControl.inputBox.validateInput = this.validateInput.bind(this);
		this.disposables.push(this._sourceControl);

		this.updateInputBoxPlaceholder();
		this.disposables.push(this.onDidRunGitStatus(() => this.updateInputBoxPlaceholder()));

		this._mergeGroup = this._sourceControl.createResourceGroup('merge', l10n.t('Merge Changes'));
		this._indexGroup = this._sourceControl.createResourceGroup('index', l10n.t('Staged Changes'));
		this._workingTreeGroup = this._sourceControl.createResourceGroup('workingTree', l10n.t('Changes'));
		this._untrackedGroup = this._sourceControl.createResourceGroup('untracked', l10n.t('Untracked Changes'));

		const updateIndexGroupVisibility = () => {
			const config = workspace.getConfiguration('git', root);
			this.indexGroup.hideWhenEmpty = !config.get<boolean>('alwaysShowStagedChangesResourceGroup');
		};

		const onConfigListener = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('git.alwaysShowStagedChangesResourceGroup', root));
		onConfigListener(updateIndexGroupVisibility, this, this.disposables);
		updateIndexGroupVisibility();

		workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('git.mergeEditor')) {
				this.mergeGroup.resourceStates = this.mergeGroup.resourceStates.map(r => r.clone());
			}
		}, undefined, this.disposables);

		filterEvent(workspace.onDidChangeConfiguration, e =>
			e.affectsConfiguration('git.branchProtection', root)
			|| e.affectsConfiguration('git.branchSortOrder', root)
			|| e.affectsConfiguration('git.untrackedChanges', root)
			|| e.affectsConfiguration('git.ignoreSubmodules', root)
			|| e.affectsConfiguration('git.openDiffOnClick', root)
			|| e.affectsConfiguration('git.showActionButton', root)
		)(() => this.updateModelState(), this, this.disposables);

		const updateInputBoxVisibility = () => {
			const config = workspace.getConfiguration('git', root);
			this._sourceControl.inputBox.visible = config.get<boolean>('showCommitInput', true);
		};

		const onConfigListenerForInputBoxVisibility = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('git.showCommitInput', root));
		onConfigListenerForInputBoxVisibility(updateInputBoxVisibility, this, this.disposables);
		updateInputBoxVisibility();

		this.mergeGroup.hideWhenEmpty = true;
		this.untrackedGroup.hideWhenEmpty = true;

		this.disposables.push(this.mergeGroup);
		this.disposables.push(this.indexGroup);
		this.disposables.push(this.workingTreeGroup);
		this.disposables.push(this.untrackedGroup);

		// Don't allow auto-fetch in untrusted workspaces
		if (workspace.isTrusted) {
			this.disposables.push(new AutoFetcher(this, globalState));
		} else {
			const trustDisposable = workspace.onDidGrantWorkspaceTrust(() => {
				trustDisposable.dispose();
				this.disposables.push(new AutoFetcher(this, globalState));
			});
			this.disposables.push(trustDisposable);
		}

		// https://github.com/microsoft/vscode/issues/39039
		const onSuccessfulPush = filterEvent(this.onDidRunOperation, e => e.operation === Operation.Push && !e.error);
		onSuccessfulPush(() => {
			const gitConfig = workspace.getConfiguration('git');

			if (gitConfig.get<boolean>('showPushSuccessNotification')) {
				window.showInformationMessage(l10n.t('Successfully pushed.'));
			}
		}, null, this.disposables);

		const onDidChangeBranchProtection = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('git.branchProtection', root));
		onDidChangeBranchProtection(this.updateBranchProtectionMatcher, this, this.disposables);
		this.updateBranchProtectionMatcher();

		const statusBar = new StatusBarCommands(this, remoteSourcePublisherRegistry);
		this.disposables.push(statusBar);
		statusBar.onDidChange(() => this._sourceControl.statusBarCommands = statusBar.commands, null, this.disposables);
		this._sourceControl.statusBarCommands = statusBar.commands;

		this.commitCommandCenter = new CommitCommandsCenter(globalState, this, postCommitCommandsProviderRegistry);
		this.disposables.push(this.commitCommandCenter);

		const actionButton = new ActionButtonCommand(this, this.commitCommandCenter);
		this.disposables.push(actionButton);
		actionButton.onDidChange(() => this._sourceControl.actionButton = actionButton.button);
		this._sourceControl.actionButton = actionButton.button;

		const progressManager = new ProgressManager(this);
		this.disposables.push(progressManager);

		const onDidChangeCountBadge = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('git.countBadge', root));
		onDidChangeCountBadge(this.setCountBadge, this, this.disposables);
		this.setCountBadge();
	}

	validateInput(text: string, position: number): SourceControlInputBoxValidation | undefined {
		let tooManyChangesWarning: SourceControlInputBoxValidation | undefined;
		if (this.isRepositoryHuge) {
			tooManyChangesWarning = {
				message: l10n.t('Too many changes were detected. Only the first {0} changes will be shown below.', this.isRepositoryHuge.limit),
				type: SourceControlInputBoxValidationType.Warning
			};
		}

		if (this.rebaseCommit) {
			if (this.rebaseCommit.message !== text) {
				return {
					message: l10n.t('It\'s not possible to change the commit message in the middle of a rebase. Please complete the rebase operation and use interactive rebase instead.'),
					type: SourceControlInputBoxValidationType.Warning
				};
			}
		}

		const config = workspace.getConfiguration('git');
		const setting = config.get<'always' | 'warn' | 'off'>('inputValidation');

		if (setting === 'off') {
			return tooManyChangesWarning;
		}

		if (/^\s+$/.test(text)) {
			return {
				message: l10n.t('Current commit message only contains whitespace characters'),
				type: SourceControlInputBoxValidationType.Warning
			};
		}

		let lineNumber = 0;
		let start = 0;
		let match: RegExpExecArray | null;
		const regex = /\r?\n/g;

		while ((match = regex.exec(text)) && position > match.index) {
			start = match.index + match[0].length;
			lineNumber++;
		}

		const end = match ? match.index : text.length;

		const line = text.substring(start, end);

		let threshold = config.get<number>('inputValidationLength', 50);

		if (lineNumber === 0) {
			const inputValidationSubjectLength = config.get<number | null>('inputValidationSubjectLength', null);

			if (inputValidationSubjectLength !== null) {
				threshold = inputValidationSubjectLength;
			}
		}

		if (line.length <= threshold) {
			if (setting !== 'always') {
				return tooManyChangesWarning;
			}

			return {
				message: l10n.t('{0} characters left in current line', threshold - line.length),
				type: SourceControlInputBoxValidationType.Information
			};
		} else {
			return {
				message: l10n.t('{0} characters over {1} in current line', line.length - threshold, threshold),
				type: SourceControlInputBoxValidationType.Warning
			};
		}
	}

	provideOriginalResource(uri: Uri): Uri | undefined {
		if (uri.scheme !== 'file') {
			return;
		}

		const path = uri.path;

		if (this.mergeGroup.resourceStates.some(r => r.resourceUri.path === path)) {
			return undefined;
		}

		return toGitUri(uri, '', { replaceFileExtension: true });
	}

	async getInputTemplate(): Promise<string> {
		const commitMessage = (await Promise.all([this.repository.getMergeMessage(), this.repository.getSquashMessage()])).find(msg => !!msg);

		if (commitMessage) {
			return commitMessage;
		}

		return await this.repository.getCommitTemplate();
	}

	getConfigs(): Promise<{ key: string; value: string }[]> {
		return this.run(Operation.Config, () => this.repository.getConfigs('local'));
	}

	getConfig(key: string): Promise<string> {
		return this.run(Operation.Config, () => this.repository.config('local', key));
	}

	getGlobalConfig(key: string): Promise<string> {
		return this.run(Operation.Config, () => this.repository.config('global', key));
	}

	setConfig(key: string, value: string): Promise<string> {
		return this.run(Operation.Config, () => this.repository.config('local', key, value));
	}

	log(options?: LogOptions): Promise<Commit[]> {
		return this.run(Operation.Log, () => this.repository.log(options));
	}

	logFile(uri: Uri, options?: LogFileOptions): Promise<Commit[]> {
		// TODO: This probably needs per-uri granularity
		return this.run(Operation.LogFile, () => this.repository.logFile(uri, options));
	}

	@throttle
	async status(): Promise<void> {
		await this.run(Operation.Status);
	}

	diff(cached?: boolean): Promise<string> {
		return this.run(Operation.Diff, () => this.repository.diff(cached));
	}

	diffWithHEAD(): Promise<Change[]>;
	diffWithHEAD(path: string): Promise<string>;
	diffWithHEAD(path?: string | undefined): Promise<string | Change[]>;
	diffWithHEAD(path?: string | undefined): Promise<string | Change[]> {
		return this.run(Operation.Diff, () => this.repository.diffWithHEAD(path));
	}

	diffWith(ref: string): Promise<Change[]>;
	diffWith(ref: string, path: string): Promise<string>;
	diffWith(ref: string, path?: string | undefined): Promise<string | Change[]>;
	diffWith(ref: string, path?: string): Promise<string | Change[]> {
		return this.run(Operation.Diff, () => this.repository.diffWith(ref, path));
	}

	diffIndexWithHEAD(): Promise<Change[]>;
	diffIndexWithHEAD(path: string): Promise<string>;
	diffIndexWithHEAD(path?: string | undefined): Promise<string | Change[]>;
	diffIndexWithHEAD(path?: string): Promise<string | Change[]> {
		return this.run(Operation.Diff, () => this.repository.diffIndexWithHEAD(path));
	}

	diffIndexWith(ref: string): Promise<Change[]>;
	diffIndexWith(ref: string, path: string): Promise<string>;
	diffIndexWith(ref: string, path?: string | undefined): Promise<string | Change[]>;
	diffIndexWith(ref: string, path?: string): Promise<string | Change[]> {
		return this.run(Operation.Diff, () => this.repository.diffIndexWith(ref, path));
	}

	diffBlobs(object1: string, object2: string): Promise<string> {
		return this.run(Operation.Diff, () => this.repository.diffBlobs(object1, object2));
	}

	diffBetween(ref1: string, ref2: string): Promise<Change[]>;
	diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
	diffBetween(ref1: string, ref2: string, path?: string | undefined): Promise<string | Change[]>;
	diffBetween(ref1: string, ref2: string, path?: string): Promise<string | Change[]> {
		return this.run(Operation.Diff, () => this.repository.diffBetween(ref1, ref2, path));
	}

	getMergeBase(ref1: string, ref2: string): Promise<string> {
		return this.run(Operation.MergeBase, () => this.repository.getMergeBase(ref1, ref2));
	}

	async hashObject(data: string): Promise<string> {
		return this.run(Operation.HashObject, () => this.repository.hashObject(data));
	}

	async add(resources: Uri[], opts?: { update?: boolean }): Promise<void> {
		await this.run(
			this.optimisticUpdateEnabled() ? Operation.AddNoProgress : Operation.Add,
			async () => {
				await this.repository.add(resources.map(r => r.fsPath), opts);
				this.closeDiffEditors([], [...resources.map(r => r.fsPath)]);
			},
			() => {
				const resourcePaths = resources.map(r => r.fsPath);
				const indexGroupResourcePaths = this.indexGroup.resourceStates.map(r => r.resourceUri.fsPath);

				// Collect added resources
				const addedResourceStates: Resource[] = [];
				for (const resource of [...this.mergeGroup.resourceStates, ...this.untrackedGroup.resourceStates, ...this.workingTreeGroup.resourceStates]) {
					if (resourcePaths.includes(resource.resourceUri.fsPath) && !indexGroupResourcePaths.includes(resource.resourceUri.fsPath)) {
						addedResourceStates.push(resource);
					}
				}

				// Add new resource(s) to index group
				const indexGroup = [...this.indexGroup.resourceStates, ...addedResourceStates];

				// Remove resource(s) from merge group
				const mergeGroup = this.mergeGroup.resourceStates
					.filter(r => !resourcePaths.includes(r.resourceUri.fsPath));

				// Remove resource(s) from working group
				const workingTreeGroup = this.workingTreeGroup.resourceStates
					.filter(r => !resourcePaths.includes(r.resourceUri.fsPath));

				// Remove resource(s) from untracked group
				const untrackedGroup = this.untrackedGroup.resourceStates
					.filter(r => !resourcePaths.includes(r.resourceUri.fsPath));

				return { indexGroup, mergeGroup, workingTreeGroup, untrackedGroup };
			});
	}

	async rm(resources: Uri[]): Promise<void> {
		await this.run(Operation.Remove, () => this.repository.rm(resources.map(r => r.fsPath)));
	}

	async stage(resource: Uri, contents: string): Promise<void> {
		const path = relativePath(this.repository.root, resource.fsPath).replace(/\\/g, '/');
		await this.run(Operation.Stage, async () => {
			await this.repository.stage(path, contents);
			this.closeDiffEditors([], [...resource.fsPath]);
		});
		this._onDidChangeOriginalResource.fire(resource);
	}

	async revert(resources: Uri[]): Promise<void> {
		await this.run(
			this.optimisticUpdateEnabled() ? Operation.RevertFilesNoProgress : Operation.RevertFiles,
			async () => {
				await this.repository.revert('HEAD', resources.map(r => r.fsPath));
				this.closeDiffEditors([...resources.length !== 0 ?
					resources.map(r => r.fsPath) :
					this.indexGroup.resourceStates.map(r => r.resourceUri.fsPath)], []);
			},
			() => {
				const config = workspace.getConfiguration('git', Uri.file(this.repository.root));
				const untrackedChanges = config.get<'mixed' | 'separate' | 'hidden'>('untrackedChanges');

				const resourcePaths = resources.length === 0 ?
					this.indexGroup.resourceStates.map(r => r.resourceUri.fsPath) : resources.map(r => r.fsPath);

				// Collect removed resources
				const trackedResources: Resource[] = [];
				const untrackedResources: Resource[] = [];
				for (const resource of this.indexGroup.resourceStates) {
					if (resourcePaths.includes(resource.resourceUri.fsPath)) {
						if (resource.type === Status.INDEX_ADDED) {
							untrackedResources.push(resource);
						} else {
							trackedResources.push(resource);
						}
					}
				}

				// Remove resource(s) from index group
				const indexGroup = this.indexGroup.resourceStates
					.filter(r => !resourcePaths.includes(r.resourceUri.fsPath));

				// Add resource(s) to working group
				const workingTreeGroup = untrackedChanges === 'mixed' ?
					[...this.workingTreeGroup.resourceStates, ...trackedResources, ...untrackedResources] :
					[...this.workingTreeGroup.resourceStates, ...trackedResources];

				// Add resource(s) to untracked group
				const untrackedGroup = untrackedChanges === 'separate' ?
					[...this.untrackedGroup.resourceStates, ...untrackedResources] : undefined;

				return { indexGroup, workingTreeGroup, untrackedGroup };
			});
	}

	async commit(message: string | undefined, opts: CommitOptions = Object.create(null)): Promise<void> {
		if (this.rebaseCommit) {
			await this.run(
				Operation.RebaseContinue,
				async () => {
					if (opts.all) {
						const addOpts = opts.all === 'tracked' ? { update: true } : {};
						await this.repository.add([], addOpts);
					}

					await this.repository.rebaseContinue();
					await this.commitOperationCleanup(message, opts);
				},
				() => this.commitOperationGetOptimisticResourceGroups(opts));
		} else {
			// Set post-commit command to render the correct action button
			this.commitCommandCenter.postCommitCommand = opts.postCommitCommand;

			await this.run(
				Operation.Commit,
				async () => {
					if (opts.all) {
						const addOpts = opts.all === 'tracked' ? { update: true } : {};
						await this.repository.add([], addOpts);
					}

					delete opts.all;

					if (opts.requireUserConfig === undefined || opts.requireUserConfig === null) {
						const config = workspace.getConfiguration('git', Uri.file(this.root));
						opts.requireUserConfig = config.get<boolean>('requireGitUserConfig');
					}

					await this.repository.commit(message, opts);
					await this.commitOperationCleanup(message, opts);
				},
				() => this.commitOperationGetOptimisticResourceGroups(opts));

			// Execute post-commit command
			await this.run(Operation.PostCommitCommand, async () => {
				await this.commitCommandCenter.executePostCommitCommand(opts.postCommitCommand);
			});
		}
	}

	private async commitOperationCleanup(message: string | undefined, opts: CommitOptions) {
		if (message) {
			this.inputBox.value = await this.getInputTemplate();
		}

		const indexResources = [...this.indexGroup.resourceStates.map(r => r.resourceUri.fsPath)];
		const workingGroupResources = opts.all && opts.all !== 'tracked' ?
			[...this.workingTreeGroup.resourceStates.map(r => r.resourceUri.fsPath)] : [];

		this.closeDiffEditors(indexResources, workingGroupResources);
	}

	private commitOperationGetOptimisticResourceGroups(opts: CommitOptions): GitResourceGroups {
		let untrackedGroup: Resource[] | undefined = undefined,
			workingTreeGroup: Resource[] | undefined = undefined;

		if (opts.all === 'tracked') {
			workingTreeGroup = this.workingTreeGroup.resourceStates
				.filter(r => r.type === Status.UNTRACKED);
		} else if (opts.all) {
			untrackedGroup = workingTreeGroup = [];
		}

		return { indexGroup: [], mergeGroup: [], untrackedGroup, workingTreeGroup };
	}

	async clean(resources: Uri[]): Promise<void> {
		await this.run(
			this.optimisticUpdateEnabled() ? Operation.CleanNoProgress : Operation.Clean,
			async () => {
				const toClean: string[] = [];
				const toCheckout: string[] = [];
				const submodulesToUpdate: string[] = [];
				const resourceStates = [...this.workingTreeGroup.resourceStates, ...this.untrackedGroup.resourceStates];

				resources.forEach(r => {
					const fsPath = r.fsPath;

					for (const submodule of this.submodules) {
						if (path.join(this.root, submodule.path) === fsPath) {
							submodulesToUpdate.push(fsPath);
							return;
						}
					}

					const raw = r.toString();
					const scmResource = find(resourceStates, sr => sr.resourceUri.toString() === raw);

					if (!scmResource) {
						return;
					}

					switch (scmResource.type) {
						case Status.UNTRACKED:
						case Status.IGNORED:
							toClean.push(fsPath);
							break;

						default:
							toCheckout.push(fsPath);
							break;
					}
				});

				await this.repository.clean(toClean);
				await this.repository.checkout('', toCheckout);
				await this.repository.updateSubmodules(submodulesToUpdate);

				this.closeDiffEditors([], [...toClean, ...toCheckout]);
			},
			() => {
				const resourcePaths = resources.map(r => r.fsPath);

				// Remove resource(s) from working group
				const workingTreeGroup = this.workingTreeGroup.resourceStates
					.filter(r => !resourcePaths.includes(r.resourceUri.fsPath));

				// Remove resource(s) from untracked group
				const untrackedGroup = this.untrackedGroup.resourceStates
					.filter(r => !resourcePaths.includes(r.resourceUri.fsPath));

				return { workingTreeGroup, untrackedGroup };
			});
	}

	closeDiffEditors(indexResources: string[] | undefined, workingTreeResources: string[] | undefined, ignoreSetting: boolean = false): void {
		const config = workspace.getConfiguration('git', Uri.file(this.root));
		if (!config.get<boolean>('closeDiffOnOperation', false) && !ignoreSetting) { return; }

		const diffEditorTabsToClose: Tab[] = [];

		for (const tab of window.tabGroups.all.map(g => g.tabs).flat()) {
			const { input } = tab;
			if (input instanceof TabInputTextDiff || input instanceof TabInputNotebookDiff) {
				if (input.modified.scheme === 'git' && (indexResources === undefined || indexResources.some(r => pathEquals(r, input.modified.fsPath)))) {
					// Index
					diffEditorTabsToClose.push(tab);
				}
				if (input.modified.scheme === 'file' && input.original.scheme === 'git' && (workingTreeResources === undefined || workingTreeResources.some(r => pathEquals(r, input.modified.fsPath)))) {
					// Working Tree
					diffEditorTabsToClose.push(tab);
				}
			}
		}

		// Close editors
		window.tabGroups.close(diffEditorTabsToClose, true);
	}

	async branch(name: string, _checkout: boolean, _ref?: string): Promise<void> {
		await this.run(Operation.Branch, () => this.repository.branch(name, _checkout, _ref));
	}

	async deleteBranch(name: string, force?: boolean): Promise<void> {
		await this.run(Operation.DeleteBranch, () => this.repository.deleteBranch(name, force));
	}

	async renameBranch(name: string): Promise<void> {
		await this.run(Operation.RenameBranch, () => this.repository.renameBranch(name));
	}

	@throttle
	async fastForwardBranch(name: string): Promise<void> {
		// Get branch details
		const branch = await this.getBranch(name);
		if (!branch.upstream?.remote || !branch.upstream?.name || !branch.name) {
			return;
		}

		try {
			// Fast-forward the branch if possible
			const options = { remote: branch.upstream.remote, ref: `${branch.upstream.name}:${branch.name}` };
			await this.run(Operation.Fetch, async () => this.repository.fetch(options));
		} catch (err) {
			if (err.gitErrorCode === GitErrorCodes.BranchFastForwardRejected) {
				return;
			}

			throw err;
		}
	}

	async cherryPick(commitHash: string): Promise<void> {
		await this.run(Operation.CherryPick, () => this.repository.cherryPick(commitHash));
	}

	async move(from: string, to: string): Promise<void> {
		await this.run(Operation.Move, () => this.repository.move(from, to));
	}

	async getBranch(name: string): Promise<Branch> {
		return await this.run(Operation.GetBranch, () => this.repository.getBranch(name));
	}

	async getBranches(query: BranchQuery): Promise<Ref[]> {
		return await this.run(Operation.GetBranches, () => this.repository.getBranches(query));
	}

	async setBranchUpstream(name: string, upstream: string): Promise<void> {
		await this.run(Operation.SetBranchUpstream, () => this.repository.setBranchUpstream(name, upstream));
	}

	async merge(ref: string): Promise<void> {
		await this.run(Operation.Merge, () => this.repository.merge(ref));
	}

	async mergeAbort(): Promise<void> {
		await this.run(Operation.MergeAbort, async () => await this.repository.mergeAbort());
	}

	async rebase(branch: string): Promise<void> {
		await this.run(Operation.Rebase, () => this.repository.rebase(branch));
	}

	async tag(name: string, message?: string): Promise<void> {
		await this.run(Operation.Tag, () => this.repository.tag(name, message));
	}

	async deleteTag(name: string): Promise<void> {
		await this.run(Operation.DeleteTag, () => this.repository.deleteTag(name));
	}

	async checkout(treeish: string, opts?: { detached?: boolean }): Promise<void> {
		await this.run(Operation.Checkout, () => this.repository.checkout(treeish, [], opts));
	}

	async checkoutTracking(treeish: string, opts: { detached?: boolean } = {}): Promise<void> {
		await this.run(Operation.CheckoutTracking, () => this.repository.checkout(treeish, [], { ...opts, track: true }));
	}

	async findTrackingBranches(upstreamRef: string): Promise<Branch[]> {
		return await this.run(Operation.FindTrackingBranches, () => this.repository.findTrackingBranches(upstreamRef));
	}

	async getCommit(ref: string): Promise<Commit> {
		return await this.repository.getCommit(ref);
	}

	async reset(treeish: string, hard?: boolean): Promise<void> {
		await this.run(Operation.Reset, () => this.repository.reset(treeish, hard));
	}

	async deleteRef(ref: string): Promise<void> {
		await this.run(Operation.DeleteRef, () => this.repository.deleteRef(ref));
	}

	async addRemote(name: string, url: string): Promise<void> {
		await this.run(Operation.Remote, () => this.repository.addRemote(name, url));
	}

	async removeRemote(name: string): Promise<void> {
		await this.run(Operation.Remote, () => this.repository.removeRemote(name));
	}

	async renameRemote(name: string, newName: string): Promise<void> {
		await this.run(Operation.Remote, () => this.repository.renameRemote(name, newName));
	}

	@throttle
	async fetchDefault(options: { silent?: boolean } = {}): Promise<void> {
		await this._fetch({ silent: options.silent });
	}

	@throttle
	async fetchPrune(): Promise<void> {
		await this._fetch({ prune: true });
	}

	@throttle
	async fetchAll(options: { silent?: boolean } = {}, cancellationToken?: CancellationToken): Promise<void> {
		await this._fetch({ all: true, silent: options.silent, cancellationToken });
	}

	async fetch(options: FetchOptions): Promise<void> {
		await this._fetch(options);
	}

	private async _fetch(options: { remote?: string; ref?: string; all?: boolean; prune?: boolean; depth?: number; silent?: boolean; cancellationToken?: CancellationToken } = {}): Promise<void> {
		if (!options.prune) {
			const config = workspace.getConfiguration('git', Uri.file(this.root));
			const prune = config.get<boolean>('pruneOnFetch');
			options.prune = prune;
		}

		const operation = options.silent === true ? Operation.FetchNoProgress : Operation.Fetch;
		await this.run(operation, async () => this.repository.fetch(options));
	}

	@throttle
	async pullWithRebase(head: Branch | undefined): Promise<void> {
		let remote: string | undefined;
		let branch: string | undefined;

		if (head && head.name && head.upstream) {
			remote = head.upstream.remote;
			branch = `${head.upstream.name}`;
		}

		return this.pullFrom(true, remote, branch);
	}

	@throttle
	async pull(head?: Branch, unshallow?: boolean): Promise<void> {
		let remote: string | undefined;
		let branch: string | undefined;

		if (head && head.name && head.upstream) {
			remote = head.upstream.remote;
			branch = `${head.upstream.name}`;
		}

		return this.pullFrom(false, remote, branch, unshallow);
	}

	async pullFrom(rebase?: boolean, remote?: string, branch?: string, unshallow?: boolean): Promise<void> {
		await this.run(Operation.Pull, async () => {
			await this.maybeAutoStash(async () => {
				const config = workspace.getConfiguration('git', Uri.file(this.root));
				const fetchOnPull = config.get<boolean>('fetchOnPull');
				const tags = config.get<boolean>('pullTags');

				// When fetchOnPull is enabled, fetch all branches when pulling
				if (fetchOnPull) {
					await this.fetchAll();
				}

				if (await this.checkIfMaybeRebased(this.HEAD?.name)) {
					await this._pullAndHandleTagConflict(rebase, remote, branch, { unshallow, tags });
				}
			});
		});
	}

	private async _pullAndHandleTagConflict(rebase?: boolean, remote?: string, branch?: string, options: PullOptions = {}): Promise<void> {
		try {
			await this.repository.pull(rebase, remote, branch, options);
		}
		catch (err) {
			if (err.gitErrorCode !== GitErrorCodes.TagConflict) {
				throw err;
			}

			// Handle tag(s) conflict
			if (await this.handleTagConflict(remote, err.stderr)) {
				await this.repository.pull(rebase, remote, branch, options);
			}
		}
	}

	@throttle
	async push(head: Branch, forcePushMode?: ForcePushMode): Promise<void> {
		let remote: string | undefined;
		let branch: string | undefined;

		if (head && head.name && head.upstream) {
			remote = head.upstream.remote;
			branch = `${head.name}:${head.upstream.name}`;
		}

		await this.run(Operation.Push, () => this._push(remote, branch, undefined, undefined, forcePushMode));
	}

	async pushTo(remote?: string, name?: string, setUpstream: boolean = false, forcePushMode?: ForcePushMode): Promise<void> {
		await this.run(Operation.Push, () => this._push(remote, name, setUpstream, undefined, forcePushMode));
	}

	async pushFollowTags(remote?: string, forcePushMode?: ForcePushMode): Promise<void> {
		await this.run(Operation.Push, () => this._push(remote, undefined, false, true, forcePushMode));
	}

	async pushTags(remote?: string, forcePushMode?: ForcePushMode): Promise<void> {
		await this.run(Operation.Push, () => this._push(remote, undefined, false, false, forcePushMode, true));
	}

	async blame(path: string): Promise<string> {
		return await this.run(Operation.Blame, () => this.repository.blame(path));
	}

	@throttle
	sync(head: Branch, rebase: boolean): Promise<void> {
		return this._sync(head, rebase);
	}

	private async _sync(head: Branch, rebase: boolean): Promise<void> {
		let remoteName: string | undefined;
		let pullBranch: string | undefined;
		let pushBranch: string | undefined;

		if (head.name && head.upstream) {
			remoteName = head.upstream.remote;
			pullBranch = `${head.upstream.name}`;
			pushBranch = `${head.name}:${head.upstream.name}`;
		}

		await this.run(Operation.Sync, async () => {
			await this.maybeAutoStash(async () => {
				const config = workspace.getConfiguration('git', Uri.file(this.root));
				const fetchOnPull = config.get<boolean>('fetchOnPull');
				const tags = config.get<boolean>('pullTags');
				const followTags = config.get<boolean>('followTagsWhenSync');
				const supportCancellation = config.get<boolean>('supportCancellation');

				const fn = async (cancellationToken?: CancellationToken) => {
					// When fetchOnPull is enabled, fetch all branches when pulling
					if (fetchOnPull) {
						await this.fetchAll({}, cancellationToken);
					}

					if (await this.checkIfMaybeRebased(this.HEAD?.name)) {
						await this._pullAndHandleTagConflict(rebase, remoteName, pullBranch, { tags, cancellationToken });
					}
				};

				if (supportCancellation) {
					const opts: ProgressOptions = {
						location: ProgressLocation.Notification,
						title: l10n.t('Syncing. Cancelling may cause serious damages to the repository'),
						cancellable: true
					};

					await window.withProgress(opts, (_, token) => fn(token));
				} else {
					await fn();
				}

				const remote = this.remotes.find(r => r.name === remoteName);

				if (remote && remote.isReadOnly) {
					return;
				}

				const shouldPush = this.HEAD && (typeof this.HEAD.ahead === 'number' ? this.HEAD.ahead > 0 : true);

				if (shouldPush) {
					await this._push(remoteName, pushBranch, false, followTags);
				}
			});
		});
	}

	private async checkIfMaybeRebased(currentBranch?: string) {
		const config = workspace.getConfiguration('git');
		const shouldIgnore = config.get<boolean>('ignoreRebaseWarning') === true;

		if (shouldIgnore) {
			return true;
		}

		const maybeRebased = await this.run(Operation.Log, async () => {
			try {
				const result = await this.repository.exec(['log', '--oneline', '--cherry', `${currentBranch ?? ''}...${currentBranch ?? ''}@{upstream}`, '--']);
				if (result.exitCode) {
					return false;
				}

				return /^=/.test(result.stdout);
			} catch {
				return false;
			}
		});

		if (!maybeRebased) {
			return true;
		}

		const always = { title: l10n.t('Always Pull') };
		const pull = { title: l10n.t('Pull') };
		const cancel = { title: l10n.t('Don\'t Pull') };
		const result = await window.showWarningMessage(
			currentBranch
				? l10n.t('It looks like the current branch "{0}" might have been rebased. Are you sure you still want to pull into it?', currentBranch)
				: l10n.t('It looks like the current branch might have been rebased. Are you sure you still want to pull into it?'),
			always, pull, cancel
		);

		if (result === pull) {
			return true;
		}

		if (result === always) {
			await config.update('ignoreRebaseWarning', true, true);

			return true;
		}

		return false;
	}

	async show(ref: string, filePath: string): Promise<string> {
		return await this.run(Operation.Show, async () => {
			const path = relativePath(this.repository.root, filePath).replace(/\\/g, '/');
			const configFiles = workspace.getConfiguration('files', Uri.file(filePath));
			const defaultEncoding = configFiles.get<string>('encoding');
			const autoGuessEncoding = configFiles.get<boolean>('autoGuessEncoding');

			try {
				return await this.repository.bufferString(`${ref}:${path}`, defaultEncoding, autoGuessEncoding);
			} catch (err) {
				if (err.gitErrorCode === GitErrorCodes.WrongCase) {
					const gitRelativePath = await this.repository.getGitRelativePath(ref, path);
					return await this.repository.bufferString(`${ref}:${gitRelativePath}`, defaultEncoding, autoGuessEncoding);
				}

				throw err;
			}
		});
	}

	async buffer(ref: string, filePath: string): Promise<Buffer> {
		return this.run(Operation.Show, () => {
			const path = relativePath(this.repository.root, filePath).replace(/\\/g, '/');
			return this.repository.buffer(`${ref}:${path}`);
		});
	}

	getObjectDetails(ref: string, filePath: string): Promise<{ mode: string; object: string; size: number }> {
		return this.run(Operation.GetObjectDetails, () => this.repository.getObjectDetails(ref, filePath));
	}

	detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string }> {
		return this.run(Operation.Show, () => this.repository.detectObjectType(object));
	}

	async apply(patch: string, reverse?: boolean): Promise<void> {
		return await this.run(Operation.Apply, () => this.repository.apply(patch, reverse));
	}

	async getStashes(): Promise<Stash[]> {
		return await this.repository.getStashes();
	}

	async createStash(message?: string, includeUntracked?: boolean): Promise<void> {
		const indexResources = [...this.indexGroup.resourceStates.map(r => r.resourceUri.fsPath)];
		const workingGroupResources = [
			...this.workingTreeGroup.resourceStates.map(r => r.resourceUri.fsPath),
			...includeUntracked ? this.untrackedGroup.resourceStates.map(r => r.resourceUri.fsPath) : []];

		return await this.run(Operation.Stash, async () => {
			this.repository.createStash(message, includeUntracked);
			this.closeDiffEditors(indexResources, workingGroupResources);
		});
	}

	async popStash(index?: number): Promise<void> {
		return await this.run(Operation.Stash, () => this.repository.popStash(index));
	}

	async dropStash(index?: number): Promise<void> {
		return await this.run(Operation.Stash, () => this.repository.dropStash(index));
	}

	async applyStash(index?: number): Promise<void> {
		return await this.run(Operation.Stash, () => this.repository.applyStash(index));
	}

	async getCommitTemplate(): Promise<string> {
		return await this.run(Operation.GetCommitTemplate, async () => this.repository.getCommitTemplate());
	}

	async ignore(files: Uri[]): Promise<void> {
		return await this.run(Operation.Ignore, async () => {
			const ignoreFile = `${this.repository.root}${path.sep}.gitignore`;
			const textToAppend = files
				.map(uri => relativePath(this.repository.root, uri.fsPath).replace(/\\/g, '/'))
				.join('\n');

			const document = await new Promise(c => fs.exists(ignoreFile, c))
				? await workspace.openTextDocument(ignoreFile)
				: await workspace.openTextDocument(Uri.file(ignoreFile).with({ scheme: 'untitled' }));

			await window.showTextDocument(document);

			const edit = new WorkspaceEdit();
			const lastLine = document.lineAt(document.lineCount - 1);
			const text = lastLine.isEmptyOrWhitespace ? `${textToAppend}\n` : `\n${textToAppend}\n`;

			edit.insert(document.uri, lastLine.range.end, text);
			await workspace.applyEdit(edit);
			await document.save();
		});
	}

	async rebaseAbort(): Promise<void> {
		await this.run(Operation.RebaseAbort, async () => await this.repository.rebaseAbort());
	}

	checkIgnore(filePaths: string[]): Promise<Set<string>> {
		return this.run(Operation.CheckIgnore, () => {
			return new Promise<Set<string>>((resolve, reject) => {

				filePaths = filePaths
					.filter(filePath => isDescendant(this.root, filePath));

				if (filePaths.length === 0) {
					// nothing left
					return resolve(new Set<string>());
				}

				// https://git-scm.com/docs/git-check-ignore#git-check-ignore--z
				const child = this.repository.stream(['check-ignore', '-v', '-z', '--stdin'], { stdio: [null, null, null] });
				child.stdin!.end(filePaths.join('\0'), 'utf8');

				const onExit = (exitCode: number) => {
					if (exitCode === 1) {
						// nothing ignored
						resolve(new Set<string>());
					} else if (exitCode === 0) {
						resolve(new Set<string>(this.parseIgnoreCheck(data)));
					} else {
						if (/ is in submodule /.test(stderr)) {
							reject(new GitError({ stdout: data, stderr, exitCode, gitErrorCode: GitErrorCodes.IsInSubmodule }));
						} else {
							reject(new GitError({ stdout: data, stderr, exitCode }));
						}
					}
				};

				let data = '';
				const onStdoutData = (raw: string) => {
					data += raw;
				};

				child.stdout!.setEncoding('utf8');
				child.stdout!.on('data', onStdoutData);

				let stderr: string = '';
				child.stderr!.setEncoding('utf8');
				child.stderr!.on('data', raw => stderr += raw);

				child.on('error', reject);
				child.on('exit', onExit);
			});
		});
	}

	// Parses output of `git check-ignore -v -z` and returns only those paths
	// that are actually ignored by git.
	// Matches to a negative pattern (starting with '!') are filtered out.
	// See also https://git-scm.com/docs/git-check-ignore#_output.
	private parseIgnoreCheck(raw: string): string[] {
		const ignored = [];
		const elements = raw.split('\0');
		for (let i = 0; i < elements.length; i += 4) {
			const pattern = elements[i + 2];
			const path = elements[i + 3];
			if (pattern && !pattern.startsWith('!')) {
				ignored.push(path);
			}
		}
		return ignored;
	}

	private async _push(remote?: string, refspec?: string, setUpstream: boolean = false, followTags = false, forcePushMode?: ForcePushMode, tags = false): Promise<void> {
		try {
			await this.repository.push(remote, refspec, setUpstream, followTags, forcePushMode, tags);
		} catch (err) {
			if (!remote || !refspec) {
				throw err;
			}

			const repository = new ApiRepository(this);
			const remoteObj = repository.state.remotes.find(r => r.name === remote);

			if (!remoteObj) {
				throw err;
			}

			for (const handler of this.pushErrorHandlerRegistry.getPushErrorHandlers()) {
				if (await handler.handlePushError(repository, remoteObj, refspec, err)) {
					return;
				}
			}

			throw err;
		}
	}

	private async run<T>(
		operation: Operation,
		runOperation: () => Promise<T> = () => Promise.resolve<any>(null),
		getOptimisticResourceGroups: () => GitResourceGroups | undefined = () => undefined): Promise<T> {
		if (this.state !== RepositoryState.Idle) {
			throw new Error('Repository not initialized');
		}

		let error: any = null;

		this._operations.start(operation);
		this._onRunOperation.fire(operation);

		try {
			const result = await this.retryRun(operation, runOperation);

			if (!isReadOnly(operation)) {
				await this.updateModelState(this.optimisticUpdateEnabled() ? getOptimisticResourceGroups() : undefined);
			}

			return result;
		} catch (err) {
			error = err;

			if (err.gitErrorCode === GitErrorCodes.NotAGitRepository) {
				this.state = RepositoryState.Disposed;
			}

			throw err;
		} finally {
			this._operations.end(operation);
			this._onDidRunOperation.fire({ operation, error });
		}
	}

	private async retryRun<T>(operation: Operation, runOperation: () => Promise<T> = () => Promise.resolve<any>(null)): Promise<T> {
		let attempt = 0;

		while (true) {
			try {
				attempt++;
				return await runOperation();
			} catch (err) {
				const shouldRetry = attempt <= 10 && (
					(err.gitErrorCode === GitErrorCodes.RepositoryIsLocked)
					|| ((operation === Operation.Pull || operation === Operation.Sync || operation === Operation.Fetch) && (err.gitErrorCode === GitErrorCodes.CantLockRef || err.gitErrorCode === GitErrorCodes.CantRebaseMultipleBranches))
				);

				if (shouldRetry) {
					// quatratic backoff
					await timeout(Math.pow(attempt, 2) * 50);
				} else {
					throw err;
				}
			}
		}
	}

	private static KnownHugeFolderNames = ['node_modules'];

	private async findKnownHugeFolderPathsToIgnore(): Promise<string[]> {
		const folderPaths: string[] = [];

		for (const folderName of Repository.KnownHugeFolderNames) {
			const folderPath = path.join(this.repository.root, folderName);

			if (await new Promise<boolean>(c => fs.exists(folderPath, c))) {
				folderPaths.push(folderPath);
			}
		}

		const ignored = await this.checkIgnore(folderPaths);

		return folderPaths.filter(p => !ignored.has(p));
	}

	private async updateModelState(optimisticResourcesGroups?: GitResourceGroups) {
		this.updateModelStateCancellationTokenSource?.cancel();

		this.updateModelStateCancellationTokenSource = new CancellationTokenSource();
		await this._updateModelState(optimisticResourcesGroups, this.updateModelStateCancellationTokenSource.token);
	}

	private async _updateModelState(optimisticResourcesGroups?: GitResourceGroups, cancellationToken?: CancellationToken): Promise<void> {
		try {
			// Optimistically update resource groups
			if (optimisticResourcesGroups) {
				this._updateResourceGroupsState(optimisticResourcesGroups);
			}

			const [HEAD, remotes, submodules, rebaseCommit, mergeInProgress, commitTemplate] =
				await Promise.all([
					this.repository.getHEADBranch(),
					this.repository.getRemotes(),
					this.repository.getSubmodules(),
					this.getRebaseCommit(),
					this.isMergeInProgress(),
					this.getInputTemplate()]);

			this._HEAD = HEAD;
			this._remotes = remotes!;
			this._submodules = submodules!;
			this.rebaseCommit = rebaseCommit;
			this.mergeInProgress = mergeInProgress;

			this._sourceControl.commitTemplate = commitTemplate;

			// Execute cancellable long-running operations
			const config = workspace.getConfiguration('git');
			let sort = config.get<'alphabetically' | 'committerdate'>('branchSortOrder') || 'alphabetically';
			if (sort !== 'alphabetically' && sort !== 'committerdate') {
				sort = 'alphabetically';
			}

			const [resourceGroups, refs] =
				await Promise.all([
					this.getStatus(cancellationToken),
					this.repository.getRefs({ sort, cancellationToken })]);

			this._refs = refs!;
			this._updateResourceGroupsState(resourceGroups);

			this._onDidChangeStatus.fire();
		}
		catch (err) {
			if (err instanceof CancellationError) {
				return;
			}

			throw err;
		}
	}

	private _updateResourceGroupsState(resourcesGroups: GitResourceGroups): void {
		const config = workspace.getConfiguration('git');
		const ignoreChangesFiles = config.get<string[]>('ignoreChangesFiles')?.map(p => Uri.file(path.join(this.repository.root, p)).fsPath) ?? [];
		const ignoreChangesFolders = config.get<string[]>('ignoreChangesFolders')?.map(p => Uri.file(path.join(this.repository.root, p)).fsPath) ?? [];

		for (const resources of [resourcesGroups.workingTreeGroup, resourcesGroups.untrackedGroup]) {
			if (!resources) { continue; }
			for (let i = 0; i < resources.length; i++) {
				const { fsPath } = resources[i].original;
				if (ignoreChangesFiles.includes(fsPath) || ignoreChangesFolders.some((p) => fsPath.startsWith(p))) {
					resources.splice(i, 1);
					i--;
				}
			}

		}

		// set resource groups
		if (resourcesGroups.indexGroup) { this.indexGroup.resourceStates = resourcesGroups.indexGroup; }
		if (resourcesGroups.mergeGroup) { this.mergeGroup.resourceStates = resourcesGroups.mergeGroup; }
		if (resourcesGroups.untrackedGroup) { this.untrackedGroup.resourceStates = resourcesGroups.untrackedGroup; }
		if (resourcesGroups.workingTreeGroup) { this.workingTreeGroup.resourceStates = resourcesGroups.workingTreeGroup; }

		// set count badge
		this.setCountBadge();
	}

	private async getStatus(cancellationToken?: CancellationToken): Promise<GitResourceGroups> {
		if (cancellationToken && cancellationToken.isCancellationRequested) {
			throw new CancellationError();
		}

		const scopedConfig = workspace.getConfiguration('git', Uri.file(this.repository.root));
		const untrackedChanges = scopedConfig.get<'mixed' | 'separate' | 'hidden'>('untrackedChanges');
		const ignoreSubmodules = scopedConfig.get<boolean>('ignoreSubmodules');

		const limit = scopedConfig.get<number>('statusLimit', 10000);

		const start = new Date().getTime();
		const { status, statusLength, didHitLimit } = await this.repository.getStatus({ limit, ignoreSubmodules, untrackedChanges, cancellationToken });
		const totalTime = new Date().getTime() - start;

		this.isRepositoryHuge = didHitLimit ? { limit } : false;

		if (didHitLimit) {
			/* __GDPR__
				"statusLimit" : {
					"owner": "lszomoru",
					"ignoreSubmodules": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Setting indicating whether submodules are ignored" },
					"limit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Setting indicating the limit of status entries" },
					"statusLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of status entries" },
					"totalTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of ms the operation took" }
				}
			*/
			this.telemetryReporter.sendTelemetryEvent('statusLimit', { ignoreSubmodules: String(ignoreSubmodules) }, { limit, statusLength, totalTime });
		}

		if (totalTime > 5000) {
			/* __GDPR__
				"statusSlow" : {
					"owner": "digitarald",
					"comment": "Reports when git status is slower than 5s",
					"expiration": "1.73",
					"ignoreSubmodules": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Setting indicating whether submodules are ignored" },
					"didHitLimit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Total number of status entries" },
					"didWarnAboutLimit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "True when the user was warned about slow git status" },
					"statusLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of status entries" },
					"totalTime": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total number of ms the operation took" }
				}
			*/
			this.telemetryReporter.sendTelemetryEvent('statusSlow', { ignoreSubmodules: String(ignoreSubmodules), didHitLimit: String(didHitLimit), didWarnAboutLimit: String(this.didWarnAboutLimit) }, { statusLength, totalTime });
		}

		// Triggers or clears any validation warning
		this._sourceControl.inputBox.validateInput = this._sourceControl.inputBox.validateInput;

		const config = workspace.getConfiguration('git');
		const shouldIgnore = config.get<boolean>('ignoreLimitWarning') === true;
		const useIcons = !config.get<boolean>('decorations.enabled', true);

		if (didHitLimit && !shouldIgnore && !this.didWarnAboutLimit) {
			const knownHugeFolderPaths = await this.findKnownHugeFolderPathsToIgnore();
			const gitWarn = l10n.t('The git repository at "{0}" has too many active changes, only a subset of Git features will be enabled.', this.repository.root);
			const neverAgain = { title: l10n.t('Don\'t Show Again') };

			if (knownHugeFolderPaths.length > 0) {
				const folderPath = knownHugeFolderPaths[0];
				const folderName = path.basename(folderPath);

				const addKnown = l10n.t('Would you like to add "{0}" to .gitignore?', folderName);
				const yes = { title: l10n.t('Yes') };
				const no = { title: l10n.t('No') };

				const result = await window.showWarningMessage(`${gitWarn} ${addKnown}`, yes, no, neverAgain);
				if (result === yes) {
					this.ignore([Uri.file(folderPath)]);
				} else {
					if (result === neverAgain) {
						config.update('ignoreLimitWarning', true, false);
					}

					this.didWarnAboutLimit = true;
				}
			} else {
				const ok = { title: l10n.t('OK') };
				const result = await window.showWarningMessage(gitWarn, ok, neverAgain);
				if (result === neverAgain) {
					config.update('ignoreLimitWarning', true, false);
				}

				this.didWarnAboutLimit = true;
			}
		}

		const indexGroup: Resource[] = [],
			mergeGroup: Resource[] = [],
			untrackedGroup: Resource[] = [],
			workingTreeGroup: Resource[] = [];

		status.forEach(raw => {
			const uri = Uri.file(path.join(this.repository.root, raw.path));
			const renameUri = raw.rename
				? Uri.file(path.join(this.repository.root, raw.rename))
				: undefined;

			switch (raw.x + raw.y) {
				case '??': switch (untrackedChanges) {
					case 'mixed': return workingTreeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.WorkingTree, uri, Status.UNTRACKED, useIcons));
					case 'separate': return untrackedGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Untracked, uri, Status.UNTRACKED, useIcons));
					default: return undefined;
				}
				case '!!': switch (untrackedChanges) {
					case 'mixed': return workingTreeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.WorkingTree, uri, Status.IGNORED, useIcons));
					case 'separate': return untrackedGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Untracked, uri, Status.IGNORED, useIcons));
					default: return undefined;
				}
				case 'DD': return mergeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Merge, uri, Status.BOTH_DELETED, useIcons));
				case 'AU': return mergeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Merge, uri, Status.ADDED_BY_US, useIcons));
				case 'UD': return mergeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Merge, uri, Status.DELETED_BY_THEM, useIcons));
				case 'UA': return mergeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Merge, uri, Status.ADDED_BY_THEM, useIcons));
				case 'DU': return mergeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Merge, uri, Status.DELETED_BY_US, useIcons));
				case 'AA': return mergeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Merge, uri, Status.BOTH_ADDED, useIcons));
				case 'UU': return mergeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Merge, uri, Status.BOTH_MODIFIED, useIcons));
			}

			switch (raw.x) {
				case 'M': indexGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Index, uri, Status.INDEX_MODIFIED, useIcons)); break;
				case 'A': indexGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Index, uri, Status.INDEX_ADDED, useIcons)); break;
				case 'D': indexGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Index, uri, Status.INDEX_DELETED, useIcons)); break;
				case 'R': indexGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Index, uri, Status.INDEX_RENAMED, useIcons, renameUri)); break;
				case 'C': indexGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.Index, uri, Status.INDEX_COPIED, useIcons, renameUri)); break;
			}

			switch (raw.y) {
				case 'M': workingTreeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.WorkingTree, uri, Status.MODIFIED, useIcons, renameUri)); break;
				case 'D': workingTreeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.WorkingTree, uri, Status.DELETED, useIcons, renameUri)); break;
				case 'A': workingTreeGroup.push(new Resource(this.resourceCommandResolver, ResourceGroupType.WorkingTree, uri, Status.INTENT_TO_ADD, useIcons, renameUri)); break;
			}

			return undefined;
		});

		return { indexGroup, mergeGroup, untrackedGroup, workingTreeGroup };
	}

	private setCountBadge(): void {
		const config = workspace.getConfiguration('git', Uri.file(this.repository.root));
		const countBadge = config.get<'all' | 'tracked' | 'off'>('countBadge');
		const untrackedChanges = config.get<'mixed' | 'separate' | 'hidden'>('untrackedChanges');

		let count =
			this.mergeGroup.resourceStates.length +
			this.indexGroup.resourceStates.length +
			this.workingTreeGroup.resourceStates.length;

		switch (countBadge) {
			case 'off': count = 0; break;
			case 'tracked':
				if (untrackedChanges === 'mixed') {
					count -= this.workingTreeGroup.resourceStates.filter(r => r.type === Status.UNTRACKED || r.type === Status.IGNORED).length;
				}
				break;
			case 'all':
				if (untrackedChanges === 'separate') {
					count += this.untrackedGroup.resourceStates.length;
				}
				break;
		}

		this._sourceControl.count = count;
	}

	private async getRebaseCommit(): Promise<Commit | undefined> {
		const rebaseHeadPath = path.join(this.repository.root, '.git', 'REBASE_HEAD');
		const rebaseApplyPath = path.join(this.repository.root, '.git', 'rebase-apply');
		const rebaseMergePath = path.join(this.repository.root, '.git', 'rebase-merge');

		try {
			const [rebaseApplyExists, rebaseMergePathExists, rebaseHead] = await Promise.all([
				new Promise<boolean>(c => fs.exists(rebaseApplyPath, c)),
				new Promise<boolean>(c => fs.exists(rebaseMergePath, c)),
				new Promise<string>((c, e) => fs.readFile(rebaseHeadPath, 'utf8', (err, result) => err ? e(err) : c(result)))
			]);
			if (!rebaseApplyExists && !rebaseMergePathExists) {
				return undefined;
			}
			return await this.getCommit(rebaseHead.trim());
		} catch (err) {
			return undefined;
		}
	}

	private isMergeInProgress(): Promise<boolean> {
		const mergeHeadPath = path.join(this.repository.root, '.git', 'MERGE_HEAD');
		return new Promise<boolean>(resolve => fs.exists(mergeHeadPath, resolve));
	}

	private async maybeAutoStash<T>(runOperation: () => Promise<T>): Promise<T> {
		const config = workspace.getConfiguration('git', Uri.file(this.root));
		const shouldAutoStash = config.get<boolean>('autoStash')
			&& this.workingTreeGroup.resourceStates.some(r => r.type !== Status.UNTRACKED && r.type !== Status.IGNORED);

		if (!shouldAutoStash) {
			return await runOperation();
		}

		await this.repository.createStash(undefined, true);
		const result = await runOperation();
		await this.repository.popStash();

		return result;
	}

	private onFileChange(_uri: Uri): void {
		const config = workspace.getConfiguration('git');
		const autorefresh = config.get<boolean>('autorefresh');

		if (!autorefresh) {
			return;
		}

		if (this.isRepositoryHuge) {
			return;
		}

		if (!this.operations.isIdle()) {
			return;
		}

		this.eventuallyUpdateWhenIdleAndWait();
	}

	@debounce(1000)
	private eventuallyUpdateWhenIdleAndWait(): void {
		this.updateWhenIdleAndWait();
	}

	@throttle
	private async updateWhenIdleAndWait(): Promise<void> {
		await this.whenIdleAndFocused();
		await this.status();
		await timeout(5000);
	}

	async whenIdleAndFocused(): Promise<void> {
		while (true) {
			if (!this.operations.isIdle()) {
				await eventToPromise(this.onDidRunOperation);
				continue;
			}

			if (!window.state.focused) {
				const onDidFocusWindow = filterEvent(window.onDidChangeWindowState, e => e.focused);
				await eventToPromise(onDidFocusWindow);
				continue;
			}

			return;
		}
	}

	get headLabel(): string {
		const HEAD = this.HEAD;

		if (!HEAD) {
			return '';
		}

		const tag = this.refs.filter(iref => iref.type === RefType.Tag && iref.commit === HEAD.commit)[0];
		const tagName = tag && tag.name;
		const head = HEAD.name || tagName || (HEAD.commit || '').substr(0, 8);

		return head
			+ (this.workingTreeGroup.resourceStates.length + this.untrackedGroup.resourceStates.length > 0 ? '*' : '')
			+ (this.indexGroup.resourceStates.length > 0 ? '+' : '')
			+ (this.mergeGroup.resourceStates.length > 0 ? '!' : '');
	}

	get syncLabel(): string {
		if (!this.HEAD
			|| !this.HEAD.name
			|| !this.HEAD.commit
			|| !this.HEAD.upstream
			|| !(this.HEAD.ahead || this.HEAD.behind)
		) {
			return '';
		}

		const remoteName = this.HEAD && this.HEAD.remote || this.HEAD.upstream.remote;
		const remote = this.remotes.find(r => r.name === remoteName);

		if (remote && remote.isReadOnly) {
			return `${this.HEAD.behind}↓`;
		}

		return `${this.HEAD.behind}↓ ${this.HEAD.ahead}↑`;
	}

	get syncTooltip(): string {
		if (!this.HEAD
			|| !this.HEAD.name
			|| !this.HEAD.commit
			|| !this.HEAD.upstream
			|| !(this.HEAD.ahead || this.HEAD.behind)
		) {
			return l10n.t('Synchronize Changes');
		}

		const remoteName = this.HEAD && this.HEAD.remote || this.HEAD.upstream.remote;
		const remote = this.remotes.find(r => r.name === remoteName);

		if ((remote && remote.isReadOnly) || !this.HEAD.ahead) {
			return l10n.t('Pull {0} commits from {1}/{2}', this.HEAD.behind!, this.HEAD.upstream.remote, this.HEAD.upstream.name);
		} else if (!this.HEAD.behind) {
			return l10n.t('Push {0} commits to {1}/{2}', this.HEAD.ahead, this.HEAD.upstream.remote, this.HEAD.upstream.name);
		} else {
			return l10n.t('Pull {0} and push {1} commits between {2}/{3}', this.HEAD.behind, this.HEAD.ahead, this.HEAD.upstream.remote, this.HEAD.upstream.name);
		}
	}

	private updateInputBoxPlaceholder(): void {
		const branchName = this.headShortName;

		if (branchName) {
			// '{0}' will be replaced by the corresponding key-command later in the process, which is why it needs to stay.
			this._sourceControl.inputBox.placeholder = l10n.t('Message ({0} to commit on "{1}")', '{0}', branchName);
		} else {
			this._sourceControl.inputBox.placeholder = l10n.t('Message ({0} to commit)');
		}
	}

	private updateBranchProtectionMatcher(): void {
		const scopedConfig = workspace.getConfiguration('git', Uri.file(this.repository.root));
		const branchProtectionGlobs = scopedConfig.get<string[]>('branchProtection')!.map(bp => bp.trim()).filter(bp => bp !== '');

		if (branchProtectionGlobs.length === 0) {
			this.isBranchProtectedMatcher = undefined;
		} else {
			this.isBranchProtectedMatcher = picomatch(branchProtectionGlobs);
		}
	}

	private optimisticUpdateEnabled(): boolean {
		const config = workspace.getConfiguration('git', Uri.file(this.root));
		return config.get<boolean>('optimisticUpdate') === true;
	}

	private async handleTagConflict(remote: string | undefined, raw: string): Promise<boolean> {
		// Ensure there is a remote
		remote = remote ?? this.HEAD?.upstream?.remote;
		if (!remote) {
			throw new Error('Unable to resolve tag conflict due to missing remote.');
		}

		// Extract tag names from message
		const tags: string[] = [];
		for (const match of raw.matchAll(/^ ! \[rejected\]\s+([^\s]+)\s+->\s+([^\s]+)\s+\(would clobber existing tag\)$/gm)) {
			if (match.length === 3) {
				tags.push(match[1]);
			}
		}
		if (tags.length === 0) {
			throw new Error(`Unable to extract tag names from error message: ${raw}`);
		}

		// Notification
		const replaceLocalTags = l10n.t('Replace Local Tag(s)');
		const message = l10n.t('Unable to pull from remote repository due to conflicting tag(s): {0}. Would you like to resolve the conflict by replacing the local tag(s)?', tags.join(', '));
		const choice = await window.showErrorMessage(message, { modal: true }, replaceLocalTags);

		if (choice !== replaceLocalTags) {
			return false;
		}

		// Force fetch tags
		await this.repository.fetchTags({ remote, tags, force: true });
		return true;
	}

	public isBranchProtected(name: string = this.HEAD?.name ?? ''): boolean {
		return this.isBranchProtectedMatcher ? this.isBranchProtectedMatcher(name) : false;
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}
