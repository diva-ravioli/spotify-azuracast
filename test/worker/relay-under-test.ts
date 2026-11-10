/**
 * The relay as deployed, but passing requests to a stand-in for Cloudflare's API
 * rather than the real one. Only the test journey in workerd uses this: the
 * deployed relay has no setting for where Cloudflare is.
 */
import { relay } from '../../relay/worker.ts'

export default {
  fetch: (request: Request, env: { UPSTREAM: string }) => relay(request, { upstream: env.UPSTREAM }),
}
