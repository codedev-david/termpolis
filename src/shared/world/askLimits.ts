// Lumopolis: the one limit on a question (or a design change) typed into the ask bar, shared by the
// field (WorldAsk), main's check of the request (ipc.ts) and the prompt builder (askContext.ts), so a
// question the field takes is never refused or cut short further down.

/** The most characters one question, or one design change, may hold once cleaned. */
export const MAX_QUESTION_CHARS = 4000

// C0 controls but tab, DEL and the C1 controls. Newlines go too: the field is one line.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g

/** The question with control characters (all but tab) taken out and the ends trimmed. */
export const cleanQuestion = (raw: string): string => raw.replace(CONTROL, '').trim()

/** True for a cleaned question that is not blank and fits the limit. */
export const questionFits = (cleaned: string): boolean => cleaned !== '' && cleaned.length <= MAX_QUESTION_CHARS
