/**
 * File Watcher Service
 * Monitors a folder for changes and automatically updates the default topic
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { Logger } from "./logger";
import { TopicManager } from "../managers/topicManager";
import { CONFIG, DEFAULTS, EXTENSION } from "./constants";
import { ProgressTracker } from "./progressTracker";

export class FileWatcherService {
  private logger: Logger;
  private watchers: Map<string, vscode.FileSystemWatcher> = new Map();
  private topicManager: TopicManager;
  private context: vscode.ExtensionContext;
  private watchFolders: string[] = [];
  private isRecursive: boolean = true;
  private includeExtensions: string[] = [];
  private defaultTopicId: string | null = null;
  private progressTracker: ProgressTracker;
  private watchOnChanges: boolean = false;
  
  // Debounce timer to batch multiple changes
  private updateTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Set<string> = new Set();

  constructor(context: vscode.ExtensionContext, topicManager: TopicManager) {
    this.logger = new Logger("FileWatcherService");
    this.context = context;
    this.topicManager = topicManager;
    this.progressTracker = ProgressTracker.getInstance();
  }

  /**
   * Initialize the file watcher based on current configuration
   */
  public async initialize(): Promise<void> {
    this.logger.info("Initializing FileWatcherService");

    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const configuredFolders = config.get<string[]>(CONFIG.WATCH_FOLDERS, []);
    const legacyFolder = config.get<string>(CONFIG.WATCH_FOLDER, "");
    this.watchOnChanges = config.get<boolean>(CONFIG.WATCH_ON_CHANGES, false);
    this.isRecursive = true;
    this.includeExtensions = config.get<string[]>(
      "includeExtensions",
      DEFAULTS.INCLUDE_EXTENSIONS
    );
    if (this.includeExtensions.length === 0) {
      this.includeExtensions = DEFAULTS.INCLUDE_EXTENSIONS;
    }
    this.includeExtensions = this.includeExtensions.map((ext) => ext.toLowerCase());

    this.watchFolders = this.normalizeWatchFolders(configuredFolders, legacyFolder);

    if (this.watchFolders.length === 0) {
      this.logger.info("No watch folders configured, skipping file watcher setup");
      return;
    }

    // Ensure the watch folders exist
    const validFolders: string[] = [];
    for (const folder of this.watchFolders) {
      try {
        const stats = await fs.stat(folder);
        if (!stats.isDirectory()) {
          this.logger.warn("Watch folder is not a directory", { path: folder });
          vscode.window.showWarningMessage(
            `Watch folder is not a directory: ${folder}`
          );
          continue;
        }
        validFolders.push(folder);
      } catch (error) {
        this.logger.warn("Watch folder does not exist", { path: folder });
        vscode.window.showWarningMessage(
          `Watch folder does not exist: ${folder}`
        );
      }
    }

    if (validFolders.length === 0) {
      this.logger.info("No valid watch folders found, skipping file watcher setup");
      return;
    }

    this.watchFolders = validFolders;

    // Ensure default topic exists (reuses TopicManager's method)
    await this.topicManager.ensureInitialized();
    const defaultTopic = await this.topicManager.ensureDefaultTopic();
    this.defaultTopicId = defaultTopic.id;
    this.logger.info("Default topic ready for folder watching", { topicId: this.defaultTopicId });

    // Only proceed if watching is enabled
    if (!this.watchOnChanges) {
      this.logger.info("File watching is disabled (watchOnChanges is false). Enable it to start indexing.");
      return;
    }

    // Defer seeding to idle to not block extension activation
    this.logger.info("Deferring folder seeding to idle...");
    setTimeout(async () => {
      try {
        // Re-check if still enabled (user might have disabled in the meantime)
        const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
        if (!config.get<boolean>(CONFIG.WATCH_ON_CHANGES, false)) {
          this.logger.info("Watch disabled before seeding started, skipping");
          return;
        }
        
        // Seed default topic with existing files in watch folders
        await this.seedDefaultTopicFromExistingFiles();

        // Setup file watchers after seeding completes
        await this.setupWatchers();
      } catch (error) {
        this.logger.error("Failed to seed watch folders", { error });
      }
    }, 2000); // Wait 2 seconds for extension to fully initialize
  }

  /**
   * Setup file system watchers for all configured folders
   */
  private async setupWatchers(): Promise<void> {
    if (this.watchFolders.length === 0 || !this.defaultTopicId) {
      return;
    }

    for (const folder of this.watchFolders) {
      await this.setupWatcherForFolder(folder);
    }

    const folderLabel = this.watchFolders.length === 1
      ? this.watchFolders[0]
      : `${this.watchFolders.length} folders`;

    this.logger.info("File watchers active", {
      folders: this.watchFolders,
      recursive: this.isRecursive
    });

    // Note: Removed notification message - status is shown in tree view instead
  }

  /**
   * Setup file system watcher for a specific folder
   */
  private async setupWatcherForFolder(folder: string): Promise<void> {
    if (!folder || !this.defaultTopicId) {
      return;
    }

    // Dispose existing watcher for folder if any
    const existingWatcher = this.watchers.get(folder);
    if (existingWatcher) {
      existingWatcher.dispose();
      this.watchers.delete(folder);
    }

    const pattern = this.isRecursive
      ? new vscode.RelativePattern(folder, "**/*")
      : new vscode.RelativePattern(folder, "*");

    this.logger.info("Creating file watcher", {
      folder,
      recursive: this.isRecursive,
      pattern: pattern.pattern
    });

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => {
      this.logger.debug("File created", { path: uri.fsPath });
      this.handleFileChange(uri, "create");
    });

    watcher.onDidChange((uri) => {
      this.logger.debug("File changed", { path: uri.fsPath });
      this.handleFileChange(uri, "change");
    });

    watcher.onDidDelete((uri) => {
      this.logger.debug("File deleted", { path: uri.fsPath });
      this.handleFileChange(uri, "delete");
    });

    this.watchers.set(folder, watcher);
  }

  /**
   * Normalize and resolve watch folders
   */
  private normalizeWatchFolders(configuredFolders: string[], legacyFolder: string): string[] {
    const rawFolders = [...configuredFolders];
    if (legacyFolder && legacyFolder.trim().length > 0) {
      rawFolders.push(legacyFolder);
    }

    const resolved = rawFolders
      .map((folder) => folder.trim())
      .filter((folder) => folder.length > 0)
      .map((folder) => this.resolveFolderPath(folder))
      .filter((folder) => folder.length > 0); // Filter out invalid paths

    const unique = Array.from(new Set(resolved));
    return unique;
  }

  /**
   * Resolve workspace-relative folder paths
   * Only allows paths within workspace folders
   */
  private resolveFolderPath(folder: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.logger.warn("No workspace folders found, cannot resolve watch folder", { folder });
      return "";
    }

    // If it's an absolute path, ensure it's within a workspace folder
    if (path.isAbsolute(folder)) {
      const isInWorkspace = workspaceFolders.some(wsFolder => 
        folder.startsWith(wsFolder.uri.fsPath)
      );
      if (isInWorkspace) {
        return folder;
      } else {
        this.logger.warn("Absolute path is outside workspace, ignoring", { folder });
        return "";
      }
    }

    // Resolve relative paths within the first workspace folder
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const resolved = path.resolve(workspaceRoot, folder);
    
    // Verify the resolved path is still within workspace
    const isInWorkspace = workspaceFolders.some(wsFolder => 
      resolved.startsWith(wsFolder.uri.fsPath)
    );
    
    if (!isInWorkspace) {
      this.logger.warn("Resolved path is outside workspace, ignoring", { folder, resolved });
      return "";
    }
    
    return resolved;
  }

  /**
   * Seed default topic with existing files in watch folders
   */
  private async seedDefaultTopicFromExistingFiles(): Promise<void> {
    if (!this.defaultTopicId || this.watchFolders.length === 0) {
      return;
    }

    const filesToProcess = new Set<string>();
    for (const folder of this.watchFolders) {
      const folderFiles = await this.collectFilesFromDirectory(
        folder,
        this.isRecursive,
        this.includeExtensions
      );
      for (const filePath of folderFiles) {
        filesToProcess.add(filePath);
      }
    }

    const existingFiles = Array.from(filesToProcess);
    if (existingFiles.length === 0) {
      this.logger.info("No existing files found in watch folders to seed");
      return;
    }

    this.logger.info("Seeding default topic with existing files", {
      count: existingFiles.length,
      folders: this.watchFolders
    });

    const defaultTopic = this.topicManager.getTopic(this.defaultTopicId);
    const topicName = defaultTopic?.name || EXTENSION.DEFAULT_TOPIC_NAME;

    this.progressTracker.startTracking(
      this.defaultTopicId,
      topicName,
      existingFiles.length
    );

    // Process files without showing notification - status shown in tree view
    try {
      const processFiles = async () => {
        this.logger.info(`Processing ${existingFiles.length} file(s) from watched folders`);

        await this.topicManager.ensureInitialized();

        let processedCount = 0;
        for (const filePath of existingFiles) {
          // Check for pause at each file
          await this.progressTracker.waitIfPaused(this.defaultTopicId!);

          try {
            const fileName = path.basename(filePath);
            this.progressTracker.updateProgress(this.defaultTopicId!, {
              stage: "removing",
              currentFile: fileName,
              processedFiles: processedCount,
            });

            await this.topicManager.removeDocumentByFilePath(
              this.defaultTopicId!,
              filePath
            );
          } catch (error) {
            this.logger.debug("Could not remove old document (might be new)", {
              filePath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        this.logger.info(`Adding ${existingFiles.length} file(s) from watched folders`);
        processedCount = 0;
        let successCount = 0;

        // Process files one at a time so we can pause between them
        for (const filePath of existingFiles) {
          // Check for pause at each file
          await this.progressTracker.waitIfPaused(this.defaultTopicId!);

          try {
            const results = await this.topicManager.addDocuments(
              this.defaultTopicId!,
              [filePath],
              {
                onProgress: (pipelineProgress) => {
                  this.progressTracker.updateProgress(this.defaultTopicId!, {
                    stage: pipelineProgress.stage,
                    currentFile: pipelineProgress.details?.fileName || path.basename(filePath),
                    processedFiles: processedCount,
                    percentage: Math.round((processedCount / existingFiles.length) * 100),
                  });
                },
              }
            );

            if (results.length > 0) {
              successCount++;
            }
          } catch (error) {
            this.logger.warn("Failed to add document during seeding", {
              filePath,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          processedCount++;
        }

        this.logger.info("Watch folder seed complete", {
          processed: existingFiles.length,
          successful: successCount,
        });

        this.progressTracker.completeTracking(this.defaultTopicId!);
      };
      
      await processFiles();
    } catch (error) {
      this.logger.error("Failed during seeding", { error });
      this.progressTracker.cancelTracking(this.defaultTopicId!);
    }
  }

  /**
   * Collect files from a directory
   */
  private async collectFilesFromDirectory(
    dirPath: string,
    recursive: boolean,
    includeExtensions: string[]
  ): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (recursive) {
            const subFiles = await this.collectFilesFromDirectory(
              fullPath,
              recursive,
              includeExtensions
            );
            files.push(...subFiles);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (includeExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      this.logger.warn("Failed to read directory during seeding", {
        error: error instanceof Error ? error.message : String(error),
        dirPath,
      });
    }

    return files;
  }

  /**
   * Handle file change events
   */
  private handleFileChange(uri: vscode.Uri, changeType: "create" | "change" | "delete"): void {
    const filePath = uri.fsPath;
    
    // Check if file has a supported extension
    const ext = path.extname(filePath);
    if (!this.includeExtensions.some(e => e.toLowerCase() === ext.toLowerCase())) {
      this.logger.debug("Skipping file with unsupported extension", { path: filePath, ext });
      return;
    }

    // Add to pending changes
    this.pendingChanges.add(filePath);

    // Debounce: wait for 2 seconds of inactivity before processing
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    this.updateTimer = setTimeout(() => {
      this.processQueuedChanges();
    }, 2000);
  }

  /**
   * Process all queued file changes
   */
  private async processQueuedChanges(): Promise<void> {
    if (this.pendingChanges.size === 0 || !this.defaultTopicId) {
      this.logger.debug("Skipping update - no changes or no default topic");
      return;
    }

    const changedFiles = Array.from(this.pendingChanges);
    this.pendingChanges.clear();
    this.updateTimer = null;

    this.logger.info("Processing file changes", { count: changedFiles.length });

    try {
      // Filter to only existing files (new or modified)
      const existingFiles: string[] = [];
      for (const filePath of changedFiles) {
        try {
          await fs.access(filePath);
          existingFiles.push(filePath);
        } catch {
          // File was deleted or doesn't exist, skip it
          this.logger.debug("Skipping deleted or inaccessible file", { path: filePath });
        }
      }

      if (existingFiles.length === 0) {
        this.logger.info("No files to add after filtering");
        return;
      }

      // Get topic name for progress tracking
      const defaultTopic = this.topicManager.getTopic(this.defaultTopicId!);
      const topicName = defaultTopic?.name || EXTENSION.DEFAULT_TOPIC_NAME;

      // Start progress tracking
      this.progressTracker.startTracking(
        this.defaultTopicId!,
        topicName,
        existingFiles.length
      );

      // Add documents to default topic
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Updating watched folder documents...`,
          cancellable: true,
        },
        async (progress, token) => {
          // Handle cancellation via pause
          token.onCancellationRequested(() => {
            this.progressTracker.pause();
          });

          progress.report({ message: `Processing ${existingFiles.length} file(s)...` });

          await this.topicManager.ensureInitialized();
          
          // Remove old versions of documents before adding new ones
          // This ensures that modified files don't have duplicate chunks
          let processedCount = 0;
          for (const filePath of existingFiles) {
            // Check for pause at each file
            await this.progressTracker.waitIfPaused(this.defaultTopicId!);

            try {
              const fileName = path.basename(filePath);
              progress.report({ message: `Removing old version of ${fileName}...` });
              this.progressTracker.updateProgress(this.defaultTopicId!, {
                stage: "removing",
                currentFile: fileName,
                processedFiles: processedCount,
              });
              
              await this.topicManager.removeDocumentByFilePath(
                this.defaultTopicId!,
                filePath
              );
            } catch (error) {
              // If removal fails, log but continue - might be a new file
              this.logger.debug("Could not remove old document (might be new)", {
                filePath,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          
          // Add documents to default topic
          progress.report({ message: `Adding ${existingFiles.length} file(s)...` });
          processedCount = 0;
          let successCount = 0;

          // Process files one at a time so we can pause between them
          for (const filePath of existingFiles) {
            // Check for pause at each file
            await this.progressTracker.waitIfPaused(this.defaultTopicId!);

            try {
              const results = await this.topicManager.addDocuments(
                this.defaultTopicId!,
                [filePath],
                {
                  onProgress: (pipelineProgress) => {
                    progress.report({ message: pipelineProgress.message });
                
                    // Update progress tracker with pipeline details
                    this.progressTracker.updateProgress(this.defaultTopicId!, {
                      stage: pipelineProgress.stage,
                      currentFile: pipelineProgress.details?.fileName || path.basename(filePath),
                      processedFiles: processedCount,
                      percentage: Math.round((processedCount / existingFiles.length) * 100),
                    });
                  },
                }
              );

              if (results.length > 0) {
                successCount++;
              }
            } catch (error) {
              this.logger.warn("Failed to add document", {
                filePath,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            processedCount++;
          }

          this.logger.info("Watch folder update complete", {
            processed: existingFiles.length,
            successful: successCount,
          });

          // Complete progress tracking
          this.progressTracker.completeTracking(this.defaultTopicId!);

          // Note: Removed notification message - status is shown in tree view instead
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Failed to process file changes", { error: errorMessage });
      
      // Cancel progress tracking on error
      if (this.defaultTopicId) {
        this.progressTracker.cancelTracking(this.defaultTopicId);
      }
      
      vscode.window.showErrorMessage(
        `Failed to update watched folder: ${errorMessage}`
      );
    }
  }

  /**
   * Update configuration and restart watcher if needed
   */
  public async updateConfiguration(): Promise<void> {
    this.logger.info("Updating configuration");

    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const configuredFolders = config.get<string[]>(CONFIG.WATCH_FOLDERS, []);
    const legacyFolder = config.get<string>(CONFIG.WATCH_FOLDER, "");
    const newWatchOnChanges = config.get<boolean>(CONFIG.WATCH_ON_CHANGES, false);
    let newExtensions = config.get<string[]>("includeExtensions", DEFAULTS.INCLUDE_EXTENSIONS);
    if (newExtensions.length === 0) {
      newExtensions = DEFAULTS.INCLUDE_EXTENSIONS;
    }
    newExtensions = newExtensions.map((ext) => ext.toLowerCase());

    const newWatchFolders = this.normalizeWatchFolders(configuredFolders, legacyFolder);

    // Check if configuration changed
    const configChanged =
      JSON.stringify(newWatchFolders) !== JSON.stringify(this.watchFolders) ||
      JSON.stringify(newExtensions) !== JSON.stringify(this.includeExtensions) ||
      newWatchOnChanges !== this.watchOnChanges;

    if (!configChanged) {
      this.logger.debug("Configuration unchanged, no restart needed");
      return;
    }

    // Update configuration
    this.watchFolders = newWatchFolders;
    this.isRecursive = true;
    this.includeExtensions = newExtensions;
    this.watchOnChanges = newWatchOnChanges;

    // Restart watcher
    await this.dispose();
    await this.initialize();
  }

  /**
   * Get current watch status
   */
  public isWatchingEnabled(): boolean {
    return this.watchOnChanges && this.watchFolders.length > 0;
  }

  /**
   * Toggle watch on/off
   */
  public async toggleWatch(): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const newValue = !this.watchOnChanges;
    await config.update(CONFIG.WATCH_ON_CHANGES, newValue, vscode.ConfigurationTarget.Workspace);
    this.logger.info(`File watching ${newValue ? "enabled" : "disabled"}`);
  }

  /**
   * Dispose of the file watcher
   */
  public async dispose(): Promise<void> {
    this.logger.info("Disposing FileWatcherService");

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();

    this.pendingChanges.clear();
    this.defaultTopicId = null;
  }
}
