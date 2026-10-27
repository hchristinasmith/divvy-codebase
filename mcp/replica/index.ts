// The replica module the MCP context wires in (prd-03 Ruling 2): exactly the
// `ReplicaModule` shape from `../contracts.ts`. It exports the reader only;
// the refresh and the scrub are a separate process (`refresh-cli.ts`) and are
// not reachable from here.

import type { OpenReplica } from '../contracts.ts'
import { createReplicaReader } from './reader.ts'

/** Opens nothing: each `meta` or `select` call opens and closes the replica itself. */
export const openReplica: OpenReplica = ({ path }) => createReplicaReader(path)
