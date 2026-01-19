/**
 * Logging utility for LocalRAG
 * Provides structured logging with different levels and context
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CONFIG } from './constants';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private context: string;
  private static outputChannel: vscode.OutputChannel | null = null;
  private static logLevel: LogLevel = LogLevel.INFO;
  private static isInitialized: boolean = false;
  private static fileLogPath: string | null = null;
  private static fileLogStream: fs.WriteStream | null = null;

  /**
   * Initialize the logger early in extension lifecycle
   * This ensures output channel is available as soon as possible
   */
  public static initialize(): void {
    if (!Logger.outputChannel) {
      Logger.outputChannel = vscode.window.createOutputChannel('LocalRAG');
      Logger.outputChannel.appendLine('[STARTUP] LocalRAG extension starting...');
      Logger.outputChannel.appendLine(`[STARTUP] Timestamp: ${new Date().toISOString()}`);
      Logger.isInitialized = true;
      
      // Initialize file logging
      Logger.initializeFileLogging();
    }
  }

  /**
   * Initialize file logging to tmp directory
   */
  private static initializeFileLogging(): void {
    try {
      const tmpDir = os.tmpdir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Logger.fileLogPath = path.join(tmpDir, `localrag-${timestamp}.log`);
      Logger.fileLogStream = fs.createWriteStream(Logger.fileLogPath, { flags: 'a' });
      
      Logger.outputChannel?.appendLine(`[STARTUP] Log file: ${Logger.fileLogPath}`);
      Logger.fileLogStream.write(`[STARTUP] LocalRAG extension starting...\n`);
      Logger.fileLogStream.write(`[STARTUP] Timestamp: ${new Date().toISOString()}\n`);
    } catch (error) {
      Logger.outputChannel?.appendLine(`[STARTUP] Failed to initialize file logging: ${error}`);
    }
  }

  /**
   * Get the current log file path
   */
  public static getLogFilePath(): string | null {
    return Logger.fileLogPath;
  }

  /**
   * Initialize from configuration
   * Should be called after workspace config is available
   */
  public static initializeFromConfig(): void {
    Logger.initialize();
    const configLevel = Logger.getConfiguredLogLevel();
    Logger.setLogLevel(configLevel);
    Logger.outputChannel?.appendLine(`[STARTUP] Log level set to: ${LogLevel[configLevel]}`);
  }

  constructor(context: string) {
    this.context = context;
    Logger.initialize();
  }

  /**
   * Set global log level
   */
  public static setLogLevel(level: LogLevel): void {
    Logger.logLevel = level;
  }

  /**
   * Get log level from configuration
   */
  public static getConfiguredLogLevel(): LogLevel {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const levelStr = config.get<string>(CONFIG.LOG_LEVEL, 'info').toLowerCase();

    switch (levelStr) {
      case 'debug':
        return LogLevel.DEBUG;
      case 'info':
        return LogLevel.INFO;
      case 'warn':
        return LogLevel.WARN;
      case 'error':
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }

  /**
   * Log debug message
   */
  public debug(message: string, ...args: any[]): void {
    this.log(LogLevel.DEBUG, message, args);
  }

  /**
   * Log info message
   */
  public info(message: string, ...args: any[]): void {
    this.log(LogLevel.INFO, message, args);
  }

  /**
   * Log warning message
   */
  public warn(message: string, ...args: any[]): void {
    this.log(LogLevel.WARN, message, args);
  }

  /**
   * Log error message
   */
  public error(message: string, error?: Error | unknown): void {
    this.log(LogLevel.ERROR, message, error);

    if (error instanceof Error && error.stack) {
      Logger.outputChannel?.appendLine(error.stack);
    }
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, data?: any): void {
    // Check if we should log this level
    if (level < Logger.logLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const prefix = `[${timestamp}] [${levelStr}] [${this.context}]`;

    const logLine = `${prefix} ${message}`;
    Logger.outputChannel?.appendLine(logLine);
    Logger.fileLogStream?.write(logLine + '\n');

    if (data !== undefined && data !== null) {
      try {
        if (typeof data === 'object') {
          const dataStr = JSON.stringify(data, null, 2);
          Logger.outputChannel?.appendLine(dataStr);
          Logger.fileLogStream?.write(dataStr + '\n');
        } else {
          const dataStr = String(data);
          Logger.outputChannel?.appendLine(dataStr);
          Logger.fileLogStream?.write(dataStr + '\n');
        }
      } catch (err) {
        const errStr = `[Error stringifying data: ${err}]`;
        Logger.outputChannel?.appendLine(errStr);
        Logger.fileLogStream?.write(errStr + '\n');
      }
    }
  }

  /**
   * Log action start (debug level)
   */
  public actionStart(action: string, details?: any): void {
    this.debug(`➡️  Starting: ${action}`, details);
  }

  /**
   * Log action completion (debug level)
   */
  public actionComplete(action: string, details?: any): void {
    this.debug(`✅ Completed: ${action}`, details);
  }

  /**
   * Log action failure (error level)
   */
  public actionFailed(action: string, error?: Error | unknown): void {
    this.error(`❌ Failed: ${action}`, error);
  }

  /**
   * Show the output channel
   */
  public show(): void {
    Logger.outputChannel?.show();
  }

  /**
   * Show the output channel (static)
   */
  public static showChannel(): void {
    Logger.outputChannel?.show();
  }

  /**
   * Clear the output channel
   */
  public static clear(): void {
    Logger.outputChannel?.clear();
  }

  /**
   * Dispose the output channel
   */
  public static dispose(): void {
    Logger.outputChannel?.dispose();
    Logger.outputChannel = null;
    Logger.fileLogStream?.end();
    Logger.fileLogStream = null;
  }
}
