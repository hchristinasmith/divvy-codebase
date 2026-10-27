import server from './server.ts'
import { syncScheduler } from './sync/scheduler.ts'
import { agentScheduler } from './agents/scheduler.ts'

const port = process.env.PORT || 3005
// Loopback unless HOST says otherwise: tailnet-only with no app auth (D4), so never the LAN by default (#149). Production sets no HOST: `scripts/start.sh` refuses to boot with any value but blank or `127.0.0.1` (#22).
// `||`, not `??`: .env.example ships `HOST=`, and listen(port, '') binds every interface.
const host = process.env.HOST || '127.0.0.1'

const httpServer = server.listen(Number(port), host, function () {
  // eslint-disable-next-line no-console
  console.log('Listening on', host + ':' + port)
  // The one place the scheduler starts (prd-01 Ruling 6, #27): importing
  // server.ts, as the tests do, starts no timer.
  syncScheduler.start()
  // The agent scheduler starts here too (prd-04, #58), for the same reason.
  agentScheduler.start()
})

// Shutdown on SIGTERM or SIGINT (#454). The schedulers stop taking new passes,
// a pass in flight finishes so its agent_runs row closes as success or failed
// rather than staying 'running' until the next boot, then the socket closes and
// the process exits. The drain is bounded: fly.toml's kill_timeout is 30s, so
// 20s leaves room to close before SIGKILL.
const DRAIN_TIMEOUT_MS = 20_000
let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  // eslint-disable-next-line no-console
  console.log('Shutting down')
  syncScheduler.stop()
  agentScheduler.stop()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)
    timer.unref()
  })
  const drained = Promise.all([syncScheduler.whenIdle(), agentScheduler.whenIdle()]).then(
    () => 'drained' as const,
  )
  void Promise.race([drained, timedOut]).then((outcome) => {
    clearTimeout(timer)
    httpServer.close(() => process.exit(0))
    if (outcome === 'timeout') {
      // eslint-disable-next-line no-console
      console.log('Shutdown drain timed out; closing with a pass still running')
      // close() waits for requests in flight, and a manual POST
      // /api/v1/agents/run waits on the stuck pass, so without this the close
      // never ends and Fly's SIGKILL does it instead.
      httpServer.closeAllConnections()
    }
  })
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
