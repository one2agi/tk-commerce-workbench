// Re-export everything tests across lanes need without dragging in @tk/adapters.
export * from "./fake-ports.js";
export type {
  IdempotencyKey,
  SourceItemId,
  MiaoshouDetailId,
  AssetId,
  ProductId,
  ProductRevisionId
} from "../ids.js";
export type {
  ApprovalSnapshotV1,
  ProductWorkspaceV1,
  ProductPoolItemV1,
  TaskCenterItemV1,
  ApprovalPreviewV1,
  MiaoshouSyncStatusV1,
  WorkspaceSettingsViewV1,
  TemplateV1,
  Locale
} from "../read-models.js";
export type {
  MoneyWire,
  MoneyCurrency,
  WeightKg,
  DimensionsCm,
  ExchangeRateSnapshotWire
} from "../quantities.js";
export type {
  AutomationState,
  CanvasState,
  MiaoshouEditState,
  MiaoshouSourceState,
  ApprovalState,
  ListingState,
  AssetArchiveState,
  CollectionState,
  JobStatus,
  ExchangeRateState
} from "../states.js";
export type { ExternalFailure, ExternalFailureKind, CollectionWarningCode } from "../errors.js";
export { CollectionWarningCodes, externalFailure } from "../errors.js";
export type {
  MiaoshouSourcePort,
  MiaoshouEditPort,
  CanvasPort,
  LlmPort,
  ExchangeRatePort,
  AssetStagingPort,
  MiaoshouCollectedDetail,
  MiaoshouEditApplyResult,
  MiaoshouEditFieldError,
  StagedAsset
} from "../ports.js";
