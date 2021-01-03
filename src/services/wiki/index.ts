/* eslint-disable @typescript-eslint/no-dynamic-delete */
import { injectable, inject } from 'inversify';
import { delay } from 'bluebird';
import fs from 'fs-extra';
import path from 'path';
import { Worker } from 'worker_threads';
import isDev from 'electron-is-dev';
import { dialog } from 'electron';
import chokidar from 'chokidar';
import { trim, compact, debounce } from 'lodash';

import serviceIdentifiers from '@services/serviceIdentifier';
import { Window } from '@services/windows';
import { Preference } from '@services/preferences';
import { View } from '@services/view';
import { Workspace } from '@services/workspaces';
import { WorkspaceView } from '@services/workspacesView';
import { IWorkspace, IUserInfo } from '@services/types';
import { WindowNames } from '@services/windows/WindowProperties';
import { logger, wikiOutputToFile, refreshOutputFile } from '@/services/libs/log';
import i18n from '@/services/libs/i18n';
import { TIDDLYWIKI_TEMPLATE_FOLDER_PATH, TIDDLERS_PATH } from '@/services/constants/paths';
import { updateSubWikiPluginContent } from './update-plugin-content';

/**
 * Handle wiki worker startup and restart
 */
@injectable()
export class Wiki {
  constructor(
    @inject(serviceIdentifiers.Window) private readonly windowService: Window,
    @inject(serviceIdentifiers.Preference) private readonly preferenceService: Preference,
    @inject(serviceIdentifiers.Workspace) private readonly workspaceService: Workspace,
    @inject(serviceIdentifiers.View) private readonly viewService: View,
    @inject(serviceIdentifiers.WorkspaceView) private readonly workspaceViewService: WorkspaceView,
  ) {}

  // wiki-worker-manager.ts

  // worker should send payload in form of `{ message: string, handler: string }` where `handler` is the name of function to call
  private readonly logMessage = (loggerMeta: Record<string, string>) => (
    message: string | { type: string; payload?: string | { message: string; handler: string } },
  ): void => {
    if (typeof message === 'string') {
      logger.info(message, loggerMeta);
    } else if (message?.payload !== undefined) {
      const { type, payload } = message;
      if (type === 'progress' && typeof payload === 'object') {
        logger.info(payload.message, { ...loggerMeta, handler: payload.handler });
      } else if (typeof payload === 'string') {
        logger.info(payload, loggerMeta);
      }
    }
  };

  // key is same to workspace name, so we can get this worker by workspace name
  // { [name: string]: Worker }
  private wikiWorkers: Record<string, Worker> = {};

  // don't forget to config option in `dist.js` https://github.com/electron/electron/issues/18540#issuecomment-652430001
  // to copy all worker.js and its local dependence to `process.resourcesPath`
  // On dev, this file will be in .webpack/main/index.js ,so:
  private readonly WIKI_WORKER_PATH = isDev
    ? path.resolve('./.webpack/main/wiki-worker.js')
    : path.resolve(process.resourcesPath, 'app.asar.unpacked', 'wiki-worker.js');

  public async startWiki(homePath: string, tiddlyWikiPort: number, userName: string): Promise<void> {
    // use Promise to handle worker callbacks
    await new Promise<void>((resolve, reject) => {
      // require here to prevent circular dependence, which will cause "TypeError: getWorkspaceByName is not a function"
      const workspace = this.workspaceService.getByName(homePath);
      const workspaceID = workspace?.id;
      if (workspace === undefined || workspaceID === undefined) {
        logger.error('Try to start wiki, but workspace not found', { homePath, workspace, workspaceID });
        return;
      }
      this.workspaceService.updateMetaData(workspaceID, { isLoading: true });
      const workerData = { homePath, userName, tiddlyWikiPort };
      const worker = new Worker(this.WIKI_WORKER_PATH, { workerData });
      this.wikiWorkers[homePath] = worker;
      const loggerMeta = { worker: 'NodeJSWiki', homePath };
      const loggerForWorker = this.logMessage(loggerMeta);
      let started = false;
      worker.on('error', (error: Error) => {
        console.log(error);
        logger.error(error.message, { ...loggerMeta, ...error });
        reject(error);
      });
      worker.on('exit', (code: number) => {
        if (code !== 0) {
          delete this.wikiWorkers[homePath];
        }
        logger.warning(`NodeJSWiki ${homePath} Worker stopped with exit code ${code}.`, loggerMeta);
        resolve();
      });
      worker.on('message', (message: string | { type: string; payload?: string | { message: string; handler: string } }) => {
        console.log(message);
        loggerForWorker(message);
        if (!started) {
          started = true;
          setTimeout(() => {
            this.viewService.reloadViewsWebContents();
            this.workspaceService.updateMetaData(workspaceID, { isLoading: false });
            // close add-workspace dialog
            const addWorkspaceWindow = this.windowService.get(WindowNames.addWorkspace);
            if (addWorkspaceWindow !== undefined) {
              addWorkspaceWindow.close();
            }
            resolve();
          }, 100);
        }
      });
      // redirect stdout to file
      const logFileName = workspace.name.replace(/[/\\]/g, '_');
      refreshOutputFile(logFileName);
      wikiOutputToFile(logFileName, worker.stdout);
      wikiOutputToFile(logFileName, worker.stderr);
    });
  }

  public async stopWiki(homePath: string): Promise<void> {
    const worker = this.wikiWorkers[homePath];
    if (worker === undefined) {
      logger.warning(`No wiki watcher for ${homePath}. No running worker, means maybe tiddlywiki server in this workspace failed to start`, {
        function: 'stopWiki',
      });
      return await Promise.resolve();
    }
    try {
      await new Promise((resolve, reject) => {
        worker.postMessage({ type: 'command', message: 'exit' });
        worker.once('exit', resolve);
        worker.once('error', reject);
      });
      await delay(100);
    } catch (error) {
      logger.info(`Wiki-worker have error ${String(error)} when try to stop`, { function: 'stopWiki' });
      await worker.terminate();
    }
    // delete this.wikiWorkers[homePath];
    logger.info(`Wiki-worker for ${homePath} stopped`, { function: 'stopWiki' });
  }

  /**
   * Stop all worker_thread, use and await this before app.quit()
   */
  public async stopAllWiki(): Promise<void> {
    const tasks = [];
    for (const homePath of Object.keys(this.wikiWorkers)) {
      tasks.push(this.stopWiki(homePath));
    }
    await Promise.all(tasks);
    // try to prevent https://github.com/electron/electron/issues/23315, but seems not working at all
    await delay(100);
    logger.info('All wiki-worker is stopped', { function: 'stopAllWiki' });
  }

  // create-wiki.ts

  private readonly logProgress = (message: string): void => {
    logger.notice({
      type: 'progress',
      payload: { message, handler: 'createWikiProgress' },
    });
  };

  private readonly folderToContainSymlinks = 'subwiki';
  /**
   * Link a sub wiki to a main wiki, this will create a shortcut folder from main wiki to sub wiki, so when saving files to that shortcut folder, you will actually save file to the sub wiki
   * We place symbol-link (short-cuts) in the tiddlers/subwiki/ folder, and ignore this folder in the .gitignore, so this symlink won't be commit to the git, as it contains computer specific path.
   * @param {string} mainWikiPath folderPath of a wiki as link's destination
   * @param {string} folderName sub-wiki's folder name
   * @param {string} newWikiPath sub-wiki's folder path
   */
  public async linkWiki(mainWikiPath: string, folderName: string, subWikiPath: string): Promise<void> {
    const mainWikiTiddlersFolderPath = path.join(mainWikiPath, TIDDLERS_PATH, this.folderToContainSymlinks, folderName);
    try {
      try {
        await fs.remove(mainWikiTiddlersFolderPath);
      } catch {}
      await fs.createSymlink(subWikiPath, mainWikiTiddlersFolderPath, 'junction');
      this.logProgress(i18n.t('AddWorkspace.CreateLinkFromSubWikiToMainWikiSucceed'));
    } catch (error: unknown) {
      throw new Error(i18n.t('AddWorkspace.CreateLinkFromSubWikiToMainWikiFailed', { subWikiPath, mainWikiTiddlersFolderPath, error }));
    }
  }

  public async createWiki(newFolderPath: string, folderName: string): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartUsingTemplateToCreateWiki'));
    const newWikiPath = path.join(newFolderPath, folderName);
    if (!(await fs.pathExists(newFolderPath))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { newFolderPath }));
    }
    if (!(await fs.pathExists(TIDDLYWIKI_TEMPLATE_FOLDER_PATH))) {
      throw new Error(i18n.t('AddWorkspace.WikiTemplateMissing', { TIDDLYWIKI_TEMPLATE_FOLDER_PATH }));
    }
    if (await fs.pathExists(newWikiPath)) {
      throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
    }
    try {
      await fs.copy(TIDDLYWIKI_TEMPLATE_FOLDER_PATH, newWikiPath);
    } catch {
      throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
    }
    this.logProgress(i18n.t('AddWorkspace.WikiTemplateCopyCompleted'));
  }

  /**
   *
   * @param newFolderPath
   * @param folderName
   * @param mainWikiToLink
   * @param onlyLink not creating new subwiki folder, just link existed subwiki folder to main wiki folder
   */
  public async createSubWiki(newFolderPath: string, folderName: string, mainWikiPath: string, tagName = '', onlyLink = false): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartCreatingSubWiki'));
    const newWikiPath = path.join(newFolderPath, folderName);
    if (!(await fs.pathExists(newFolderPath))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { newFolderPath }));
    }
    if (!onlyLink) {
      if (await fs.pathExists(newWikiPath)) {
        throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
      }
      try {
        await fs.mkdirs(newWikiPath);
      } catch {
        throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
      }
    }
    this.logProgress(i18n.t('AddWorkspace.StartLinkingSubWikiToMainWiki'));
    await this.linkWiki(mainWikiPath, folderName, newWikiPath);
    if (typeof tagName === 'string' && tagName.length > 0) {
      this.logProgress(i18n.t('AddWorkspace.AddFileSystemPath'));
      updateSubWikiPluginContent(mainWikiPath, { tagName, subWikiFolderName: folderName });
    }

    this.logProgress(i18n.t('AddWorkspace.SubWikiCreationCompleted'));
  }

  public async removeWiki(wikiPath: string, mainWikiToUnLink?: string, onlyRemoveLink = false): Promise<void> {
    if (mainWikiToUnLink !== undefined) {
      const subWikiName = path.basename(wikiPath);
      await fs.remove(path.join(mainWikiToUnLink, TIDDLERS_PATH, this.folderToContainSymlinks, subWikiName));
    }
    if (!onlyRemoveLink) {
      await fs.remove(wikiPath);
    }
  }

  public async ensureWikiExist(wikiPath: string, shouldBeMainWiki: boolean): Promise<void> {
    if (!(await fs.pathExists(wikiPath))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { newFolderPath: wikiPath }));
    }
    if (shouldBeMainWiki && !(await fs.pathExists(path.join(wikiPath, TIDDLERS_PATH)))) {
      throw new Error(i18n.t('AddWorkspace.ThisPathIsNotAWikiFolder', { wikiPath }));
    }
  }

  public async cloneWiki(parentFolderLocation: string, wikiFolderName: string, githubWikiUrl: any, userInfo: any): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartCloningWiki'));
    const newWikiPath = path.join(parentFolderLocation, wikiFolderName);
    if (!(await fs.pathExists(parentFolderLocation))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { newFolderPath: parentFolderLocation }));
    }
    if (await fs.pathExists(newWikiPath)) {
      throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
    }
    try {
      await fs.mkdir(newWikiPath);
    } catch {
      throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
    }
    // TODO: call git service
    // await clone(githubWikiUrl, path.join(parentFolderLocation, wikiFolderName), userInfo);
  }

  public async cloneSubWiki(
    parentFolderLocation: string,
    wikiFolderName: string,
    mainWikiPath: string,
    githubWikiUrl: string,
    userInfo: IUserInfo,
    tagName = '',
  ): Promise<void> {
    this.logProgress(i18n.t('AddWorkspace.StartCloningSubWiki'));
    const newWikiPath = path.join(parentFolderLocation, wikiFolderName);
    if (!(await fs.pathExists(parentFolderLocation))) {
      throw new Error(i18n.t('AddWorkspace.PathNotExist', { newFolderPath: parentFolderLocation }));
    }
    if (await fs.pathExists(newWikiPath)) {
      throw new Error(i18n.t('AddWorkspace.WikiExisted', { newWikiPath }));
    }
    try {
      await fs.mkdir(newWikiPath);
    } catch {
      throw new Error(i18n.t('AddWorkspace.CantCreateFolderHere', { newWikiPath }));
    }
    // TODO: call git service
    // await clone(githubWikiUrl, path.join(parentFolderLocation, wikiFolderName), userInfo);
    this.logProgress(i18n.t('AddWorkspace.StartLinkingSubWikiToMainWiki'));
    await this.linkWiki(mainWikiPath, wikiFolderName, path.join(parentFolderLocation, wikiFolderName));
    if (typeof tagName === 'string' && tagName.length > 0) {
      this.logProgress(i18n.t('AddWorkspace.AddFileSystemPath'));
      updateSubWikiPluginContent(mainWikiPath, { tagName, subWikiFolderName: wikiFolderName });
    }
  }

  // wiki-startup.ts

  // FIXME: prevent private wiki try to restart wiki on start-up, where there will be several subsequent wikiStartup() call
  private readonly justStartedWiki: Record<string, boolean> = {};
  private setWikiStarted(wikiPath: string): void {
    this.justStartedWiki[wikiPath] = true;
    setTimeout(() => {
      delete this.justStartedWiki[wikiPath];
    }, 5000);
  }

  public async wikiStartup(workspace: IWorkspace): Promise<void> {
    // remove $:/StoryList, otherwise it sometimes cause $__StoryList_1.tid to be generated
    try {
      fs.unlinkSync(path.resolve(workspace.name, 'tiddlers', '$__StoryList'));
    } catch {
      // do nothing
    }

    const userName = this.preferenceService.get('userName');
    const userInfo = this.preferenceService.get('github-user-info');
    const { name: wikiPath, gitUrl: githubRepoUrl, port, isSubWiki, id } = workspace;
    // if is main wiki
    if (!isSubWiki) {
      this.setWikiStarted(wikiPath);
      await this.startNodeJSWiki(wikiPath, port, userName, id);
      userInfo && watchWiki(wikiPath, githubRepoUrl, userInfo, path.join(wikiPath, TIDDLERS_PATH));
    } else {
      // if is private repo wiki
      userInfo && watchWiki(wikiPath, githubRepoUrl, userInfo);
      // if we are creating a sub-wiki, restart the main wiki to load content from private wiki
      const mainWikiPath = workspace.mainWikiToLink;
      if (!this.justStartedWiki[mainWikiPath]) {
        // TODO: change to get by mainWikiPath
        const mainWorkspace = this.workspaceService.getByName(mainWikiPath);
        if (mainWorkspace === undefined) {
          throw new Error(`mainWorkspace is undefined in wikiStartup() for mainWikiPath ${mainWikiPath}`);
        }
        await this.stopWatchWiki(mainWikiPath);
        await this.stopWiki(mainWikiPath);
        await this.startWiki(mainWikiPath, mainWorkspace.port, userName);
        await this.watchWiki(mainWikiPath, githubRepoUrl, userInfo);
      }
    }
  }

  // start-nodejs-wiki.ts
  public async startNodeJSWiki(homePath: string, port: number, userName: string, workspaceID: string): Promise<void> {
    if (typeof homePath !== 'string' || homePath.length === 0 || !path.isAbsolute(homePath)) {
      const errorMessage = i18n.t('Dialog.NeedCorrectTiddlywikiFolderPath');
      console.error(errorMessage);
      const mainWindow = this.windowService.get(WindowNames.main);
      if (mainWindow !== undefined) {
        await dialog.showMessageBox(mainWindow, {
          title: i18n.t('Dialog.PathPassInCantUse'),
          message: errorMessage + homePath,
          buttons: ['OK'],
          cancelId: 0,
          defaultId: 0,
        });
      }
      return;
    }
    if (!fs.pathExistsSync(homePath)) {
      const errorMessage = i18n.t('Dialog.CantFindWorkspaceFolderRemoveWorkspace');
      console.error(errorMessage);
      const mainWindow = this.windowService.get(WindowNames.main);
      if (mainWindow !== undefined) {
        const { response } = await dialog.showMessageBox(mainWindow, {
          title: i18n.t('Dialog.WorkspaceFolderRemoved'),
          message: errorMessage + homePath,
          buttons: [i18n.t('Dialog.RemoveWorkspace'), i18n.t('Dialog.DoNotCare')],
          cancelId: 1,
          defaultId: 0,
        });
        if (response === 0) {
          await this.workspaceViewService.removeWorkspaceView(workspaceID);
          // TODO: createMenu
          // const createMenu = require('../create-menu');
          // createMenu();
        }
        return;
      }
    }

    await this.startWiki(homePath, port, userName);
  }

  // watch-wiki.ts
  private readonly syncDebounceInterval = getPreference('syncDebounceInterval');
  private readonly debounceCommitAndSync = debounce(commitAndSync, syncDebounceInterval);

  private readonly frequentlyChangedFileThatShouldBeIgnoredFromWatch = ['output', /\$__StoryList/];
  private readonly topLevelFoldersToIgnored = ['node_modules', '.git'];

  // key is same to workspace name, so we can get this watcher by workspace name
  // { [name: string]: Watcher }
  private readonly wikiWatchers: Record<string, chokidar.FSWatcher> = {};

  public async watchWiki(wikiRepoPath: string, githubRepoUrl: string, userInfo: any, wikiFolderPath = wikiRepoPath): Promise<void> {
    if (!fs.existsSync(wikiRepoPath)) {
      logger.error('Folder not exist in watchFolder()', { wikiRepoPath, wikiFolderPath, githubRepoUrl });
      return;
    }
    const onChange = debounce((fileName: string): void => {
      if (lock) {
        logger.info(`${fileName} changed, but lock is on, so skip`);
        return;
      }
      logger.info(`${fileName} changed`);
      lock = true;
      // TODO: move debounceCommitAndSync() to git service
      debounceCommitAndSync(wikiRepoPath, githubRepoUrl, userInfo).then(() => {
        lock = false;
      });
    }, 1000);
    // simple lock to prevent running two instance of commit task
    let lock = false;
    // load ignore config from .gitignore located in the wiki repo folder
    const gitIgnoreFilePath = path.join(wikiRepoPath, '.gitignore');
    let gitignoreFile = '';
    try {
      gitignoreFile = fs.readFileSync(gitIgnoreFilePath, 'utf-8') ?? '';
    } catch {
      logger.info(`Fail to load .gitignore from ${gitIgnoreFilePath}, this is ok if you don't need a .gitignore in the subwiki.`, {
        wikiRepoPath,
        wikiFolderPath,
        githubRepoUrl,
      });
    }
    const filesToIgnoreFromGitIgnore = compact(gitignoreFile.split('\n').filter((line) => !trim(line).startsWith('#')));
    const watcher = chokidar.watch(wikiFolderPath, {
      ignored: [...filesToIgnoreFromGitIgnore, ...this.topLevelFoldersToIgnored, ...this.frequentlyChangedFileThatShouldBeIgnoredFromWatch],
      cwd: wikiFolderPath,
      awaitWriteFinish: true,
      ignoreInitial: true,
      followSymlinks: false,
    });
    watcher.on('add', onChange);
    watcher.on('change', onChange);
    watcher.on('unlink', onChange);
    await new Promise<void>((resolve) => {
      watcher.on('ready', () => {
        logger.info(`wiki Github syncer is watching ${wikiFolderPath} now`, { wikiRepoPath, wikiFolderPath, githubRepoUrl });
        this.wikiWatchers[wikiRepoPath] = watcher;
        resolve();
      });
    });
  }

  public async stopWatchWiki(wikiRepoPath: string): Promise<void> {
    const watcher = this.wikiWatchers[wikiRepoPath];
    if (watcher !== undefined) {
      await watcher.close();
      logger.info(`Wiki watcher for ${wikiRepoPath} stopped`, { function: 'stopWatchWiki' });
    } else {
      logger.warning(`No wiki watcher for ${wikiRepoPath}`, { function: 'stopWatchWiki' });
    }
  }

  public async stopWatchAllWiki(): Promise<void> {
    const tasks = [];
    for (const homePath of Object.keys(this.wikiWatchers)) {
      tasks.push(this.stopWatchWiki(homePath));
    }
    await Promise.all(tasks);
    logger.info('All wiki watcher is stopped', { function: 'stopWatchAllWiki' });
  }

  updateSubWikiPluginContent(mainWikiPath: string, newConfig?: IWorkspace, oldConfig?: IWorkspace): void {
    return updateSubWikiPluginContent(mainWikiPath, newConfig, oldConfig);
  }
}
