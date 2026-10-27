import server from './server.ts'
import { syncScheduler } from './sync/scheduler.ts'

const port = process.env.PORT || 3005
// Loopback unless HOST says otherwise: tailnet-only with no app auth (D4), so never the LAN by default (#149). Production sets no HOST: `scripts/start.sh` refuses to boot with any value but blank or `127.0.0.1` (#22).
// `||`, not `??`: .env.example ships `HOST=`, and listen(port, '') binds every interface.
const host = process.env.HOST || '127.0.0.1'

server.listen(Number(port), host, function () {
  // eslint-disable-next-line no-console
  console.log('Listening on', host + ':' + port)
  // The one place the scheduler starts (prd-01 Ruling 6, #27): importing
  // server.ts, as the tests do, starts no timer.
  syncScheduler.start()
})
