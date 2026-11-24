// The deadline on a Groq transcription, shared by main (which aborts the request) and the renderer
// (whose IPC call gives up a little later, in case main never answers at all). Constants only.

/** How long one Groq transcription may take, from sending the audio to reading the whole reply. */
export const GROQ_DEADLINE_MS = 30_000

/** What a transcription that ran past the deadline says. Pending David's sign-off. */
export const GROQ_TIMEOUT_MESSAGE = 'Groq took too long to reply. Try again.'
