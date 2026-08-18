/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 6c of "remote control": reassembly for `attachImage`'s chunked upload. A remote (PWA)
 * client cannot paste/drop into a native file input the way the desktop webview can (see
 * `media/main.js`'s `resizeImage`/`pendingImages`, which this deliberately does not touch), so
 * it instead resizes an image client-side and sends it as a sequence of base64 text chunks —
 * slices of one already-base64-encoded string, not independently re-encoded fragments, so
 * reassembly is plain string concatenation in index order rather than anything byte-alignment-
 * sensitive.
 *
 * This file is intentionally `vscode`-free (pure data plus one class) so `scripts/test-
 * attachments.mjs` can exercise it directly, the same reason `src/remote/policy.ts` and
 * `src/session/store.ts` stay import-free of `vscode`. The impure half — reading the result
 * into `SessionStore`, replying over `SessionBus` — lives in `chatViewProvider.ts`'s thin
 * `handleAttachImage` glue, not here.
 *
 * Security boundary (see `policy.ts`'s `attachImage` entry for the fuller reasoning): the caps
 * below are enforced host-side regardless of what a client claims about `total`/`index`, or
 * how many uploads it starts — the client-side resize-before-encode is a courtesy for
 * well-behaved clients, not what makes this safe to expose to a remote device.
 */

/** One chunk of an in-progress `attachImage` upload, as received from the wire. */
export interface AttachImageChunk {
	readonly sessionId: string;
	readonly uploadId: string;
	readonly index: number;
	readonly total: number;
	/** Base64 text — a slice of the full encoded image, not independently re-encoded. */
	readonly chunk: string;
	/**
	 * The image's MIME type. Not part of the plan's literal message shape (which lists only
	 * `sessionId, uploadId, index, total, chunk`), but a `ChatImage` cannot be built without
	 * one — carried on whichever chunk(s) the sender includes it on (in practice chunk 0); the
	 * first non-empty value seen for an upload wins, and later chunks may omit it.
	 */
	readonly mimeType?: string;
}

/** A fully reassembled image, ready to attach to a session's pending images. */
export interface AssembledImage {
	readonly mimeType: string;
	/** Base64-encoded image data, without the `data:...;base64,` prefix. */
	readonly data: string;
}

/** Outcome of feeding one chunk into an {@link UploadAssembler}. */
export type AddChunkResult =
	| { readonly status: 'progress' }
	| { readonly status: 'complete'; readonly sessionId: string; readonly image: AssembledImage }
	| { readonly status: 'rejected'; readonly reason: string };

/** Per-upload byte ceiling: rejected (upload dropped), never silently truncated. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Per-session byte ceiling, counted cumulatively across every upload that session has ever completed or has in flight. */
export const MAX_SESSION_BYTES = 32 * 1024 * 1024;

/** Decoded byte length of a base64 string. Not required to be 4-aligned — good enough for cap enforcement, which does not need to be byte-exact. */
function decodedLength(base64: string): number {
	return Buffer.from(base64, 'base64').length;
}

interface UploadState {
	sessionId: string;
	mimeType?: string;
	total: number;
	chunks: Map<number, string>;
	receivedBytes: number;
}

/**
 * Tracks in-flight `attachImage` uploads and reassembles them once every chunk has arrived.
 * Chunks may arrive out of order — `index` is explicit on every chunk, so there is no need to
 * require strict ordering the way a plain stream would; `total` is what tells this class when
 * an upload is complete (`chunks.size === total`), not the arrival order.
 *
 * One instance is meant to live for the lifetime of the extension host's remote-control wiring
 * (see `chatViewProvider.ts`), shared across every connected remote sink and session — that is
 * what lets {@link MAX_SESSION_BYTES} actually bound a *session's* cumulative usage rather than
 * resetting per upload.
 */
export class UploadAssembler {
	private readonly uploads = new Map<string, UploadState>();
	/** sessionId -> cumulative accepted bytes, across every upload (completed or in-flight) this instance has ever admitted for that session. Never decremented on completion — it is a lifetime ceiling on attachment volume per session, not a watermark. */
	private readonly sessionBytes = new Map<string, number>();

	/** Feeds one chunk in. See {@link AddChunkResult} for the three outcomes. */
	addChunk(input: AttachImageChunk): AddChunkResult {
		const { sessionId, uploadId, index, total, chunk, mimeType } = input;
		if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(index) || index < 0 || index >= total) {
			this.dropUpload(uploadId);
			return { status: 'rejected', reason: `invalid chunk index ${index} of ${total}` };
		}
		let upload = this.uploads.get(uploadId);
		if (upload && upload.total !== total) {
			// A client that changes its mind about `total` mid-upload is either buggy or
			// malicious either way; reject the whole upload rather than guessing which chunk
			// count to trust.
			this.dropUpload(uploadId);
			return { status: 'rejected', reason: 'chunk total changed mid-upload' };
		}
		if (!upload) {
			upload = { sessionId, mimeType, total, chunks: new Map(), receivedBytes: 0 };
			this.uploads.set(uploadId, upload);
		} else if (mimeType && !upload.mimeType) {
			upload.mimeType = mimeType;
		}

		let newBytes: number;
		try {
			newBytes = decodedLength(chunk);
		} catch {
			this.dropUpload(uploadId);
			return { status: 'rejected', reason: 'malformed base64 chunk' };
		}
		// A resend of an already-received index must not be double-counted against either cap.
		const previousBytesForIndex = upload.chunks.has(index) ? decodedLength(upload.chunks.get(index) as string) : 0;
		const deltaBytes = newBytes - previousBytesForIndex;

		const newUploadBytes = upload.receivedBytes + deltaBytes;
		if (newUploadBytes > MAX_UPLOAD_BYTES) {
			this.dropUpload(uploadId);
			return { status: 'rejected', reason: `upload exceeds the ${MAX_UPLOAD_BYTES}-byte per-upload limit` };
		}
		const newSessionBytes = (this.sessionBytes.get(sessionId) ?? 0) + deltaBytes;
		if (newSessionBytes > MAX_SESSION_BYTES) {
			this.dropUpload(uploadId);
			return { status: 'rejected', reason: `session exceeds the ${MAX_SESSION_BYTES}-byte per-session limit` };
		}

		upload.chunks.set(index, chunk);
		upload.receivedBytes = newUploadBytes;
		this.sessionBytes.set(sessionId, newSessionBytes);

		if (upload.chunks.size < upload.total) {
			return { status: 'progress' };
		}

		let combined = '';
		for (let i = 0; i < upload.total; i++) {
			combined += upload.chunks.get(i);
		}
		this.uploads.delete(uploadId);
		return {
			status: 'complete',
			sessionId: upload.sessionId,
			image: { mimeType: upload.mimeType ?? 'image/jpeg', data: combined },
		};
	}

	/** Drops an upload (rejection or abandonment), rolling its bytes back out of the session's running total so a rejected upload cannot itself count toward the very cap that rejected it. */
	private dropUpload(uploadId: string): void {
		const upload = this.uploads.get(uploadId);
		if (!upload) {
			return;
		}
		const remaining = (this.sessionBytes.get(upload.sessionId) ?? 0) - upload.receivedBytes;
		this.sessionBytes.set(upload.sessionId, Math.max(0, remaining));
		this.uploads.delete(uploadId);
	}
}
