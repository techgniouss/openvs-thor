/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as spdlog from '@vscode/spdlog';
import { ByteSize } from '../../files/common/files.js';
import { AbstractMessageLogger, ILogger, LogLevel } from '../common/log.js';

enum SpdLogLevel {
	Trace,
	Debug,
	Info,
	Warning,
	Error,
	Critical,
	Off
}

async function createSpdLogLogger(name: string, logfilePath: string, filesize: number, filecount: number, donotUseFormatters: boolean): Promise<spdlog.Logger | null> {
	// Do not crash if spdlog cannot be loaded
	try {
		// @ts-ignore
		const _spdlog = typeof require !== 'undefined' ? require('@vscode/spdlog') : undefined;
		if (!_spdlog) {
			throw new Error('require is not defined');
		}
		_spdlog.setFlushOn(SpdLogLevel.Trace);
		const logger = await _spdlog.createAsyncRotatingLogger(name, logfilePath, filesize, filecount);
		if (donotUseFormatters) {
			logger.clearFormatters();
		} else {
			logger.setPattern('%Y-%m-%d %H:%M:%S.%e [%l] %v');
		}
		return logger;
	} catch (e) {
		console.error(e);
	}
	return null;
}

/**
 * Minimal console-backed stand-in used when the @vscode/spdlog native module
 * cannot be loaded, so log output stays visible instead of being buffered forever.
 */
function createConsoleFallbackLogger(name: string): spdlog.Logger {
	const prefix = `[${name}]`;
	return {
		trace(message: string) { console.debug(prefix, message); },
		debug(message: string) { console.debug(prefix, message); },
		info(message: string) { console.info(prefix, message); },
		warn(message: string) { console.warn(prefix, message); },
		error(message: string) { console.error(prefix, message); },
		critical(message: string) { console.error(prefix, message); },
		flush() { },
		drop() { },
		clearFormatters() { },
		setPattern(_pattern: string) { },
		setLevel(_level: number) { },
	} as unknown as spdlog.Logger;
}

interface ILog {
	level: LogLevel;
	message: string;
}

function log(logger: spdlog.Logger, level: LogLevel, message: string): void {
	switch (level) {
		case LogLevel.Trace: logger.trace(message); break;
		case LogLevel.Debug: logger.debug(message); break;
		case LogLevel.Info: logger.info(message); break;
		case LogLevel.Warning: logger.warn(message); break;
		case LogLevel.Error: logger.error(message); break;
		case LogLevel.Off: /* do nothing */ break;
		default: throw new Error(`Invalid log level ${level}`);
	}
}

function setLogLevel(logger: spdlog.Logger, level: LogLevel): void {
	switch (level) {
		case LogLevel.Trace: logger.setLevel(SpdLogLevel.Trace); break;
		case LogLevel.Debug: logger.setLevel(SpdLogLevel.Debug); break;
		case LogLevel.Info: logger.setLevel(SpdLogLevel.Info); break;
		case LogLevel.Warning: logger.setLevel(SpdLogLevel.Warning); break;
		case LogLevel.Error: logger.setLevel(SpdLogLevel.Error); break;
		case LogLevel.Off: logger.setLevel(SpdLogLevel.Off); break;
		default: throw new Error(`Invalid log level ${level}`);
	}
}

export class SpdLogLogger extends AbstractMessageLogger implements ILogger {

	private buffer: ILog[] = [];
	private readonly _loggerCreationPromise: Promise<void>;
	private _logger: spdlog.Logger | undefined;

	constructor(
		name: string,
		filepath: string,
		rotating: boolean,
		donotUseFormatters: boolean,
		level: LogLevel,
	) {
		super();
		this.setLevel(level);
		this._loggerCreationPromise = this._createSpdLogLogger(name, filepath, rotating, donotUseFormatters);
		this._register(this.onDidChangeLogLevel(level => {
			if (this._logger) {
				setLogLevel(this._logger, level);
			}
		}));
	}

	private async _createSpdLogLogger(name: string, filepath: string, rotating: boolean, donotUseFormatters: boolean): Promise<void> {
		const filecount = rotating ? 6 : 1;
		const filesize = (30 / filecount) * ByteSize.MB;
		const logger = await createSpdLogLogger(name, filepath, filesize, filecount, donotUseFormatters);
		this._logger = logger ?? createConsoleFallbackLogger(name);
		setLogLevel(this._logger, this.getLevel());
		for (const { level, message } of this.buffer) {
			log(this._logger, level, message);
		}
		this.buffer = [];
	}

	protected log(level: LogLevel, message: string): void {
		if (this._logger) {
			log(this._logger, level, message);
		} else if (this.getLevel() <= level) {
			this.buffer.push({ level, message });
		}
	}

	override flush(): void {
		if (this._logger) {
			this.flushLogger();
		} else {
			this._loggerCreationPromise.then(() => this.flushLogger());
		}
	}

	override dispose(): void {
		if (this._logger) {
			this.disposeLogger();
		} else {
			this._loggerCreationPromise.then(() => this.disposeLogger());
		}
		super.dispose();
	}

	private flushLogger(): void {
		if (this._logger) {
			this._logger.flush();
		}
	}

	private disposeLogger(): void {
		if (this._logger) {
			this._logger.drop();
			this._logger = undefined;
		}
	}
}
