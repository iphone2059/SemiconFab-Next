// R9 negative fixture: only the acceptance capability group may stay optional on ScenePort.
export interface SceneCommands {
  setView(preset: string): void;
}
export interface ScenePort extends SceneCommands {
  readonly acceptance?: { forceDeviceLoss(): void };
  readonly resize?: () => void;
  mount(): void;
  dispose(): void;
}
