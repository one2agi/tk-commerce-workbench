import type { WorkspaceSettingsViewV1 } from "@tk/contracts/read-models";

type SettingsInput = WorkspaceSettingsViewV1;

export class SettingsService {
  private readonly view: WorkspaceSettingsViewV1;

  constructor(input: SettingsInput) {
    this.view = Object.freeze({
      ...input,
      secretStatus: Object.freeze({ ...input.secretStatus })
    });
  }

  get(): WorkspaceSettingsViewV1 {
    return this.view;
  }
}
