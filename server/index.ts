import server from './server.ts'
import { syncScheduler } from './sync/scheduler.ts'

const port = process.env.PORT || 3005

server.listen(port, function () {
  // eslint-disable-next-line no-console
  console.log('Listening on port', port)
  // The one place the scheduler starts (prd-01 Ruling 6, #27): importing
  // server.ts, as the tests do, starts no timer.
  syncScheduler.start()
})
