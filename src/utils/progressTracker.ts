/**
 * Progress Tracker Service
 * Tracks ongoing document indexing operations and provides progress information
 * for display in the tree view
 */

import { EventEmitter } from "events";
import { Logger } from "./logger";

export interface ActiveFileInfo {
  /** Relative path to the file */
  relativePath: string;
  /** Absolute path to the file */
  absolutePath: string;
  /** Current processing stage */
  stage: "loading" | "chunking" | "embedding" | "storing";
  /** Number of chunks generated (available after chunking) */
  chunkCount?: number;
  /** Start time of processing */
  startTime: number;
}

export interface IndexingProgress {
  topicId: string;
  topicName: string;
  totalFiles: number;
  processedFiles: number;
  currentFile?: string;
  stage: "removing" | "loading" | "chunking" | "embedding" | "storing" | "complete";
  percentage: number;
  startTime: number;
  /** Currently active files being processed (for parallel processing) */
  activeFiles?: Map<string, ActiveFileInfo>;
}

/**
 * Singleton service to track document indexing progress across the extension
 */
export class ProgressTracker {
  private static instance: ProgressTracker;
  private logger: Logger;
  private activeOperations: Map<string, IndexingProgress> = new Map();
  private emitter: EventEmitter;
  private _isPaused: boolean = false; // Actual pause state managed by togglePause
  private pauseResolvers: Map<string, (() => void)[]> = new Map();

  private constructor() {
    this.logger = new Logger("ProgressTracker");
    this.emitter = new EventEmitter();
  }

  public static getInstance(): ProgressTracker {
    if (!ProgressTracker.instance) {
      ProgressTracker.instance = new ProgressTracker();
    }
    return ProgressTracker.instance;
  }

  /**
   * Register event listener
   */
  public on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener);
  }

  /**
   * Emit event
   */
  private emit(event: string, ...args: any[]): void {
    this.emitter.emit(event, ...args);
  }

  /**
   * Start tracking progress for a topic
   */
  public startTracking(
    topicId: string,
    topicName: string,
    totalFiles: number
  ): void {
    this.logger.info("Starting progress tracking", { topicId, topicName, totalFiles });

    const progress: IndexingProgress = {
      topicId,
      topicName,
      totalFiles,
      processedFiles: 0,
      stage: "loading",
      percentage: 0,
      startTime: Date.now(),
      activeFiles: new Map(),
    };

    this.activeOperations.set(topicId, progress);
    this.emit("progress", topicId, progress);
  }

  /**
   * Update progress for a topic
   */
  public updateProgress(
    topicId: string,
    updates: Partial<IndexingProgress>
  ): void {
    const progress = this.activeOperations.get(topicId);
    if (!progress) {
      this.logger.warn("Attempted to update non-existent progress tracking", { topicId });
      return;
    }

    // Update progress fields
    Object.assign(progress, updates);

    // Calculate percentage if not provided
    if (updates.processedFiles !== undefined && !updates.percentage) {
      progress.percentage = Math.round(
        (progress.processedFiles / progress.totalFiles) * 100
      );
    }

    this.activeOperations.set(topicId, progress);
    this.emit("progress", topicId, progress);

    this.logger.debug("Progress updated", {
      topicId,
      processedFiles: progress.processedFiles,
      totalFiles: progress.totalFiles,
      percentage: progress.percentage,
    });
  }

  /**
   * Mark progress as complete for a topic
   */
  public completeTracking(topicId: string): void {
    const progress = this.activeOperations.get(topicId);
    if (!progress) {
      return;
    }

    progress.stage = "complete";
    progress.percentage = 100;
    progress.processedFiles = progress.totalFiles;
    progress.activeFiles?.clear();

    this.logger.info("Progress tracking complete", {
      topicId,
      duration: Date.now() - progress.startTime,
    });

    this.emit("progress", topicId, progress);

    // Remove after a short delay so UI can show completion
    setTimeout(() => {
      this.activeOperations.delete(topicId);
      this.emit("complete", topicId);
    }, 2000);
  }

  /**
   * Cancel progress tracking for a topic
   */
  public cancelTracking(topicId: string): void {
    this.activeOperations.delete(topicId);
    this.emit("complete", topicId);
    this.logger.info("Progress tracking cancelled", { topicId });
  }

  /**
   * Get current progress for a topic
   */
  public getProgress(topicId: string): IndexingProgress | undefined {
    return this.activeOperations.get(topicId);
  }

  /**
   * Get all active progress operations
   */
  public getAllProgress(): IndexingProgress[] {
    return Array.from(this.activeOperations.values());
  }

  /**
   * Check if a topic has active indexing
   */
  public hasActiveIndexing(topicId: string): boolean {
    return this.activeOperations.has(topicId);
  }

  /**
   * Start tracking an active file being processed
   */
  public startFileProcessing(
    topicId: string,
    absolutePath: string,
    relativePath: string,
    stage: ActiveFileInfo["stage"] = "loading"
  ): void {
    const progress = this.activeOperations.get(topicId);
    if (!progress) {
      return;
    }

    if (!progress.activeFiles) {
      progress.activeFiles = new Map();
    }

    progress.activeFiles.set(absolutePath, {
      absolutePath,
      relativePath,
      stage,
      startTime: Date.now(),
    });

    this.emit("progress", topicId, progress);
  }

  /**
   * Update an active file's processing stage and chunk count
   */
  public updateFileProcessing(
    topicId: string,
    absolutePath: string,
    updates: Partial<Pick<ActiveFileInfo, "stage" | "chunkCount">>
  ): void {
    const progress = this.activeOperations.get(topicId);
    if (!progress?.activeFiles) {
      return;
    }

    const fileInfo = progress.activeFiles.get(absolutePath);
    if (fileInfo) {
      Object.assign(fileInfo, updates);
      this.emit("progress", topicId, progress);
    }
  }

  /**
   * Complete file processing and remove from active files
   */
  public completeFileProcessing(topicId: string, absolutePath: string): void {
    const progress = this.activeOperations.get(topicId);
    if (!progress?.activeFiles) {
      return;
    }

    progress.activeFiles.delete(absolutePath);
    this.emit("progress", topicId, progress);
  }

  /**
   * Get list of currently active files for a topic
   */
  public getActiveFiles(topicId: string): ActiveFileInfo[] {
    const progress = this.activeOperations.get(topicId);
    if (!progress?.activeFiles) {
      return [];
    }
    return Array.from(progress.activeFiles.values());
  }

  /**
   * Clear all progress tracking
   */
  public clearAll(): void {
    this.activeOperations.clear();
    this.emit("clear");
  }

  /**
   * Check if indexing is currently paused
   */
  public get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Pause indexing operations
   */
  public pause(): void {
    if (this._isPaused) {
      return;
    }
    this._isPaused = true;
    this.logger.info("Indexing paused");
    this.emit("pause");
    this.emit("progress"); // Trigger UI update
  }

  /**
   * Resume indexing operations
   */
  public resume(): void {
    if (!this._isPaused) {
      return;
    }
    this._isPaused = false;
    this.logger.info("Indexing resumed");
    
    // Resolve all waiting pause promises
    for (const resolvers of this.pauseResolvers.values()) {
      for (const resolve of resolvers) {
        resolve();
      }
    }
    this.pauseResolvers.clear();
    
    this.emit("resume");
    this.emit("progress"); // Trigger UI update
  }

  /**
   * Toggle pause/resume state
   */
  public togglePause(): void {
    if (this._isPaused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  /**
   * Wait if indexing is paused. Call this at checkpoints in the indexing process.
   * @param topicId The topic ID to associate with this wait
   * @returns Promise that resolves when not paused
   */
  public async waitIfPaused(topicId: string): Promise<void> {
    if (!this._isPaused) {
      return;
    }

    this.logger.debug("Waiting for resume", { topicId });

    return new Promise<void>((resolve) => {
      if (!this.pauseResolvers.has(topicId)) {
        this.pauseResolvers.set(topicId, []);
      }
      this.pauseResolvers.get(topicId)!.push(resolve);
    });
  }

  /**
   * Check if there are any active indexing operations
   */
  public hasActiveOperations(): boolean {
    return this.activeOperations.size > 0;
  }
}
