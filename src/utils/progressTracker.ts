/**
 * Progress Tracker Service
 * Tracks ongoing document indexing operations and provides progress information
 * for display in the tree view
 */

import { EventEmitter } from "events";
import { Logger } from "./logger";

export interface IndexingProgress {
  topicId: string;
  topicName: string;
  totalFiles: number;
  processedFiles: number;
  currentFile?: string;
  stage: "removing" | "loading" | "chunking" | "embedding" | "storing" | "complete";
  percentage: number;
  startTime: number;
}

/**
 * Singleton service to track document indexing progress across the extension
 */
export class ProgressTracker {
  private static instance: ProgressTracker;
  private logger: Logger;
  private activeOperations: Map<string, IndexingProgress> = new Map();
  private emitter: EventEmitter;

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
   * Clear all progress tracking
   */
  public clearAll(): void {
    this.activeOperations.clear();
    this.emit("clear");
  }
}
