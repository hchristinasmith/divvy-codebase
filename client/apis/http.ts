// The fetch helpers every client API module shares. A refused request rejects
// with an Error whose message is the server's own `{ error }` text, its status
// when it sent none, or that it could not be reached. A 200 that is not JSON
// (a proxy's HTML page) rejects with a fixed message, so the parser's
// SyntaxError, which quotes the body, never reaches the screen.

const rootURL = new URL('/api/v1', document.baseURI)

const UNREADABLE = 'The server sent a reply Divvy could not read'

/** The checked response, for a caller that does not read a body (DELETE is 204). */
export async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${rootURL}${path}`, init)
  } catch {
    throw new Error('The server could not be reached')
  }
  if (!response.ok) {
    let message: unknown
    try {
      message = ((await response.json()) as { error?: unknown }).error
    } catch {
      message = undefined
    }
    if (typeof message === 'string') throw new Error(message)
    throw new Error(`Server error (${response.status})`)
  }
  return response
}

/** `request`, then the body parsed as JSON. */
export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init)
  try {
    return (await response.json()) as T
  } catch {
    throw new Error(UNREADABLE)
  }
}
