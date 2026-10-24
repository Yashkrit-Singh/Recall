import { createReadStream } from 'node:fs'

/** Bridge a local file stream to a Web stream while respecting response cancellation. */
export function createFileWebStream(filePath, options = {}) {
  const fileStream = createReadStream(filePath, options)
  const iterator = fileStream[Symbol.asyncIterator]()
  let cancelled = false
  let finished = false

  return new ReadableStream({
    async pull(controller) {
      if (cancelled || finished) return
      try {
        const result = await iterator.next()
        if (cancelled) return
        if (result.done) {
          finished = true
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(result.value))
      } catch (error) {
        if (cancelled || finished) return
        finished = true
        controller.error(error)
      }
    },
    cancel() {
      cancelled = true
      finished = true
      fileStream.destroy()
    },
  })
}
