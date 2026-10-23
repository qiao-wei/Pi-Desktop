/**
 * Protocol module - the declared boundaries of Pi Desktop.
 *
 * Everything a boundary needs to be *replaceable*: what crosses it, which revision it is, and
 * how to swap one side. Read `docs/architecture/protocols.md` first; this module is the code
 * half of that document, and the two are pinned together by `npm test`.
 */

export {
  PROTOCOL_VERSION,
  checkProtocolCompatibility,
  protocolMismatch,
  protocolMismatchMessage,
  type AnnouncedProtocolVersion,
  type ProtocolCompatibility,
  type ProtocolMismatch,
} from "./version.ts";

export {
  HOST_COMMANDS,
  HOST_COMMAND_IDS,
  isHostCommandId,
  type HostCommandArgs,
  type HostCommandId,
  type HostCommandSpec,
  type HostShell,
} from "./hostCommands.ts";

export {
  BRIDGE_ENDPOINTS,
  BRIDGE_ENDPOINT_IDS,
  BRIDGE_ENDPOINTS_BY_PATH,
  BRIDGE_SURFACE_ARTIFACT,
  type BridgeEndpointContract,
  type BridgeEndpointId,
  type BridgeEndpointTransport,
  type BridgeHandshake,
} from "./bridgeEndpoints.ts";
export {
  STORAGE_MIGRATIONS,
  STORAGE_SCHEMA_VERSION,
  STORAGE_VERSION_KEY,
  checkStorageVersion,
  migrateStorage,
  storageMismatchMessage,
  type KeyValueStorePort,
  type StorageMigration,
  type StorageVersionStatus,
} from "./storage.ts";

export { type PerfPort } from "./perf.ts";

export { PROTOCOL_SEAMS, PROTOCOL_SEAM_IDS, type ProtocolSeam } from "./seams.ts";
