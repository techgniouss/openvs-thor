/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a turn that needs nothing from the workspace turned out to be.
 *
 * The distinction is not cosmetic. A greeting has no antecedent — nothing precedes it that
 * "yes" could refer to — so a run may answer it and stop. An acknowledgement ("ok",
 * "sounds good") very often means *proceed with what you just proposed*, so it may only be
 * used to withhold tools from a read-only answer, never to skip work the user may be
 * approving.
 */
export type SmallTalkKind = 'greeting' | 'acknowledgement';

/** Openers, sign-offs and questions about the assistant itself. No task can hide in one. */
const GREETINGS = new Set([
	'hi', 'hey', 'hello', 'hiya', 'yo', 'sup', 'howdy', 'greetings', 'morning',
	'good morning', 'good afternoon', 'good evening', 'good day', 'good night',
	// "later" is deliberately absent: as a sign-off it is rare in an editor, and as an
	// instruction ("later") it defers work — the one reading that must not skip a pipeline.
	'bye', 'goodbye', 'see ya', 'see you', 'gn',
	'how are you', 'how are you doing', 'how is it going', 'hows it going',
	'who are you', 'what is your name', 'whats your name',
	'what can you do', 'what do you do',
	'are you there', 'you there', 'are you working', 'still there',
]);

/** Thanks and approvals. Conversational, but one of them may be answering a question. */
const ACKNOWLEDGEMENTS = new Set([
	'thanks', 'thank you', 'thanks a lot', 'thank you very much', 'thx', 'ty', 'cheers',
	'appreciate it', 'much appreciated',
	'ok', 'okay', 'k', 'cool', 'nice', 'great', 'awesome', 'perfect', 'excellent',
	'got it', 'understood', 'sounds good', 'makes sense', 'fair enough',
	'no worries', 'no problem', 'np', 'never mind', 'nevermind', 'nvm',
]);

/** Vocatives and politeness that may trail any of the above without changing it. */
const FILLERS = new Set(['there', 'thor', 'again', 'buddy', 'mate', 'man', 'friend', 'please', 'sir', 'all', 'so much', 'a lot', 'very much']);

/** Longest phrase in any of the sets, in words — how far ahead the matcher has to look. */
const MAX_PHRASE_WORDS = 4;

/**
 * Beyond this many characters a message is doing something, whatever words it uses. A
 * cheap bound so the matcher never walks a wall of text.
 */
const MAX_LENGTH = 64;

/** Strips a turn down to comparable words: lower case, no quotes, punctuation or emoji. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[’‘'`]/g, '')
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Which set a phrase belongs to, or undefined.
 *
 * A phrase that matches nothing is retried with its repeated letters squeezed out, so
 * "hii", "heyyy" and "kk" are the words they obviously are. Only as a fallback: squeezing
 * first would turn "all" into "al" and lose phrases that were already exact.
 */
function classify(phrase: string): SmallTalkKind | 'filler' | undefined {
	for (const candidate of [phrase, phrase.replace(/([a-z])\1+/g, '$1')]) {
		if (GREETINGS.has(candidate)) {
			return 'greeting';
		}
		if (ACKNOWLEDGEMENTS.has(candidate)) {
			return 'acknowledgement';
		}
		if (FILLERS.has(candidate)) {
			return 'filler';
		}
	}
	return undefined;
}

/**
 * Classifies a user turn that is pure conversation — a greeting, a thank-you, a question
 * about the assistant itself — and returns undefined for anything that could be a request.
 *
 * The point is what it lets a caller *skip*: attaching the read-only tool loop to "hi"
 * lets a model spend a step listing the workspace before saying hello, and running the
 * Auto plan → implement → review pipeline over it costs three model calls to greet
 * someone. Both then read as the chat having done something strange.
 *
 * Every word of the message must be accounted for by a known phrase, so the answer is no
 * for anything with real content in it — "fix the login bug" fails on its first word.
 * That asymmetry is deliberate: a missed greeting costs what it has always cost, while a
 * request mistaken for chat would silently do none of the work asked for.
 */
export function smallTalkKind(text: string): SmallTalkKind | undefined {
	if (text.length > MAX_LENGTH) {
		return undefined;
	}
	const words = normalize(text).split(' ').filter(Boolean);
	if (!words.length) {
		return undefined;
	}
	let kind: SmallTalkKind | undefined;
	for (let i = 0; i < words.length;) {
		// Longest phrase first: "thank you" must not be read as "thank" + "you", and
		// "good morning" is a greeting where "good" alone is nothing.
		let matched = 0;
		for (let len = Math.min(MAX_PHRASE_WORDS, words.length - i); len > 0 && !matched; len--) {
			const found = classify(words.slice(i, i + len).join(' '));
			if (!found) {
				continue;
			}
			matched = len;
			if (found === 'greeting') {
				// A greeting anywhere decides the turn: "thanks, bye" needs no approval reading.
				kind = 'greeting';
			} else if (found === 'acknowledgement') {
				kind ??= 'acknowledgement';
			}
		}
		if (!matched) {
			return undefined;
		}
		i += matched;
	}
	// Filler alone ("please", "again") is a fragment of a request, not a turn of its own.
	return kind;
}
